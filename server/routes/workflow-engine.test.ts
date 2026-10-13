import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import { tenancyTestSql } from '../db/tenancy';
import {
  evalRule,
  fireWorkflowEvent,
  getPath,
  nextNodes,
  render,
  runWorkflow,
  runWorkflowByHand,
  scheduleDue,
  sweepTimedTriggers,
  triggerMatches,
  type EngineDeps,
  type RunnableWorkflow,
} from './workflow-engine';
import { WORKFLOWS_SCHEMA_SQL, enableProblem, graphProblem, normalizeGraph, type WorkflowGraph, type WorkflowNode } from './workflows';
import type { Decision } from './workflow-decide';

/**
 * The workflow engine against pg-mem: the same SQL the server runs, on
 * stand-ins for the console tables a run touches. What is pinned: trigger
 * matching and its filters, rule and template semantics, the walk through
 * labelled condition branches, every action's effect, the run record, the
 * timed triggers (schedule and idle, each firing once), and the loop guard.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY)`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '—', description TEXT NOT NULL DEFAULT '', tags JSONB NOT NULL DEFAULT '[]', done_at TIMESTAMPTZ)`,
  `CREATE TABLE app.ticket_events (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.ticket_comments (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, time_label TEXT NOT NULL, source TEXT, reversible BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE TABLE app.notifications (id SERIAL PRIMARY KEY, recipient_email TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, ticket_key TEXT, engagement_id TEXT, read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, priority INT NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '', queued_by TEXT, assignee TEXT, agent TEXT, state TEXT NOT NULL DEFAULT 'queued')`,
];

let q: Query;
const NOW = Date.parse('2026-08-05T10:00:00Z'); // a Wednesday

const node = (id: string, kind: WorkflowNode['kind'], type: string, config: Record<string, string | number> = {}, title = id): WorkflowNode => ({ id, kind, type, config, title, detail: '', x: 0, y: 0 });
const graph = (nodes: WorkflowNode[], edges: WorkflowGraph['edges']): WorkflowGraph => normalizeGraph({ nodes, edges });

const fixedDecision: Decision = { choice: 'substantial', confidence: 0.9, probabilities: { substantial: 0.9, quick: 0.1 }, provider: 'jev', notes: [] };
const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  now: () => NOW,
  decide: vi.fn().mockResolvedValue(fixedDecision),
  fetch: vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
  ...over,
});

async function saveWorkflow(name: string, g: WorkflowGraph, enabled = true): Promise<RunnableWorkflow> {
  const row = (await q(`INSERT INTO app.workflows (name, graph, enabled) VALUES ($1, $2, $3) RETURNING id`, [name, JSON.stringify(g), enabled])).rows[0];
  return { id: Number(row.id), name, graph: g };
}

const ticketEvent = (key: string, from: string | null, to: string) => ({
  kind: from === null ? 'ticket.created' : 'ticket.moved',
  payload: { ticket: { key, title: 'Fix login', status: to, assignee: 'dev@example.com', engagementId: 'exec', description: 'The login form 500s', tags: [] }, move: { from: from ?? '', to } },
});

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text, params) => pool.query(text, params);
  const all = [...SUPPORT_SQL, ...WORKFLOWS_SCHEMA_SQL];
  for (const sql of all) await q(sql);
  for (const sql of tenancyTestSql(all)) await q(sql);
  await q(`INSERT INTO app.engagements (id) VALUES ('exec')`);
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status, assignee, description) VALUES ('DAT-1', 'exec', 'Fix login', 'review', 'dev@example.com', 'The login form 500s')`);
});

describe('paths, templates, rules', () => {
  it('reads dotted paths and renders templates, unknown paths empty', () => {
    const p = { ticket: { key: 'DAT-1', tags: ['a', 'b'] }, pr: { number: 7 } };
    expect(getPath(p, 'ticket.key')).toBe('DAT-1');
    expect(getPath(p, 'pr.missing.deeper')).toBeUndefined();
    expect(render('{{ticket.key}} / PR #{{ pr.number }} / {{nope}} / {{ticket.tags}}', p)).toBe('DAT-1 / PR #7 /  / a, b');
  });

  it('compares case-insensitively and numerically where it should', () => {
    const p = { ticket: { status: 'Review', title: 'Fix the LOGIN form' }, pr: { number: 12 }, empty: '' };
    expect(evalRule({ field: 'ticket.status', op: 'equals', value: 'review' }, p).outcome).toBe('yes');
    expect(evalRule({ field: 'ticket.title', op: 'contains', value: 'login' }, p).outcome).toBe('yes');
    expect(evalRule({ field: 'ticket.title', op: 'not-contains', value: 'login' }, p).outcome).toBe('no');
    expect(evalRule({ field: 'pr.number', op: 'greater', value: '10' }, p).outcome).toBe('yes');
    expect(evalRule({ field: 'pr.number', op: 'less', value: '10' }, p).outcome).toBe('no');
    expect(evalRule({ field: 'empty', op: 'empty', value: '' }, p).outcome).toBe('yes');
    expect(evalRule({ field: 'pr.url', op: 'exists', value: '' }, p).outcome).toBe('no');
    expect(evalRule({ field: 'ticket.status', op: 'equals', value: '{{ticket.status}}' }, p).outcome).toBe('yes');
  });
});

describe('triggerMatches', () => {
  const ev = ticketEvent('DAT-1', 'progress', 'review');
  it('wants the same kind and honours every filter it sets', () => {
    expect(triggerMatches(node('t', 'trigger', 'ticket.moved'), ev)).toBe(true);
    expect(triggerMatches(node('t', 'trigger', 'ticket.moved', { to: 'review' }), ev)).toBe(true);
    expect(triggerMatches(node('t', 'trigger', 'ticket.moved', { to: 'done' }), ev)).toBe(false);
    expect(triggerMatches(node('t', 'trigger', 'ticket.moved', { from: 'backlog' }), ev)).toBe(false);
    expect(triggerMatches(node('t', 'trigger', 'ticket.moved', { project: 'exec' }), ev)).toBe(true);
    expect(triggerMatches(node('t', 'trigger', 'ticket.moved', { project: 'other' }), ev)).toBe(false);
    expect(triggerMatches(node('t', 'trigger', 'ticket.created'), ev)).toBe(false);
    expect(triggerMatches(node('t', 'action', 'ticket.move'), ev)).toBe(false);
  });
  it('filters comments by substring, agent runs by outcome, deploys by result', () => {
    const comment = { kind: 'comment.added', payload: { comment: { body: 'please /deploy this' } } };
    expect(triggerMatches(node('t', 'trigger', 'comment.added', { contains: '/DEPLOY' }), comment)).toBe(true);
    expect(triggerMatches(node('t', 'trigger', 'comment.added', { contains: 'rollback' }), comment)).toBe(false);
    expect(triggerMatches(node('t', 'trigger', 'agent.completed', { outcome: 'failed' }), { kind: 'agent.completed', payload: { run: { outcome: 'done' } } })).toBe(false);
    expect(triggerMatches(node('t', 'trigger', 'deploy.finished', { result: 'failed' }), { kind: 'deploy.finished', payload: { deploy: { result: 'failed' } } })).toBe(true);
  });
});

describe('scheduleDue', () => {
  it('hourly: an hour since the last firing', () => {
    expect(scheduleDue({ every: 'hour' }, null, NOW)).toBe(true);
    expect(scheduleDue({ every: 'hour' }, NOW - 30 * 60_000, NOW)).toBe(false);
    expect(scheduleDue({ every: 'hour' }, NOW - 61 * 60_000, NOW)).toBe(true);
  });
  it('daily at a UTC time: once the clock passes it, once a day', () => {
    expect(scheduleDue({ every: 'day', at: '09:30' }, null, NOW)).toBe(true);
    expect(scheduleDue({ every: 'day', at: '11:00' }, null, NOW)).toBe(false);
    expect(scheduleDue({ every: 'day', at: '09:30' }, NOW - 10 * 60_000, NOW)).toBe(false); // fired at 09:50 today
    expect(scheduleDue({ every: 'day', at: '09:30' }, NOW - 24 * 3_600_000, NOW)).toBe(true); // fired yesterday
    expect(scheduleDue({ every: 'day', at: 'noon' }, null, NOW)).toBe(false);
  });
  it('weekdays and weeks respect the calendar', () => {
    const saturday = Date.parse('2026-08-08T10:00:00Z');
    const monday = Date.parse('2026-08-10T10:00:00Z');
    expect(scheduleDue({ every: 'weekday', at: '09:00' }, null, saturday)).toBe(false);
    expect(scheduleDue({ every: 'weekday', at: '09:00' }, null, NOW)).toBe(true);
    expect(scheduleDue({ every: 'week', at: '09:00' }, null, NOW)).toBe(false);
    expect(scheduleDue({ every: 'week', at: '09:00' }, null, monday)).toBe(true);
  });
});

describe('nextNodes', () => {
  const g = graph(
    [node('t', 'trigger', 'manual'), node('c', 'condition', 'rule', { field: 'x', op: 'exists' }), node('a', 'action', 'feed', { text: 'x' }), node('b', 'action', 'feed', { text: 'y' }), node('always', 'action', 'feed', { text: 'z' })],
    [
      { from: 't', to: 'c' },
      { from: 'c', to: 'a', label: 'yes' },
      { from: 'c', to: 'b', label: 'No' },
      { from: 'c', to: 'always' },
    ],
  );
  it('follows every connection out of a plain node, and only matching or unlabelled ones out of a condition', () => {
    expect(nextNodes(g, 't', undefined)).toEqual(['c']);
    expect(nextNodes(g, 'c', 'yes')).toEqual(['a', 'always']);
    expect(nextNodes(g, 'c', 'no')).toEqual(['b', 'always']);
  });
});

describe('runWorkflow — actions and the run record', () => {
  it('moves, comments, tags, assigns, notifies and posts, recording each step', async () => {
    const wf = await saveWorkflow(
      'Review gate',
      graph(
        [
          node('t', 'trigger', 'ticket.moved', { to: 'review' }),
          node('move', 'action', 'ticket.move', { status: 'deploying' }),
          node('comment', 'action', 'ticket.comment', { body: '{{ticket.key}} moved by {{workflow.name}}' }),
          node('tag', 'action', 'ticket.tag', { tag: 'auto' }),
          node('assign', 'action', 'ticket.assign', { assignee: 'lead@example.com' }),
          node('notify', 'action', 'notify', { to: '{{ticket.assignee}}', title: 'Heads up on {{ticket.key}}', message: 'moved' }),
          node('feed', 'action', 'feed', { text: 'Gate ran on {{ticket.key}}' }),
        ],
        [
          { from: 't', to: 'move' },
          { from: 'move', to: 'comment' },
          { from: 'comment', to: 'tag' },
          { from: 'tag', to: 'assign' },
          { from: 'assign', to: 'notify' },
          { from: 'notify', to: 'feed' },
        ],
      ),
    );
    const result = await runWorkflow(q, wf, 't', ticketEvent('DAT-1', 'progress', 'review'), deps());
    expect(result.error).toBe('');
    expect(result.state).toBe('succeeded');
    expect(result.steps.map((s) => [s.nodeId, s.state])).toEqual([
      ['t', 'ok'],
      ['move', 'ok'],
      ['comment', 'ok'],
      ['tag', 'ok'],
      ['assign', 'ok'],
      ['notify', 'ok'],
      ['feed', 'ok'],
    ]);
    const ticket = (await q('SELECT status, assignee, tags FROM app.tickets WHERE key = $1', ['DAT-1'])).rows[0];
    expect(ticket.status).toBe('deploying');
    expect(ticket.assignee).toBe('lead@example.com');
    expect(ticket.tags).toEqual(['auto']);
    expect((await q('SELECT to_status FROM app.ticket_events')).rows.map((r) => r.to_status)).toEqual(['deploying']);
    const comment = (await q('SELECT author, body FROM app.ticket_comments')).rows[0];
    expect(comment).toEqual({ author: 'Workflow · Review gate', body: 'DAT-1 moved by Review gate' });
    // The notification went to the assignee as it was when the event fired.
    expect((await q('SELECT recipient_email, title, type FROM app.notifications')).rows[0]).toEqual({ recipient_email: 'dev@example.com', title: 'Heads up on DAT-1', type: 'workflow' });
    expect((await q('SELECT text FROM app.feed_items')).rows.map((r) => r.text)).toEqual(['Gate ran on DAT-1']);
    const run = (await q('SELECT workflow_id, workflow_name, trigger, subject, state, error, finished_at FROM app.workflow_runs')).rows[0];
    expect(run).toMatchObject({ workflow_id: wf.id, workflow_name: 'Review gate', trigger: 'ticket.moved', subject: 'DAT-1', state: 'succeeded', error: '' });
    expect(run.finished_at).not.toBeNull();
  });

  it('branches on a rule and on a decision, following only the labelled outcome', async () => {
    const decide = vi.fn().mockResolvedValue(fixedDecision);
    const wf = await saveWorkflow(
      'Triage',
      graph(
        [
          node('t', 'trigger', 'pr.opened'),
          node('big', 'condition', 'decide', { question: 'Size?', choices: 'quick: small\nsubstantial: big', state: '{{pr.title}}' }),
          node('tag', 'action', 'ticket.tag', { tag: 'needs-second-reviewer' }),
          node('small', 'action', 'ticket.tag', { tag: 'quick' }),
          node('rule', 'condition', 'rule', { field: 'pr.author', op: 'equals', value: 'bot' }),
          node('bot', 'action', 'feed', { text: 'bot PR' }),
          node('human', 'action', 'feed', { text: 'human PR' }),
        ],
        [
          { from: 't', to: 'big' },
          { from: 'big', to: 'tag', label: 'substantial' },
          { from: 'big', to: 'small', label: 'quick' },
          { from: 'tag', to: 'rule' },
          { from: 'rule', to: 'bot', label: 'yes' },
          { from: 'rule', to: 'human', label: 'no' },
        ],
      ),
    );
    const event = { kind: 'pr.opened', payload: { ...ticketEvent('DAT-1', 'progress', 'review').payload, pr: { number: 9, title: 'Rewrite auth', author: 'nigel', url: 'https://x/9', branch: 'DAT-1-auth' } } };
    const result = await runWorkflow(q, wf, 't', event, deps({ decide }));
    expect(result.state).toBe('succeeded');
    expect(result.steps.map((s) => s.nodeId)).toEqual(['t', 'big', 'tag', 'rule', 'human']);
    expect(result.steps[1].outcome).toBe('substantial');
    expect(result.steps[1].detail).toContain('jev chose substantial (confidence 90%');
    expect(decide).toHaveBeenCalledWith({ state: 'Rewrite auth', question: 'Size?', choices: [{ label: 'quick', description: 'small' }, { label: 'substantial', description: 'big' }], provider: 'auto' });
    expect((await q('SELECT tags FROM app.tickets WHERE key = $1', ['DAT-1'])).rows[0].tags).toEqual(['needs-second-reviewer']);
    expect((await q('SELECT text FROM app.feed_items')).rows.map((r) => r.text)).toEqual(['human PR']);
  });

  it('queues the ticket for an agent once, and says so the second time', async () => {
    const wf = await saveWorkflow('Rework', graph([node('t', 'trigger', 'comment.added', { contains: '/rework' }), node('q', 'agent', 'queue', { instructions: 'Address: {{comment.body}}', assignee: 'Dev@Example.com', priority: 5 })], [{ from: 't', to: 'q' }]));
    const event = { kind: 'comment.added', payload: { ...ticketEvent('DAT-1', 'progress', 'review').payload, comment: { author: 'lead@example.com', body: '/rework the tests' } } };
    const first = await runWorkflow(q, wf, 't', event, deps());
    expect(first.state).toBe('succeeded');
    const task = (await q('SELECT ticket_key, priority, instructions, queued_by, assignee, state FROM app.agent_tasks')).rows[0];
    expect(task).toEqual({ ticket_key: 'DAT-1', priority: 5, instructions: 'Address: /rework the tests', queued_by: 'Workflow · Rework', assignee: 'dev@example.com', state: 'queued' });
    const second = await runWorkflow(q, wf, 't', event, deps());
    expect(second.state).toBe('succeeded');
    expect(second.steps[1].detail).toContain('already has an active run');
    expect((await q('SELECT id FROM app.agent_tasks')).rows).toHaveLength(1);
  });

  it('calls a webhook with the rendered body and fails the run on a bad answer', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 200 })).mockResolvedValueOnce(new Response('', { status: 503 }));
    const wf = await saveWorkflow('Hook', graph([node('t', 'trigger', 'manual'), node('h', 'action', 'webhook', { url: 'https://hooks.example.com/x', body: '{"key":"{{ticket.key}}"}' })], [{ from: 't', to: 'h' }]));
    const ok = await runWorkflow(q, wf, 't', ticketEvent('DAT-1', 'progress', 'review'), deps({ fetch }));
    expect(ok.state).toBe('succeeded');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/x');
    expect(init.body).toBe('{"key":"DAT-1"}');
    const bad = await runWorkflow(q, wf, 't', ticketEvent('DAT-1', 'progress', 'review'), deps({ fetch }));
    expect(bad.state).toBe('failed');
    expect(bad.error).toContain('answered 503');
    expect((await q(`SELECT state, error FROM app.workflow_runs ORDER BY id`)).rows.map((r) => r.state)).toEqual(['succeeded', 'failed']);
  });

  it('fails a ticket action when the event carries no ticket, and stops there', async () => {
    const wf = await saveWorkflow('Sched', graph([node('t', 'trigger', 'schedule', { every: 'hour' }), node('c', 'action', 'ticket.comment', { body: 'hi' }), node('f', 'action', 'webhook', { url: 'https://x.example.com' })], [{ from: 't', to: 'c' }, { from: 'c', to: 'f' }]));
    const result = await runWorkflow(q, wf, 't', { kind: 'schedule', payload: { schedule: { firedAt: 'now' } } }, deps());
    expect(result.state).toBe('failed');
    expect(result.error).toContain('carries no ticket');
    expect(result.steps.map((s) => s.nodeId)).toEqual(['t', 'c']);
  });
});

describe('fireWorkflowEvent', () => {
  it('runs every enabled workflow whose trigger matches, and none that is disabled', async () => {
    const g = graph([node('t', 'trigger', 'ticket.moved', { to: 'review' }), node('f', 'action', 'feed', { text: '{{workflow.name}}' })], [{ from: 't', to: 'f' }]);
    await saveWorkflow('On', g, true);
    await saveWorkflow('Off', g, false);
    await saveWorkflow('Other lane', graph([node('t', 'trigger', 'ticket.moved', { to: 'done' }), node('f', 'action', 'feed', { text: 'x' })], [{ from: 't', to: 'f' }]), true);
    const runs = await fireWorkflowEvent(q, ticketEvent('DAT-1', 'progress', 'review'), deps());
    expect(runs).toHaveLength(1);
    expect((await q('SELECT text FROM app.feed_items')).rows.map((r) => r.text)).toEqual(['On']);
  });

  it('a workflow that moves a ticket does not re-trigger itself forever', async () => {
    // Moving to review emits ticket.moved(to: review) through the real
    // status helper, which would match this very workflow again.
    await saveWorkflow('Loop', graph([node('t', 'trigger', 'ticket.moved'), node('m', 'action', 'ticket.move', { status: 'review' }), node('b', 'action', 'ticket.move', { status: 'backlog' })], [{ from: 't', to: 'm' }, { from: 'm', to: 'b' }]), true);
    const runs = await fireWorkflowEvent(q, ticketEvent('DAT-1', 'backlog', 'progress'), deps());
    expect(runs).toHaveLength(1);
    // Give the fire-and-forget re-entries a moment, then count: bounded by the depth guard.
    await new Promise((r) => setTimeout(r, 50));
    const total = (await q('SELECT id FROM app.workflow_runs')).rows.length;
    expect(total).toBeGreaterThanOrEqual(1);
    expect(total).toBeLessThanOrEqual(8);
  });
});

describe('sweepTimedTriggers', () => {
  it('fires a due schedule once and an idle ticket once per quiet period', async () => {
    await q(`INSERT INTO app.ticket_events (ticket_key, engagement_id, from_status, to_status, created_at) VALUES ('DAT-1', 'exec', 'progress', 'review', $1)`, [new Date(NOW - 6 * 86_400_000).toISOString()]);
    await saveWorkflow('Daily', graph([node('s', 'trigger', 'schedule', { every: 'day', at: '09:00' }), node('w', 'action', 'webhook', { url: 'https://x.example.com' })], [{ from: 's', to: 'w' }]));
    await saveWorkflow('Idle', graph([node('i', 'trigger', 'ticket.idle', { days: 3 }), node('c', 'action', 'ticket.comment', { body: 'Idle {{idle.days}} days since {{idle.since}}' })], [{ from: 'i', to: 'c' }]));
    const first = await sweepTimedTriggers(q, deps());
    expect(first.map((r) => r.state)).toEqual(['succeeded', 'succeeded']);
    const second = await sweepTimedTriggers(q, deps());
    expect(second).toHaveLength(0);
    const comments = (await q('SELECT body FROM app.ticket_comments')).rows.map((r) => r.body);
    expect(comments).toHaveLength(1);
    expect(String(comments[0])).toMatch(/^Idle 4 days since 2026-07-30T10:00:00/);
    // Next day the schedule is due again; the ticket's quiet period is the same one.
    const tomorrow = await sweepTimedTriggers(q, deps({ now: () => NOW + 86_400_000 }));
    expect(tomorrow.map((r) => r.steps[0].type)).toEqual(['schedule']);
  });
});

describe('runWorkflowByHand and the enable rules', () => {
  it('starts from the manual trigger with the named ticket as the subject', async () => {
    const wf = await saveWorkflow('Hand', graph([node('a', 'trigger', 'ticket.moved'), node('m', 'trigger', 'manual'), node('c', 'action', 'ticket.comment', { body: 'Run by {{manual.by}}' })], [{ from: 'm', to: 'c' }]), false);
    const result = await runWorkflowByHand(q, wf, 'lead@example.com', 'DAT-1', deps());
    expect('state' in result && result.state).toBe('succeeded');
    expect((await q('SELECT body FROM app.ticket_comments')).rows[0].body).toBe('Run by lead@example.com');
    expect(await runWorkflowByHand(q, wf, 'x', 'DAT-404', deps())).toEqual({ error: 'Ticket DAT-404 not found' });
  });

  it('refuses to enable an incomplete graph, and accepts a complete one', () => {
    expect(enableProblem(graph([node('a', 'action', 'feed', { text: 'x' })], []))).toContain('Add a trigger');
    expect(enableProblem(graph([node('t', 'trigger', 'manual'), node('h', 'action', 'webhook', { url: 'nope' })], []))).toContain('http');
    expect(enableProblem(graph([node('t', 'trigger', 'manual'), node('d', 'condition', 'decide', { question: 'q', choices: 'a: 1\nb: 2' }), node('f', 'action', 'feed', { text: 'x' })], [{ from: 'd', to: 'f', label: 'c' }]))).toContain('matches none of its outcomes');
    expect(enableProblem(graph([node('t', 'trigger', 'manual'), node('d', 'condition', 'decide', { question: 'q', choices: 'a: 1\nb: 2' }), node('f', 'action', 'feed', { text: 'x' })], [{ from: 'd', to: 'f', label: 'B' }]))).toBeNull();
    expect(graphProblem(graph([node('t', 'trigger', 'manual'), node('f', 'action', 'feed')], [{ from: 'f', to: 't' }]))).toContain('Nothing can feed a trigger');
  });
});
