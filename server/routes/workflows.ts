import { z } from 'zod';
import express from 'express';
import { CATALOG, DEFAULT_TYPE, conditionOutcomes, nodeProblem, summarizeNode, type NodeKind } from '../../shared/workflows/catalog';
import { requestAuthor } from '../identity';
import type { Caller } from './roles';
import { decideProviders } from './workflow-decide';
import { WORKFLOW_RUNS_SCHEMA_SQL, runWorkflowByHand, type RunnableWorkflow } from './workflow-engine';

/**
 * Workflows (DAT-288, MVP): stored centrally so the web, the desktop and
 * every user see the same ones. A workflow is a name and a graph — nodes
 * (trigger / agent / condition / action, each with a catalog `type` and its
 * `config`) and directed edges — plus an `enabled` switch. Disabled
 * workflows are drafts: anything goes as long as the graph is well-formed
 * (known kinds, edges between real nodes, no loops). Enabling one demands a
 * runnable graph: at least one trigger, every node's config complete, and
 * every connection out of a condition labelled with one of its outcomes.
 * Running them is `workflow-engine.ts`; this module is storage, the run
 * history and the manual run.
 *
 * Saves are last-writer-wins with a guard: a save names the `updatedAt` it
 * was based on, and one based on a stale copy is refused (409) rather than
 * silently overwriting a colleague's change.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type Guard = (req: express.Request, res: express.Response) => Promise<Caller | null>;

export const WORKFLOWS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.workflows (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    graph JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
    enabled BOOLEAN NOT NULL DEFAULT false,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  ...WORKFLOW_RUNS_SCHEMA_SQL,
];

export const NODE_KINDS = ['trigger', 'agent', 'condition', 'action'] as const;
export const MAX_NODES = 200;
export const MAX_EDGES = 400;

const ConfigSchema = z.record(z.string().max(40), z.union([z.string().max(4000), z.number().finite()]));
const NodeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(NODE_KINDS),
  /** Catalog entry id; '' from a pre-catalog draft is replaced by the kind's default. */
  type: z.string().max(40).default(''),
  config: ConfigSchema.default({}),
  title: z.string().max(120),
  detail: z.string().max(200),
  x: z.number().finite().min(0).max(100_000),
  y: z.number().finite().min(0).max(100_000),
});
const EdgeSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  label: z.string().max(40).optional(),
});
const GraphSchema = z.object({
  nodes: z.array(NodeSchema).max(MAX_NODES),
  edges: z.array(EdgeSchema).max(MAX_EDGES),
});
export type WorkflowGraph = z.infer<typeof GraphSchema>;
export type WorkflowNode = z.infer<typeof NodeSchema>;

const NameSchema = z.string().trim().min(1).max(80);
const CreateBody = z.object({ name: NameSchema, graph: GraphSchema, description: z.string().max(500).optional() });
const SaveBody = z
  .object({
    name: NameSchema.optional(),
    graph: GraphSchema.optional(),
    enabled: z.boolean().optional(),
    description: z.string().max(500).optional(),
    baseUpdatedAt: z.string().max(40).optional(),
  })
  .refine((b) => b.name !== undefined || b.graph !== undefined || b.enabled !== undefined || b.description !== undefined, { message: 'Nothing to save' });
const RunBody = z.object({ ticketKey: z.string().trim().max(40).optional() });

/** Every node carries a catalog type: pre-catalog drafts get their kind's default. */
export function normalizeGraph(graph: WorkflowGraph): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const type = n.type && CATALOG[n.kind].some((e) => e.id === n.type) ? n.type : DEFAULT_TYPE[n.kind];
      return { ...n, type };
    }),
  };
}

/**
 * What zod cannot say about a graph: node ids are unique, every edge joins two
 * real and different nodes, nothing feeds a trigger, no edge is repeated, and
 * the whole thing runs one way. Returns the first problem in plain words, or
 * null when the graph is sound.
 */
