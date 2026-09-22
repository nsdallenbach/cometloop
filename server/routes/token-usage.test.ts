import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { TOKEN_USAGE_SCHEMA_SQL, foldTicketUsage, recordUsageBatch, usageByAgent, usageByTicket } from './token-usage';

/**
 * Token-usage rollups (DAT-266) against pg-mem: partial samples accumulate
 * onto the task row, a final sample replaces the accumulation (the harness
 * counted the whole run — dropped batches can never leave the rollup short),
 * and the per-agent window query feeds the agent map without double-counting
 * final rows.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, state TEXT NOT NULL,
     tokens_in BIGINT NOT NULL DEFAULT 0, tokens_out BIGINT NOT NULL DEFAULT 0, tokens_cache_read BIGINT NOT NULL DEFAULT 0,
     cost_usd DOUBLE PRECISION, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
];

// The real schema's CREATE TABLE runs verbatim; the agent_tasks ALTERs are
// covered by the stand-in table above (pg-mem applies them as no-ops there).
const USAGE_TABLE_SQL = TOKEN_USAGE_SCHEMA_SQL.filter((s) => !s.startsWith('ALTER TABLE app.agent_tasks'));

let q: Query;
const TASK = { id: 1, ticketKey: 'DAT-266', engagementId: 'exec' };

const taskRow = async () => (await q('SELECT tokens_in, tokens_out, tokens_cache_read, cost_usd FROM app.agent_tasks WHERE id = 1')).rows[0];

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...USAGE_TABLE_SQL]) await q(sql);
  await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state) VALUES ('DAT-266', 'exec', 'working')`);
});

describe('recordUsageBatch', () => {
  it('accumulates partial samples onto the task rollup', async () => {
    await recordUsageBatch(q, TASK, 'desktop-X-claude-1', [
      { input: 100, output: 20, cacheRead: 500, cacheCreate: 10 },
      { input: 50, output: 30, cacheRead: 200, cacheCreate: 0 },
    ]);
    await recordUsageBatch(q, TASK, 'desktop-X-claude-1', [{ input: 25, output: 5, cacheRead: 0, cacheCreate: 0 }]);
    const row = await taskRow();
    expect(Number(row.tokens_in)).toBe(175);
    expect(Number(row.tokens_out)).toBe(55);
    expect(Number(row.tokens_cache_read)).toBe(700);
    expect(row.cost_usd).toBeNull();
  });

  it('a final sample replaces the accumulation and records cost', async () => {
    await recordUsageBatch(q, TASK, 'desktop-X-claude-1', [{ input: 100, output: 20, cacheRead: 0, cacheCreate: 0 }]);
    // Harness's own cumulative count is higher (a dropped batch in between).
    await recordUsageBatch(q, TASK, 'desktop-X-claude-1', [
      { input: 400, output: 90, cacheRead: 1200, cacheCreate: 40, costUsd: 1.23, final: true },
    ]);
    const row = await taskRow();
    expect(Number(row.tokens_in)).toBe(400);
    expect(Number(row.tokens_out)).toBe(90);
    expect(Number(row.tokens_cache_read)).toBe(1200);
    expect(Number(row.cost_usd)).toBeCloseTo(1.23);
  });

  it('windowed per-agent totals sum partials and never double-count finals', async () => {
    await recordUsageBatch(q, TASK, 'desktop-X-claude-1', [
      { input: 100, output: 20, cacheRead: 0, cacheCreate: 0 },
      { input: 100, output: 20, cacheRead: 0, cacheCreate: 0 },
    ]);
    await recordUsageBatch(q, TASK, 'desktop-X-claude-1', [
      { input: 200, output: 40, cacheRead: 0, cacheCreate: 0, costUsd: 0.5, final: true },
    ]);
    const byAgent = await usageByAgent(q, 24);
    const totals = byAgent.get('desktop-X-claude-1');
    expect(totals).toBeDefined();
    // Partial rows only for tokens (final row would double them)…
    expect(totals?.input).toBe(200);
    expect(totals?.output).toBe(40);
    // …but cost exists only on final rows, so it IS summed from them.
    expect(totals?.costUsd).toBeCloseTo(0.5);
  });
});

describe('usageByTicket (DAT-260)', () => {
  const RUN2 = { id: 2, ticketKey: 'DAT-266', engagementId: 'exec' };

  it('a ticket with no usage reads as zero, not an error', async () => {
    const u = await usageByTicket(q, 'DAT-999');
    expect(u).toEqual({ runs: 0, total: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: null }, models: [] });
  });

  it('splits a finished run by model and ignores its per-turn rows', async () => {
    await recordUsageBatch(q, TASK, 'a', [{ input: 100, output: 20, cacheRead: 0, cacheCreate: 0, model: 'claude-opus-5' }]);
    await recordUsageBatch(q, TASK, 'a', [
      {
        input: 400, output: 90, cacheRead: 1000, cacheCreate: 0, costUsd: 1.5, final: true,
        byModel: [
          { model: 'claude-opus-5', input: 350, output: 80, cacheRead: 1000, cacheCreate: 0, costUsd: 1.4 },
          { model: 'claude-haiku-4-5', input: 50, output: 10, cacheRead: 0, cacheCreate: 0, costUsd: 0.1 },
        ],
      },
    ]);
    const u = await usageByTicket(q, 'DAT-266');
    expect(u.runs).toBe(1);
    expect(u.total.input).toBe(400);
    expect(u.total.costUsd).toBeCloseTo(1.5);
    expect(u.models.map((m) => [m.model, m.input])).toEqual([['claude-opus-5', 350], ['claude-haiku-4-5', 50]]);
  });

  it('adds runs together, counting per-turn rows for a run that never finished', async () => {
    await recordUsageBatch(q, TASK, 'a', [{ input: 200, output: 40, cacheRead: 0, cacheCreate: 0, costUsd: 0.5, final: true, model: 'claude-opus-5' }]);
    // Second run crashed before its final sample.
    await recordUsageBatch(q, RUN2, 'a', [
      { input: 30, output: 5, cacheRead: 0, cacheCreate: 0, model: 'claude-opus-5' },
      { input: 20, output: 5, cacheRead: 0, cacheCreate: 0, model: 'claude-opus-5' },
    ]);
    const u = await usageByTicket(q, 'DAT-266');
    expect(u.runs).toBe(2);
    expect(u.total.input).toBe(250);
    expect(u.models).toHaveLength(1);
    expect(u.models[0].runs).toBe(2);
  });

  it('usage recorded without a model lands under the empty model', () => {
    const u = foldTicketUsage([{ taskId: 1, model: '', final: true, totals: { input: 10, output: 1, cacheRead: 0, cacheCreate: 0, costUsd: null } }]);
    expect(u.models[0].model).toBe('');
    expect(u.total.costUsd).toBeNull();
  });
});
