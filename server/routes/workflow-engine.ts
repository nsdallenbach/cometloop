import { AsyncLocalStorage } from 'node:async_hooks';
import { conditionOutcomes, parseChoices, summarizeNode, withDefaults, type NodeKind } from '../../shared/workflows/catalog';
import { createNotification } from './notifications';
import { businessDaysBetween } from './stale-nudges';
import { recordTicketEvent } from './ticket-events';
import { decide as decideDefault, type DecideProvider, type Decision } from './workflow-decide';
import type { WorkflowGraph, WorkflowNode } from './workflows';

/**
 * The workflow engine: events in, runs out.
 *
 * Where events come from. The places that already know something happened
 * — a ticket's status trail, the comment route, the repo sync, the agent
 * completion route, the deploy recorder — call `emitWorkflowEvent` with the
 * event kind and what they have (a ticket key and the specifics). The call
 * is fire-and-forget and never throws: a workflow must not be able to break
 * the action that triggered it. Time-based triggers (schedules, idle
 * tickets) come from `startWorkflowScheduler`, one sweep a minute per tenant.
 *
 * What a run is. For every enabled workflow with a trigger node that matches
 * the event, the engine walks the graph from that node: actions do their
 * thing, agent steps queue the ticket, conditions pick an outcome and only
 * the connections carrying that label (or none) are followed. Each step is
 * recorded with its result; the run row in `app.workflow_runs` is what the
 * Workflows page lists. A failed step fails the run and stops the walk; a
 * node fed by two branches runs when first reached.
 *
 * Loops. An action that moves a ticket emits `ticket.moved`, which may match
 * another workflow (or the same one). Runs started from inside a run carry a
 * depth, and the engine refuses past `MAX_DEPTH` — a workflow can chain, not
 * spin.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const WORKFLOW_RUNS_SCHEMA_SQL = [
  `ALTER TABLE app.workflows ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE app.workflows ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS app.workflow_runs (
    id BIGSERIAL PRIMARY KEY,
    workflow_id INT NOT NULL REFERENCES app.workflows(id) ON DELETE CASCADE,
    workflow_name TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'running',
    error TEXT NOT NULL DEFAULT '',
    payload JSONB NOT NULL DEFAULT '{}',
    steps JSONB NOT NULL DEFAULT '[]',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_workflow_started ON app.workflow_runs (workflow_id, started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS workflow_runs_started ON app.workflow_runs (started_at DESC)`,
  // One row per (workflow, trigger node, subject): when a schedule last
  // fired, which quiet periods an idle trigger has already seen.
  `CREATE TABLE IF NOT EXISTS app.workflow_trigger_state (
    workflow_id INT NOT NULL REFERENCES app.workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    last_fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workflow_id, node_id, subject)
  )`,
];

export const MAX_DEPTH = 3;
export const RUN_STATES = ['running', 'succeeded', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface WorkflowEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export interface RunStep {
  nodeId: string;
  kind: NodeKind;
  type: string;
  title: string;
  state: 'ok' | 'failed';
  /** A condition's outcome, a decision's choice. */
  outcome?: string;
  /** What happened, in words — the detail column of the run view. */
  detail: string;
  startedAt: string;
  ms: number;
}

export interface RunResult {
  id: number;
  state: RunState;
  steps: RunStep[];
  error: string;
}

export interface EngineDeps {
  now: () => number;
  decide: typeof decideDefault;
  fetch: typeof fetch;
}

export const defaultEngineDeps = (): EngineDeps => ({ now: () => Date.now(), decide: decideDefault, fetch: (i, o) => fetch(i, o) });

const depth = new AsyncLocalStorage<number>();
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

// ---------------------------------------------------------------------------
// Payloads, paths, templates

export interface TicketPayload {
  key: string;
  title: string;
  status: string;
  assignee: string;
  engagementId: string;
  description: string;
  tags: string[];
}

