import { beforeEach, describe, expect, it } from 'vitest';
import { newDb, DataType } from 'pg-mem';
import { cycleTimes, flowSeries, loadMetrics, parseRange, percentile, rangeSince, weekStart } from './metrics';

/**
 * The Metrics aggregation SQL against pg-mem on a small seeded board, plus
 * the pure series helpers. The fixture is dated around NOW so the 30d window
 * splits it: two done tickets and one usage run inside, one done ticket and
 * one run outside.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const NOW = new Date('2026-09-23T12:00:00.000Z');

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY, client TEXT NOT NULL, name TEXT NOT NULL, health TEXT NOT NULL)`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
     est_hours REAL, human_est_hours REAL, actual_hours REAL, done_at TIMESTAMPTZ)`,
  `CREATE TABLE app.ticket_events (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, state TEXT NOT NULL, claimed_at TIMESTAMPTZ)`,
  `CREATE TABLE app.run_token_usage (id SERIAL PRIMARY KEY, task_id INT NOT NULL, ticket_key TEXT NOT NULL DEFAULT '', engagement_id TEXT NOT NULL DEFAULT '',
     agent TEXT NOT NULL DEFAULT '', input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0,
     cache_read_tokens BIGINT NOT NULL DEFAULT 0, cache_create_tokens BIGINT NOT NULL DEFAULT 0, cost_usd DOUBLE PRECISION,
     final BOOLEAN NOT NULL DEFAULT false, model TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'harness',
     provider TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL)`,
];

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

const pad = (n: number) => String(n).padStart(2, '0');

beforeEach(async () => {
  const db = newDb();
  // pg-mem has no date_trunc / to_char; the route only uses the two shapes
  // below, implemented the way Postgres does in a UTC session.
  db.public.registerFunction({
    name: 'date_trunc',
    args: [DataType.text, DataType.timestamptz],
    returns: DataType.timestamptz,
    implementation: (unit: string, d: Date) => {
      if (unit === 'week') return new Date(`${weekStart(d.toISOString())}T00:00:00Z`);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    },
  });
  db.public.registerFunction({
    name: 'to_char',
    args: [DataType.timestamptz, DataType.text],
    returns: DataType.text,
    implementation: (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
  });
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text, params) => pool.query(text, params);
  for (const sql of SUPPORT_SQL) await q(sql);

  await q(`INSERT INTO app.engagements (id, client, name, health) VALUES ('eng-a', 'ACME', 'Alpha', 'ok'), ('eng-b', 'BETA', 'Beta', 'risk')`);
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status, est_hours, human_est_hours, actual_hours, done_at) VALUES
    ('A-1', 'eng-a', 'Login',    'done',    2,   8,  1.5, '2026-09-20T12:00:00Z'),
    ('A-2', 'eng-a', 'Billing',  'done',    1,   4,  NULL, '2026-09-14T12:00:00Z'),
    ('A-3', 'eng-a', 'Old one',  'done',    3,  12,  2,   '2026-07-01T12:00:00Z'),
    ('A-4', 'eng-a', 'Open',     'backlog', 1,   4,  NULL, NULL),
    ('A-5', 'eng-a', 'Human',    'done',    1,   6,  NULL, '2026-09-19T12:00:00Z'),
    ('B-1', 'eng-b', 'Review',   'review',  1,   5,  NULL, NULL),
    ('B-2', 'eng-b', 'Idea',     'proposed', 1,  3,  NULL, NULL),
    ('B-3', 'eng-b', 'Gone',     'dismissed', 1, 3,  NULL, NULL)`);
  await q(`INSERT INTO app.ticket_events (ticket_key, engagement_id, from_status, to_status, created_at) VALUES
    ('A-1', 'eng-a', NULL, 'backlog', '2026-09-18T12:00:00Z'),
    ('A-1', 'eng-a', 'backlog', 'done', '2026-09-20T12:00:00Z'),
    ('A-2', 'eng-a', NULL, 'backlog', '2026-09-10T12:00:00Z'),
    ('A-3', 'eng-a', NULL, 'backlog', '2026-06-01T12:00:00Z'),
    ('A-4', 'eng-a', NULL, 'backlog', '2026-09-01T12:00:00Z'),
    ('A-5', 'eng-a', NULL, 'backlog', '2026-09-19T00:00:00Z'),
    ('B-1', 'eng-b', NULL, 'backlog', '2026-09-15T12:00:00Z'),
    ('B-2', 'eng-b', NULL, 'proposed', '2026-09-15T12:00:00Z')`);
  // A-1, A-2 and A-3 were agent-delivered; A-5 was done by a human.
  await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, claimed_at) VALUES
    ('A-1', 'eng-a', 'done', '2026-09-19T12:00:00Z'),
    ('A-2', 'eng-a', 'done', '2026-09-12T12:00:00Z'),
    ('A-3', 'eng-a', 'done', '2026-06-20T12:00:00Z'),
    ('A-4', 'eng-a', 'queued', NULL)`);
  // Task 1 finished (final rows replace its per-turn rows); task 2 never did.
  // The two control-plane rows (task 0, never final) are the server's own
  // estimate calls for A-1 and A-4.
  await q(`INSERT INTO app.run_token_usage (task_id, ticket_key, engagement_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, final, model, source, provider, created_at) VALUES
    (1, 'A-1', 'eng-a', 'r1', 500, 100, 0, 0, NULL, false, 'sonnet', 'harness', 'anthropic', '2026-09-19T13:00:00Z'),
    (1, 'A-1', 'eng-a', 'r1', 100, 400, 3000, 200, 2.5, true, 'sonnet', 'harness', 'anthropic', '2026-09-19T15:00:00Z'),
    (1, 'A-1', 'eng-a', 'r1', 50, 50, 0, 0, 0.5, true, 'haiku', 'harness', 'anthropic', '2026-09-19T15:00:00Z'),
    (2, 'A-2', 'eng-a', 'r1', 200, 100, 700, 0, NULL, false, 'sonnet', 'harness', 'anthropic', '2026-09-12T13:00:00Z'),
    (2, 'A-2', 'eng-a', 'r1', 100, 100, 300, 0, NULL, false, 'sonnet', 'harness', 'anthropic', '2026-09-13T13:00:00Z'),
    (3, 'A-3', 'eng-a', 'r1', 900, 100, 0, 0, 9, true, 'sonnet', 'harness', 'anthropic', '2026-06-25T13:00:00Z'),
    (0, 'A-1', 'eng-a', 'control-plane', 40, 10, 0, 0, NULL, false, 'gpt-5', 'control-plane', 'openai', '2026-09-19T12:00:00Z'),
    (0, 'A-4', 'eng-a', 'control-plane', 30, 20, 0, 0, NULL, false, 'gpt-5', 'control-plane', 'openai', '2026-09-19T12:30:00Z')`);
});

describe('pure helpers', () => {
  it('parses ranges with a 30d default and computes the window start', () => {
    expect(parseRange('7d')).toBe('7d');
    expect(parseRange('bogus')).toBe('30d');
    expect(parseRange(undefined)).toBe('30d');
    expect(rangeSince('all', NOW)).toBeNull();
    expect(rangeSince('7d', NOW)?.toISOString()).toBe('2026-09-16T12:00:00.000Z');
  });

  it('nearest-rank percentile', () => {
    expect(percentile([], 0.9)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([10, 1], 0.5)).toBe(1);
  });

  it('cycle time = creation → done, per completion week, in the window', () => {
    const rows = [
      { key: 'x', status: 'done', createdAt: '2026-09-18T12:00:00Z', doneAt: '2026-09-20T12:00:00Z' }, // 48h
      { key: 'y', status: 'done', createdAt: '2026-09-10T12:00:00Z', doneAt: '2026-09-14T12:00:00Z' }, // 96h
      { key: 'z', status: 'done', createdAt: '2026-06-01T12:00:00Z', doneAt: '2026-07-01T12:00:00Z' }, // outside
      { key: 'o', status: 'backlog', createdAt: '2026-09-01T12:00:00Z', doneAt: null },
    ];
    const { byWeek, summary } = cycleTimes(rows, rangeSince('30d', NOW));
    expect(summary).toEqual({ medianHrs: 72, p90Hrs: 96, samples: 2 });
    // Both completions fall in the ISO week starting Monday 2026-09-14.
    expect(byWeek).toEqual([{ week: '2026-09-14', medianHrs: 72, p90Hrs: 96, samples: 2 }]);
  });

  it('flow: open at end of day and completions per day', () => {
    const rows = [
      { key: 'a', status: 'done', createdAt: '2026-09-20T08:00:00Z', doneAt: '2026-09-21T08:00:00Z' },
      { key: 'b', status: 'backlog', createdAt: '2026-09-21T08:00:00Z', doneAt: null },
      { key: 'p', status: 'proposed', createdAt: '2026-09-20T08:00:00Z', doneAt: null },
    ];
    const flow = flowSeries(rows, new Date('2026-09-20T00:00:00Z'), new Date('2026-09-22T12:00:00Z'));
    expect(flow).toEqual([
      { date: '2026-09-20', open: 1, done: 0 },
      { date: '2026-09-21', open: 1, done: 1 },
      { date: '2026-09-22', open: 1, done: 0 },
    ]);
    expect(flowSeries([], null, NOW)).toEqual([]);
  });
});

describe('loadMetrics (pg-mem)', () => {
  it('aggregates all three sections over a 30d window', async () => {
    const r = await loadMetrics(q, '30d', null, NOW);
    expect(r.since).toBe('2026-08-24T12:00:00.000Z');

    // Projects: current counts, done-in-range per project.
    expect(r.projects.map((p) => [p.id, p.open, p.review, p.done, p.proposed, p.total, p.doneInRange])).toEqual([
      ['eng-a', 1, 0, 4, 0, 5, 3],
      ['eng-b', 0, 1, 0, 1, 2, 0],
    ]);
    expect(r.velocity.status).toEqual({ backlog: 1, progress: 0, review: 1, deploying: 0, done: 4, proposed: 1 });

    // Done per ISO week inside the window (A-3 in July is out).
    expect(r.velocity.doneByWeek).toEqual([
      { week: '2026-09-14', done: 3 },
    ]);
    // Cycle time: A-1 48h, A-2 96h, A-5 12h → median 48, p90 96.
    expect(r.velocity.cycle).toEqual({ medianHrs: 48, p90Hrs: 96, samples: 3 });
    expect(r.velocity.flow[r.velocity.flow.length - 1]).toEqual({ date: '2026-09-23', open: 2, done: 0 });
    expect(r.velocity.flow[0].date).toBe('2026-08-24');

    // Tokens: task 1 counts its two final rows only; task 2 its two per-turn
    // rows; task 3 is out of range; both control-plane calls count once each.
    expect(r.tokens.perDay).toEqual([
      { date: '2026-09-12', source: 'harness', provider: 'anthropic', model: 'sonnet', tokens: 1000, input: 200, output: 100, cacheRead: 700, cacheCreate: 0, cost: null, runs: 1, calls: 0 },
      { date: '2026-09-13', source: 'harness', provider: 'anthropic', model: 'sonnet', tokens: 500, input: 100, output: 100, cacheRead: 300, cacheCreate: 0, cost: null, runs: 1, calls: 0 },
      { date: '2026-09-19', source: 'control-plane', provider: 'openai', model: 'gpt-5', tokens: 100, input: 70, output: 30, cacheRead: 0, cacheCreate: 0, cost: null, runs: 0, calls: 2 },
      { date: '2026-09-19', source: 'harness', provider: 'anthropic', model: 'haiku', tokens: 100, input: 50, output: 50, cacheRead: 0, cacheCreate: 0, cost: 0.5, runs: 1, calls: 0 },
      { date: '2026-09-19', source: 'harness', provider: 'anthropic', model: 'sonnet', tokens: 3700, input: 100, output: 400, cacheRead: 3000, cacheCreate: 200, cost: 2.5, runs: 1, calls: 0 },
    ]);
    expect(r.tokens.totals).toEqual({ input: 520, output: 680, cacheRead: 4000, cacheCreate: 200, tokens: 5400, cost: 3, runs: 2, controlPlaneCalls: 2 });
    expect(r.tokens.bySource).toEqual({ harness: 5300, controlPlane: 100 });
    expect(r.tokens.cacheHitRatio).toBeCloseTo(4000 / 4520, 3);
    expect(r.tokens.topTickets).toEqual([
      { key: 'A-1', title: 'Login', engagementId: 'eng-a', tokens: 3850, cost: 3, runs: 1 },
      { key: 'A-2', title: 'Billing', engagementId: 'eng-a', tokens: 1500, cost: null, runs: 1 },
      { key: 'A-4', title: 'Open', engagementId: 'eng-a', tokens: 50, cost: null, runs: 0 },
    ]);

    // Efficiency: agent-delivered done tickets in the window — A-1 (actual 1.5h vs 8h) and A-2 (no actual → est 1h vs 4h); A-5 was human work.
    expect(r.efficiency.perWeek).toEqual([{ week: '2026-09-14', tickets: 2, agentHrs: 2.5, humanHrs: 12, withActual: 1 }]);
    expect(r.efficiency.totals).toEqual({ tickets: 2, agentHrs: 2.5, humanHrs: 12, withActual: 1 });
  });

  it('scopes every section to one engagement', async () => {
    const r = await loadMetrics(q, 'all', 'eng-b', NOW);
    expect(r.projects.map((p) => p.id)).toEqual(['eng-b']);
    expect(r.velocity.doneByWeek).toEqual([]);
    expect(r.velocity.cycle.samples).toBe(0);
    expect(r.tokens.perDay).toEqual([]);
    expect(r.tokens.totals.runs).toBe(0);
    expect(r.tokens.bySource).toEqual({ harness: 0, controlPlane: 0 });
    expect(r.tokens.cacheHitRatio).toBeNull();
    expect(r.efficiency.perWeek).toEqual([]);
  });

  it('`all` includes the old work and a range never touches current status counts', async () => {
    const r = await loadMetrics(q, 'all', null, NOW);
    expect(r.since).toBeNull();
    expect(r.velocity.doneByWeek).toEqual([
      { week: '2026-06-29', done: 1 },
      { week: '2026-09-14', done: 3 },
    ]);
    expect(r.tokens.totals.cost).toBe(12);
    expect(r.tokens.totals.runs).toBe(3);
    expect(r.efficiency.totals).toEqual({ tickets: 3, agentHrs: 4.5, humanHrs: 24, withActual: 2 });
    const week = await loadMetrics(q, '7d', null, NOW);
    expect(week.velocity.status).toEqual(r.velocity.status);
    expect(week.efficiency.totals.tickets).toBe(1);
  });

  it('survives empty tables', async () => {
    for (const t of ['run_token_usage', 'agent_tasks', 'ticket_events', 'tickets', 'engagements']) await q(`DELETE FROM app.${t}`);
    const r = await loadMetrics(q, '90d', null, NOW);
    expect(r.projects).toEqual([]);
    expect(r.velocity).toEqual({
      doneByWeek: [],
      cycleByWeek: [],
      cycle: { medianHrs: null, p90Hrs: null, samples: 0 },
      flow: [],
      status: { backlog: 0, progress: 0, review: 0, deploying: 0, done: 0, proposed: 0 },
    });
    expect(r.tokens).toEqual({
      perDay: [],
      topTickets: [],
      totals: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, tokens: 0, cost: null, runs: 0, controlPlaneCalls: 0 },
      bySource: { harness: 0, controlPlane: 0 },
      cacheHitRatio: null,
    });
    expect(r.efficiency).toEqual({ perWeek: [], totals: { tickets: 0, agentHrs: 0, humanHrs: 0, withActual: 0 } });
  });
});