export function graphProblem(graph: WorkflowGraph): string | null {
  const kinds = new Map<string, string>();
  for (const n of graph.nodes) {
    if (kinds.has(n.id)) return `Two nodes share the id ${n.id}`;
    kinds.set(n.id, n.kind);
  }
  const seen = new Set<string>();
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!kinds.has(e.from) || !kinds.has(e.to)) return `A connection points at a node that is not in the workflow (${e.from} → ${e.to})`;
    if (e.from === e.to) return `${e.from} is connected to itself`;
    if (kinds.get(e.to) === 'trigger') return `Nothing can feed a trigger (${e.from} → ${e.to})`;
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) return `${e.from} → ${e.to} is connected twice`;
    seen.add(key);
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }
  // Depth-first search with the usual three colours: meeting a node that is
  // still on the stack means the path came back on itself.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') return true;
    state.set(id, 'open');
    for (const next of out.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 'done');
    return false;
  };
  for (const id of kinds.keys()) if (visit(id)) return 'The workflow loops back on itself — workflows run one way';
  return null;
}

/**
 * What stops a graph from being switched on: no trigger, a node whose
 * config is incomplete, or a connection out of a condition carrying a label
 * that is not one of its outcomes. Drafts may have all of these.
 */
export function enableProblem(graph: WorkflowGraph): string | null {
  if (!graph.nodes.some((n) => n.kind === 'trigger')) return 'Add a trigger before enabling the workflow';
  for (const n of graph.nodes) {
    const p = nodeProblem(n.kind, n.type, n.config);
    if (p) return `${n.title || n.type}: ${p}`;
  }
  for (const n of graph.nodes) {
    if (n.kind !== 'condition') continue;
    const outcomes = conditionOutcomes(n.type, n.config).map((o) => o.toLowerCase());
    for (const e of graph.edges.filter((e) => e.from === n.id)) {
      const label = e.label?.trim().toLowerCase();
      if (label && !outcomes.includes(label)) return `${n.title || n.type}: the connection labelled “${e.label}” matches none of its outcomes (${outcomes.join(', ') || 'none yet'})`;
    }
  }
  return null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const bool = (v: unknown): boolean => v === true || v === 'true' || v === 't';
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : str(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function graphFromRow(v: unknown): WorkflowGraph {
  let raw: unknown = v;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const parsed = GraphSchema.safeParse(raw);
  return parsed.success ? normalizeGraph(parsed.data) : { nodes: [], edges: [] };
}

/** One line for the list: what starts the workflow. */
export function triggerSummary(graph: WorkflowGraph): string {
  const triggers = graph.nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length === 0) return 'no trigger';
  const first = summarizeNode('trigger', triggers[0].type, triggers[0].config);
  return triggers.length === 1 ? first : `${first} (+${triggers.length - 1} more)`;
}

function workflowFromRow(r: Record<string, unknown>) {
  return {
    id: num(r.id),
    name: str(r.name),
    description: str(r.description),
    enabled: bool(r.enabled),
    graph: graphFromRow(r.graph),
    updatedBy: str(r.updated_by),
    updatedAt: iso(r.updated_at),
    createdAt: iso(r.created_at),
  };
}

function runFromRow(r: Record<string, unknown>, full: boolean) {
  let steps: unknown = r.steps;
  if (typeof steps === 'string') {
    try {
      steps = JSON.parse(steps);
    } catch {
      steps = [];
    }
  }
  let payload: unknown = r.payload;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  const stepList = Array.isArray(steps) ? steps : [];
  return {
    id: num(r.id),
    workflowId: num(r.workflow_id),
    workflowName: str(r.workflow_name),
    trigger: str(r.trigger),
    subject: str(r.subject),
    state: str(r.state),
    error: str(r.error),
    startedAt: iso(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
    stepCount: stepList.length,
    ...(full ? { steps: stepList, payload: payload && typeof payload === 'object' ? payload : {} } : {}),
  };
}

const idOf = (req: express.Request): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function setupWorkflowRoutes(app: express.Application, q: Query, requireAnyLead?: Guard) {
  /** Which decision providers this deployment can reach — the inspector says so next to the Decide node. */
  app.get('/api/workflows/providers', (_req, res) => {
    res.json(decideProviders());
  });

  // The list: every workflow, most recently touched first, with what starts
  // it and how its last run went.
  app.get('/api/workflows', async (_req, res) => {
    try {
      const rows = (await q(`SELECT id, name, enabled, graph, updated_by, updated_at FROM app.workflows ORDER BY updated_at DESC, id DESC`)).rows;
      const last = new Map<number, Record<string, unknown>>();
      for (const r of (await q(`SELECT DISTINCT ON (workflow_id) workflow_id, id, state, started_at, finished_at, error FROM app.workflow_runs ORDER BY workflow_id, started_at DESC, id DESC`)).rows) {
        last.set(num(r.workflow_id), r);
      }
      const counts = new Map<number, { ok: number; failed: number }>();
      for (const r of (
        await q(`SELECT workflow_id, state, COUNT(*) AS n FROM app.workflow_runs WHERE started_at > NOW() - INTERVAL '7 days' GROUP BY workflow_id, state`)
      ).rows) {
        const c = counts.get(num(r.workflow_id)) ?? { ok: 0, failed: 0 };
        if (str(r.state) === 'succeeded') c.ok += num(r.n);
        else if (str(r.state) === 'failed') c.failed += num(r.n);
        counts.set(num(r.workflow_id), c);
      }
      res.json(
        rows.map((r) => {
          const id = num(r.id);
          const graph = graphFromRow(r.graph);
          const lr = last.get(id);
          return {
            id,
            name: str(r.name),
            enabled: bool(r.enabled),
            nodes: graph.nodes.length,
            trigger: triggerSummary(graph),
            updatedBy: str(r.updated_by),
            updatedAt: iso(r.updated_at),
            lastRun: lr ? { id: num(lr.id), state: str(lr.state), startedAt: iso(lr.started_at), finishedAt: isoOrNull(lr.finished_at), error: str(lr.error) } : null,
            runs7d: counts.get(id) ?? { ok: 0, failed: 0 },
          };
        }),
      );
    } catch (err) {
      console.error('workflows list failed:', err);
      res.status(500).json({ error: 'Failed to load workflows' });
    }
  });

  app.get('/api/workflows/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const row = id === null ? undefined : (await q('SELECT * FROM app.workflows WHERE id = $1', [id])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      res.json(workflowFromRow(row));
    } catch (err) {
      console.error('workflow load failed:', err);
      res.status(500).json({ error: 'Failed to load the workflow' });
    }
  });

  app.post('/api/workflows', async (req, res) => {
    try {
      const parsed = CreateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const graph = normalizeGraph(parsed.data.graph);
      const problem = graphProblem(graph);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      const who = requestAuthor(req);
      const row = (
        await q(`INSERT INTO app.workflows (name, graph, description, created_by, updated_by) VALUES ($1,$2,$3,$4,$4) RETURNING *`, [
          parsed.data.name,
          JSON.stringify(graph),
          parsed.data.description ?? '',
          who,
        ])
      ).rows[0];
      console.log(`[workflows] ${who} created "${parsed.data.name}" (${graph.nodes.length} nodes)`);
      res.json(workflowFromRow(row));
    } catch (err) {
      console.error('workflow create failed:', err);
      res.status(500).json({ error: 'Failed to create the workflow' });
    }
  });

  app.put('/api/workflows/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const parsed = SaveBody.safeParse(req.body);
      if (id === null || !parsed.success) {
        res.status(400).json({ error: id === null ? 'Bad workflow id' : parsed.error?.issues.map((i) => i.message).join('; ') });
        return;
      }
      const graph = parsed.data.graph ? normalizeGraph(parsed.data.graph) : undefined;
      if (graph) {
        const problem = graphProblem(graph);
        if (problem) {
          res.status(400).json({ error: problem });
          return;
        }
      }
      const current = (await q('SELECT graph, enabled, updated_at, updated_by FROM app.workflows WHERE id = $1', [id])).rows[0];
      if (!current) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      if (parsed.data.baseUpdatedAt && iso(current.updated_at) !== parsed.data.baseUpdatedAt) {
        res.status(409).json({ error: `This workflow was saved elsewhere while you were editing (last by ${str(current.updated_by) || 'someone'}) — reloaded the latest version` });
        return;
      }
      // Switching on, or editing while on: the graph must be runnable.
      // Switching on is a lead's call; editing a running workflow is not
      // gated, so a lead's enabled workflow stays everyone's to improve.
      const willBeEnabled = parsed.data.enabled ?? bool(current.enabled);
      if (willBeEnabled) {
        const problem = enableProblem(graph ?? graphFromRow(current.graph));
        if (problem) {
          res.status(400).json({ error: problem });
          return;
        }
      }
      if (parsed.data.enabled === true && !bool(current.enabled) && requireAnyLead && !(await requireAnyLead(req, res))) return;
      const row = (
        await q(
          `UPDATE app.workflows SET name = COALESCE($2, name), graph = COALESCE($3::jsonb, graph), enabled = COALESCE($4, enabled), description = COALESCE($5, description), updated_by = $6, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, parsed.data.name ?? null, graph ? JSON.stringify(graph) : null, parsed.data.enabled ?? null, parsed.data.description ?? null, requestAuthor(req)],
        )
      ).rows[0];
      if (parsed.data.enabled !== undefined && parsed.data.enabled !== bool(current.enabled)) {
        console.log(`[workflows] ${requestAuthor(req)} ${parsed.data.enabled ? 'enabled' : 'disabled'} "${str(row.name)}"`);
      }
      res.json(workflowFromRow(row));
    } catch (err) {
      console.error('workflow save failed:', err);
      res.status(500).json({ error: 'Failed to save the workflow' });
    }
  });

  app.delete('/api/workflows/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const removed = id === null ? undefined : (await q('DELETE FROM app.workflows WHERE id = $1 RETURNING name', [id])).rows[0];
      if (!removed) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      console.log(`[workflows] ${requestAuthor(req)} deleted "${str(removed.name)}"`);
      res.json({ ok: true });
    } catch (err) {
      console.error('workflow delete failed:', err);
      res.status(500).json({ error: 'Failed to delete the workflow' });
    }
  });

  /** Run now: from the manual trigger if there is one, else the first trigger; a ticket key makes it the subject. Leads and admins. */
  app.post('/api/workflows/:id/run', async (req, res) => {
    try {
      const id = idOf(req);
      const parsed = RunBody.safeParse(req.body ?? {});
      if (id === null || !parsed.success) {
        res.status(400).json({ error: 'Bad run request' });
        return;
      }
      const row = (await q('SELECT id, name, graph FROM app.workflows WHERE id = $1', [id])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }
      const caller = requireAnyLead ? await requireAnyLead(req, res) : null;
      if (requireAnyLead && !caller) return;
      const wf: RunnableWorkflow = { id: num(row.id), name: str(row.name), graph: graphFromRow(row.graph) };
      const problem = enableProblem(wf.graph);
      if (problem) {
        res.status(400).json({ error: problem });
        return;
      }
      const result = await runWorkflowByHand(q, wf, caller?.email || requestAuthor(req), parsed.data.ticketKey?.trim() || null);
      if ('error' in result) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err) {
      console.error('workflow run failed:', err);
      res.status(500).json({ error: 'Failed to run the workflow' });
    }
  });

  /** Run history, newest first: every workflow's, or one workflow's with `?workflow=`. */
  app.get('/api/workflow-runs', async (req, res) => {
    try {
      const workflow = Number(req.query.workflow);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const where = Number.isInteger(workflow) && workflow > 0 ? 'WHERE workflow_id = $2' : '';
      const params: unknown[] = where ? [limit, workflow] : [limit];
      const rows = (
        await q(`SELECT id, workflow_id, workflow_name, trigger, subject, state, error, started_at, finished_at, steps FROM app.workflow_runs ${where} ORDER BY started_at DESC, id DESC LIMIT $1`, params)
      ).rows;
      res.json(rows.map((r) => runFromRow(r, false)));
    } catch (err) {
      console.error('workflow runs failed:', err);
      res.status(500).json({ error: 'Failed to load the run history' });
    }
  });

  app.get('/api/workflow-runs/:id', async (req, res) => {
    try {
      const id = idOf(req);
      const row = id === null ? undefined : (await q('SELECT * FROM app.workflow_runs WHERE id = $1', [id])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Run not found' });
        return;
      }
      res.json(runFromRow(row, true));
    } catch (err) {
      console.error('workflow run load failed:', err);
      res.status(500).json({ error: 'Failed to load the run' });
    }
  });
}

export type { NodeKind };