/** The ticket part of every ticket-borne event, from the row. */
export function ticketPayloadFromRow(r: Record<string, unknown>): TicketPayload {
  let tags: unknown = r.tags;
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags);
    } catch {
      tags = [];
    }
  }
  return {
    key: str(r.key),
    title: str(r.title),
    status: str(r.status),
    assignee: str(r.assignee),
    engagementId: str(r.engagement_id),
    description: str(r.description),
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
  };
}

export async function loadTicketPayload(q: Query, key: string): Promise<TicketPayload | null> {
  const row = (await q('SELECT key, title, status, assignee, engagement_id, description, tags FROM app.tickets WHERE key = $1', [key])).rows[0];
  return row ? ticketPayloadFromRow(row) : null;
}

/** `a.b.c` into a payload; arrays by index; missing → undefined. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.').map((p) => p.trim()).filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const asText = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : Array.isArray(v) ? v.map(asText).join(', ') : JSON.stringify(v);

/** `{{ticket.key}}` → the payload's value; unknown paths render empty. */
export function render(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => asText(getPath(payload, path)));
}

// ---------------------------------------------------------------------------
// Triggers

type Config = Record<string, string | number>;

/** Whether a trigger node wants this event — same kind, and every filter it sets holds. */
export function triggerMatches(node: WorkflowNode, event: WorkflowEvent): boolean {
  if (node.kind !== 'trigger' || node.type !== event.kind) return false;
  const c = withDefaults('trigger', node.type, node.config);
  const p = event.payload;
  const project = str(c.project).trim();
  if (project && str(getPath(p, 'ticket.engagementId')) !== project) return false;
  switch (node.type) {
    case 'ticket.moved':
      if (str(c.to) && str(getPath(p, 'move.to')) !== str(c.to)) return false;
      if (str(c.from) && str(getPath(p, 'move.from')) !== str(c.from)) return false;
      return true;
    case 'comment.added': {
      const needle = str(c.contains).trim().toLowerCase();
      return !needle || str(getPath(p, 'comment.body')).toLowerCase().includes(needle);
    }
    case 'deploy.finished':
      return !str(c.result) || str(getPath(p, 'deploy.result')) === str(c.result);
    case 'agent.completed':
      return !str(c.outcome) || str(getPath(p, 'run.outcome')) === str(c.outcome);
    case 'ticket.idle':
      return !str(c.status) || str(getPath(p, 'ticket.status')) === str(c.status);
    default:
      return true;
  }
}

const HOUR = 3_600_000;

/**
 * Whether a schedule trigger is due. Hourly: an hour since it last fired.
 * Daily / weekday / weekly: the UTC clock has passed `at` today, today is an
 * allowed day, and it has not fired today yet.
 */
export function scheduleDue(config: Config, lastFiredMs: number | null, nowMs: number): boolean {
  const c = withDefaults('trigger', 'schedule', config);
  if (c.every === 'hour') return lastFiredMs === null || nowMs - lastFiredMs >= HOUR - 30_000;
  const m = /^(\d{2}):(\d{2})$/.exec(str(c.at));
  if (!m) return false;
  const now = new Date(nowMs);
  const day = now.getUTCDay();
  if (c.every === 'weekday' && (day === 0 || day === 6)) return false;
  if (c.every === 'week' && day !== 1) return false;
  const dueAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]), Number(m[2]));
  if (nowMs < dueAt) return false;
  return lastFiredMs === null || lastFiredMs < dueAt;
}

// ---------------------------------------------------------------------------
// Conditions

export function evalRule(config: Config, payload: Record<string, unknown>): { outcome: 'yes' | 'no'; detail: string } {
  const field = str(config.field).trim();
  const op = str(config.op) || 'equals';
  const want = render(str(config.value), payload);
  const raw = getPath(payload, field);
  const have = asText(raw);
  const lhs = have.toLowerCase();
  const rhs = want.toLowerCase();
  let ok: boolean;
  switch (op) {
    case 'not-equals':
      ok = lhs !== rhs;
      break;
    case 'contains':
      ok = lhs.includes(rhs);
      break;
    case 'not-contains':
      ok = !lhs.includes(rhs);
      break;
    case 'greater':
      ok = Number(have) > Number(want);
      break;
    case 'less':
      ok = Number(have) < Number(want);
      break;
    case 'exists':
      ok = raw !== undefined && raw !== null && have !== '';
      break;
    case 'empty':
      ok = raw === undefined || raw === null || have === '';
      break;
    default:
      ok = lhs === rhs;
  }
  const shown = have.length > 60 ? `${have.slice(0, 57)}…` : have;
  return { outcome: ok ? 'yes' : 'no', detail: `${field} = “${shown}” → ${op}${['exists', 'empty'].includes(op) ? '' : ` “${want}”`} is ${ok ? 'yes' : 'no'}` };
}

// ---------------------------------------------------------------------------
// The walk

interface StepOutcome {
  ok: boolean;
  outcome?: string;
  detail: string;
}

interface RunContext {
  q: Query;
  deps: EngineDeps;
  workflow: { id: number; name: string };
  payload: Record<string, unknown>;
}

const author = (ctx: RunContext) => `Workflow · ${ctx.workflow.name}`;

async function ticketOf(ctx: RunContext): Promise<TicketPayload | null> {
  const key = str(getPath(ctx.payload, 'ticket.key'));
  if (!key) return null;
  // Re-read: an earlier step may have moved or re-assigned it.
  return loadTicketPayload(ctx.q, key);
}

async function runAction(node: WorkflowNode, ctx: RunContext): Promise<StepOutcome> {
  const c = withDefaults('action', node.type, node.config);
  const { q, payload } = ctx;
  const needTicket = async () => {
    const t = await ticketOf(ctx);
    if (!t) throw new Error('this event carries no ticket');
    return t;
  };
  switch (node.type) {
    case 'ticket.move': {
      const t = await needTicket();
      const status = str(c.status);
      if (t.status === status) return { ok: true, detail: `${t.key} is already in ${status}` };
      // The same two writes as setTicketStatus, kept as plain statements so
      // the trail (and the ticket.moved event it emits) follows.
      const moved = (await q(`UPDATE app.tickets SET status = $2, done_at = CASE WHEN $2 = 'done' THEN COALESCE(done_at, NOW()) END WHERE key = $1 RETURNING key`, [t.key, status])).rows.length > 0;
      if (moved) await recordTicketEvent(q, t.key, t.engagementId, t.status, status);
      return { ok: moved, detail: moved ? `${t.key}: ${t.status} → ${status}` : `${t.key} could not be moved` };
    }
    case 'ticket.comment': {
      const t = await needTicket();
      const body = render(str(c.body), payload).trim();
      if (!body) throw new Error('the comment rendered empty');
      await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [t.key, author(ctx), body]);
      return { ok: true, detail: `commented on ${t.key}: ${body.length > 80 ? `${body.slice(0, 77)}…` : body}` };
    }
    case 'ticket.assign': {
      const t = await needTicket();
      const assignee = render(str(c.assignee), payload).trim();
      if (!assignee) throw new Error('the assignee rendered empty');
      await q('UPDATE app.tickets SET assignee = $2 WHERE key = $1', [t.key, assignee]);
      return { ok: true, detail: `${t.key} assigned to ${assignee}` };
    }
    case 'ticket.tag': {
      const t = await needTicket();
      const tag = render(str(c.tag), payload).trim();
      if (!tag) throw new Error('the tag rendered empty');
      if (t.tags.includes(tag)) return { ok: true, detail: `${t.key} already tagged ${tag}` };
      await q('UPDATE app.tickets SET tags = $2::jsonb WHERE key = $1', [t.key, JSON.stringify([...t.tags, tag])]);
      return { ok: true, detail: `${t.key} tagged ${tag}` };
    }
    case 'notify': {
      const to = render(str(c.to), payload).trim().toLowerCase();
      if (!to.includes('@')) throw new Error(`“${to || 'nobody'}” is not an email address`);
      const title = render(str(c.title), payload).trim() || `Workflow ${ctx.workflow.name}`;
      const t = await ticketOf(ctx);
      const row = await createNotification(q, {
        recipient: to,
        type: 'workflow',
        title,
        message: render(str(c.message), payload).trim(),
        ticketKey: t?.key,
        engagementId: t?.engagementId,
      });
      return { ok: row !== null, detail: row ? `notified ${to}: ${title}` : `${to} is not a notifiable recipient` };
    }
    case 'feed': {
      const t = await needTicket();
      const text = render(str(c.text), payload).trim();
      if (!text) throw new Error('the text rendered empty');
      await q(`INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible) VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`, [t.engagementId, text]);
      return { ok: true, detail: `posted to ${t.engagementId}: ${text.length > 80 ? `${text.slice(0, 77)}…` : text}` };
    }
    case 'webhook': {
      const url = str(c.url).trim();
      const bodyTemplate = str(c.body).trim();
      const body = bodyTemplate ? render(bodyTemplate, payload) : JSON.stringify({ workflow: ctx.workflow.name, ...payload });
      const resp = await ctx.deps.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) throw new Error(`${url} answered ${resp.status}`);
      return { ok: true, detail: `POST ${url} → ${resp.status}` };
    }
    default:
      throw new Error(`unknown action ${node.type}`);
  }
}

async function runAgent(node: WorkflowNode, ctx: RunContext): Promise<StepOutcome> {
  const c = withDefaults('agent', node.type, node.config);
  const { q, payload } = ctx;
  const t = await ticketOf(ctx);
  if (!t) throw new Error('this event carries no ticket');
  if (!['backlog', 'progress', 'review'].includes(t.status)) throw new Error(`${t.key} is ${t.status}; only backlog, in-progress or review tickets can be queued`);
  const active = (await q(`SELECT id, agent FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`, [t.key])).rows[0];
  if (active) return { ok: true, detail: `${t.key} already has an active run (task ${str(active.id)}${active.agent ? ` on ${str(active.agent)}` : ''})` };
  const assignee = render(str(c.assignee), payload).trim().toLowerCase() || null;
  const inserted = (
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority, instructions, queued_by, assignee) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
      t.key,
      t.engagementId,
      Math.max(0, Math.min(10, Math.round(num(c.priority)))),
      render(str(c.instructions), payload).trim(),
      author(ctx),
      assignee,
    ])
  ).rows[0];
  await q(`INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible) VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`, [
    t.engagementId,
    `Workflow “${ctx.workflow.name}” queued ${t.key} for agent work${assignee ? ` (routed to ${assignee})` : ''}.`,
  ]);
  return { ok: true, detail: `queued ${t.key} as task ${str(inserted?.id)}${assignee ? ` for ${assignee}` : ''}` };
}

async function runCondition(node: WorkflowNode, ctx: RunContext): Promise<StepOutcome> {
  const c = withDefaults('condition', node.type, node.config);
  if (node.type === 'rule') {
    const r = evalRule(c, ctx.payload);
    return { ok: true, outcome: r.outcome, detail: r.detail };
  }
  if (node.type === 'decide') {
    const choices = parseChoices(c.choices);
    const stateTemplate = str(c.state).trim();
    const state = stateTemplate ? render(stateTemplate, ctx.payload) : ctx.payload;
    const d: Decision = await ctx.deps.decide({ state, question: str(c.question), choices, provider: (str(c.provider) || 'auto') as DecideProvider });
    const probs = Object.entries(d.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
      .join(', ');
    return {
      ok: true,
      outcome: d.choice,
      detail: `${d.provider === 'fallback' ? 'FALLBACK' : d.provider} chose ${d.choice} (confidence ${Math.round(d.confidence * 100)}%${probs ? `; ${probs}` : ''})${d.notes.length ? ` — ${d.notes.join('; ')}` : ''}`,
    };
  }
  throw new Error(`unknown condition ${node.type}`);
}

async function runStep(node: WorkflowNode, ctx: RunContext): Promise<StepOutcome> {
  switch (node.kind) {
    case 'trigger':
      return { ok: true, detail: summarizeNode('trigger', node.type, node.config) };
    case 'condition':
      return runCondition(node, ctx);
    case 'action':
      return runAction(node, ctx);
    case 'agent':
      return runAgent(node, ctx);
  }
}

/** The connections to follow out of a node after its step: all of them, or for a condition those labelled with the outcome (or unlabelled). */
export function nextNodes(graph: WorkflowGraph, nodeId: string, outcome: string | undefined): string[] {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const out = graph.edges.filter((e) => e.from === nodeId);
  if (node?.kind !== 'condition') return out.map((e) => e.to);
  const want = (outcome ?? '').trim().toLowerCase();
  return out.filter((e) => !e.label?.trim() || e.label.trim().toLowerCase() === want).map((e) => e.to);
}

export interface RunnableWorkflow {
  id: number;
  name: string;
  graph: WorkflowGraph;
}

/**
 * Run one workflow from one trigger node with an event's payload, recording
 * the run as it goes. Never throws: a failure is a failed run.
 */
export async function runWorkflow(q: Query, wf: RunnableWorkflow, triggerNodeId: string, event: WorkflowEvent, deps: EngineDeps = defaultEngineDeps()): Promise<RunResult> {
  const payload: Record<string, unknown> = { ...event.payload, workflow: { id: wf.id, name: wf.name } };
  const subject = str(getPath(payload, 'ticket.key'));
  const inserted = (
    await q(`INSERT INTO app.workflow_runs (workflow_id, workflow_name, trigger, subject, payload) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
      wf.id,
      wf.name,
      event.kind,
      subject,
      JSON.stringify(payload),
    ])
  ).rows[0];
  const runId = num(inserted?.id);
  const ctx: RunContext = { q, deps, workflow: { id: wf.id, name: wf.name }, payload };
  const steps: RunStep[] = [];
  let state: RunState = 'succeeded';
  let error = '';
  const byId = new Map(wf.graph.nodes.map((n) => [n.id, n]));
  const queue = [triggerNodeId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    const t0 = deps.now();
    let result: StepOutcome;
    try {
      result = await depth.run((depth.getStore() ?? 0) + 1, () => runStep(node, ctx));
    } catch (err) {
      result = { ok: false, detail: (err as Error).message };
    }
    steps.push({ nodeId: node.id, kind: node.kind, type: node.type, title: node.title, state: result.ok ? 'ok' : 'failed', outcome: result.outcome, detail: result.detail, startedAt: new Date(t0).toISOString(), ms: Math.max(0, deps.now() - t0) });
    if (!result.ok) {
      state = 'failed';
      error = `${node.title || node.type}: ${result.detail}`;
      break;
    }
    queue.push(...nextNodes(wf.graph, node.id, result.outcome));
  }
  await q(`UPDATE app.workflow_runs SET state = $2, error = $3, steps = $4, finished_at = NOW() WHERE id = $1`, [runId, state, error, JSON.stringify(steps)]);
  console.log(`[workflows] "${wf.name}" ${state} on ${event.kind}${subject ? ` (${subject})` : ''}: ${steps.length} step(s)${error ? ` — ${error}` : ''}`);
  return { id: runId, state, steps, error };
}

function graphFrom(v: unknown): WorkflowGraph {
  let raw: unknown = v;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const g = raw as { nodes?: unknown; edges?: unknown } | null;
  const nodes = Array.isArray(g?.nodes) ? (g.nodes as WorkflowNode[]) : [];
  const edges = Array.isArray(g?.edges) ? (g.edges as WorkflowGraph['edges']) : [];
  return { nodes: nodes.map((n) => ({ ...n, type: str(n.type), config: n.config && typeof n.config === 'object' ? n.config : {} })), edges };
}

export async function loadEnabledWorkflows(q: Query): Promise<RunnableWorkflow[]> {
  const rows = (await q('SELECT id, name, graph FROM app.workflows WHERE enabled = true ORDER BY id')).rows;
  return rows.map((r) => ({ id: num(r.id), name: str(r.name), graph: graphFrom(r.graph) }));
}

/** Run every enabled workflow whose trigger matches the event. Returns the runs. */
export async function fireWorkflowEvent(q: Query, event: WorkflowEvent, deps: EngineDeps = defaultEngineDeps()): Promise<RunResult[]> {
  const level = depth.getStore() ?? 0;
  if (level >= MAX_DEPTH) {
    console.warn(`[workflows] ${event.kind} ignored: ${level} workflows deep already`);
    return [];
  }
  const results: RunResult[] = [];
  for (const wf of await loadEnabledWorkflows(q)) {
    for (const node of wf.graph.nodes) {
      if (!triggerMatches(node, event)) continue;
      results.push(await runWorkflow(q, wf, node.id, event, deps));
    }
  }
  return results;
}

/**
 * The hook the rest of the server calls. Loads the ticket when a key is
 * given, fires, and swallows everything: nothing here may surface in the
 * caller's request.
 */
export function emitWorkflowEvent(q: Query, kind: string, input: { ticketKey?: string; ticket?: TicketPayload } & Record<string, unknown>): void {
  const { ticketKey, ticket, ...rest } = input;
  void (async () => {
    const payload: Record<string, unknown> = { ...rest };
    const t = ticket ?? (ticketKey ? await loadTicketPayload(q, ticketKey) : null);
    if (t) payload.ticket = t;
    await fireWorkflowEvent(q, { kind, payload });
  })().catch((err: unknown) => console.warn(`[workflows] ${kind} failed:`, (err as Error).message));
}

// ---------------------------------------------------------------------------
// Time-based triggers

const IDLE_DEFAULT_STATUSES = ['progress', 'review'];
const CONSOLE_AUTHOR = 'Delivery Console';

/** One sweep: fire due schedules and newly idle tickets. Returns the runs. */
export async function sweepTimedTriggers(q: Query, deps: EngineDeps = defaultEngineDeps()): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const workflows = await loadEnabledWorkflows(q);
  const timed = workflows.flatMap((wf) => wf.graph.nodes.filter((n) => n.kind === 'trigger' && (n.type === 'schedule' || n.type === 'ticket.idle')).map((node) => ({ wf, node })));
  if (timed.length === 0) return results;
  const nowMs = deps.now();
  const state = new Map<string, number>();
  for (const r of (await q('SELECT workflow_id, node_id, subject, last_fired_at FROM app.workflow_trigger_state')).rows) {
    const ms = Date.parse(str(r.last_fired_at instanceof Date ? r.last_fired_at.toISOString() : r.last_fired_at));
    if (Number.isFinite(ms)) state.set(`${num(r.workflow_id)}|${str(r.node_id)}|${str(r.subject)}`, ms);
  }
  const claim = (wfId: number, nodeId: string, subject: string) =>
    q(
      `INSERT INTO app.workflow_trigger_state (workflow_id, node_id, subject, last_fired_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (workflow_id, node_id, subject) DO UPDATE SET last_fired_at = EXCLUDED.last_fired_at`,
      [wfId, nodeId, subject, new Date(nowMs).toISOString()],
    );

  let idle: { ticket: TicketPayload; lastActivityMs: number }[] | null = null;
  const loadIdle = async () => {
    if (idle) return idle;
    const tickets = (await q(`SELECT key, title, status, assignee, engagement_id, description, tags FROM app.tickets WHERE status IN ('backlog','progress','review','deploying') ORDER BY key`)).rows.map(ticketPayloadFromRow);
    const last = new Map<string, number>();
    const note = (key: string, v: unknown) => {
      const ms = Date.parse(v instanceof Date ? v.toISOString() : str(v));
      if (Number.isFinite(ms)) last.set(key, Math.max(last.get(key) ?? -Infinity, ms));
    };
    for (const r of (await q('SELECT ticket_key, MAX(created_at) AS last FROM app.ticket_events GROUP BY ticket_key')).rows) note(str(r.ticket_key), r.last);
    for (const r of (await q('SELECT ticket_key, MAX(created_at) AS last FROM app.ticket_comments WHERE author <> $1 GROUP BY ticket_key', [CONSOLE_AUTHOR])).rows) note(str(r.ticket_key), r.last);
    idle = tickets.flatMap((t) => (last.has(t.key) ? [{ ticket: t, lastActivityMs: last.get(t.key) as number }] : []));
    return idle;
  };

  for (const { wf, node } of timed) {
    const c = withDefaults('trigger', node.type, node.config);
    if (node.type === 'schedule') {
      const key = `${wf.id}|${node.id}|`;
      if (!scheduleDue(c, state.get(key) ?? null, nowMs)) continue;
      await claim(wf.id, node.id, '');
      results.push(await runWorkflow(q, wf, node.id, { kind: 'schedule', payload: { schedule: { firedAt: new Date(nowMs).toISOString(), every: c.every, at: c.at } } }, deps));
      continue;
    }
    const days = Math.max(1, Math.round(num(c.days) || 3));
    const statuses = str(c.status) ? [str(c.status)] : IDLE_DEFAULT_STATUSES;
    const project = str(c.project).trim();
    for (const { ticket, lastActivityMs } of await loadIdle()) {
      if (!statuses.includes(ticket.status)) continue;
      if (project && ticket.engagementId !== project) continue;
      if (businessDaysBetween(lastActivityMs, nowMs) < days) continue;
      const since = new Date(lastActivityMs).toISOString();
      const subject = `${ticket.key}@${since}`;
      if (state.has(`${wf.id}|${node.id}|${subject}`)) continue;
      await claim(wf.id, node.id, subject);
      results.push(await runWorkflow(q, wf, node.id, { kind: 'ticket.idle', payload: { ticket, idle: { days: businessDaysBetween(lastActivityMs, nowMs), since } } }, deps));
    }
  }
  return results;
}

export function startWorkflowScheduler(q: Query, intervalMs = 60_000): void {
  const tick = async () => {
    try {
      await sweepTimedTriggers(q);
    } catch (err) {
      console.warn('[workflows] timed sweep failed:', (err as Error).message);
    }
  };
  setInterval(() => void tick(), intervalMs).unref?.();
}

/** A manual run: from the workflow's manual trigger if it has one, else its first trigger, with the ticket (if any) as the subject. */
export async function runWorkflowByHand(q: Query, wf: RunnableWorkflow, by: string, ticketKey: string | null, deps: EngineDeps = defaultEngineDeps()): Promise<RunResult | { error: string }> {
  const triggers = wf.graph.nodes.filter((n) => n.kind === 'trigger');
  const start = triggers.find((n) => n.type === 'manual') ?? triggers[0];
  if (!start) return { error: 'This workflow has no trigger node to start from' };
  const payload: Record<string, unknown> = { manual: { by } };
  if (ticketKey) {
    const t = await loadTicketPayload(q, ticketKey);
    if (!t) return { error: `Ticket ${ticketKey} not found` };
    payload.ticket = t;
  }
  return runWorkflow(q, wf, start.id, { kind: start.type, payload }, deps);
}

// Re-exported so the routes can validate connection labels against a node's outcomes.
export { conditionOutcomes };
