import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { TOKEN_USAGE_SCHEMA_SQL, foldTicketUsage, recordControlPlaneUsage, recordUsageBatch, usageByAgent, usageByTicket } from './token-usage';
import { mergePrices, ratesOf } from '../llm/pricing';

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
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: null };
    expect(u).toEqual({ runs: 0, controlPlaneCalls: 0, total: zero, costEstimated: false, unpricedModels: [], models: [], bySource: { harness: zero, controlPlane: zero } });
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
    // Both parts carried Claude Code's own cost, so nothing is estimated.
    expect(u.total.costUsd).toBeCloseTo(1.5);
    expect(u.costEstimated).toBe(false);
    expect(u.models.map((m) => [m.model, m.input, m.costEstimated])).toEqual([['claude-opus-5', 350, false], ['claude-haiku-4-5', 50, false]]);
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
    const u = foldTicketUsage([
      { taskId: 1, model: '', provider: '', source: 'harness', final: true, calls: 1, totals: { input: 10, output: 1, cacheRead: 0, cacheCreate: 0, costUsd: null }, unpriced: { input: 10, output: 1, cacheRead: 0, cacheCreate: 0 } },
    ]);
    expect(u.models[0].model).toBe('');
    expect(u.total.costUsd).toBeNull();
    expect(u.unpricedModels).toEqual(['unknown model']);
    expect(u.models[0].unpriced).toBe(true);
  });

  it('estimates cost at the rate table it is given and names what nothing prices', async () => {
    // A codex-style run: per-turn rows, no cost, on a serving endpoint nothing prices…
    await recordUsageBatch(q, TASK, 'a', [{ input: 1_000_000, output: 100_000, cacheRead: 0, cacheCreate: 0, model: 'my-endpoint' }]);
    // …and one control-plane call on a priced model (claude-sonnet-5: $2 in, $10 out, $0.20 cache read per 1M).
    await recordControlPlaneUsage(q, {
      role: 'estimate', flow: 'estimate', provider: 'anthropic', model: 'claude-sonnet-5-20260401', ticketKey: 'DAT-266', engagementId: 'exec',
      usage: { input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheCreate: 0 },
    });
    const defaults = await usageByTicket(q, 'DAT-266');
    expect(defaults.costEstimated).toBe(true);
    expect(defaults.unpricedModels).toEqual(['my-endpoint']);
    expect(defaults.total.costUsd).toBeCloseTo(2 + 1 + 0.1, 9);
    expect(defaults.models.find((m) => m.model === 'my-endpoint')).toMatchObject({ costUsd: null, costEstimated: false, unpriced: true });
    expect(defaults.models.find((m) => m.model === 'claude-sonnet-5-20260401')).toMatchObject({ costUsd: 3.1, costEstimated: true, unpriced: false });
    // Tokens are input + output; the cache read is reported, not counted, so the endpoint's 1.1M leads.
    expect(defaults.models.map((m) => m.model)).toEqual(['my-endpoint', 'claude-sonnet-5-20260401']);

    // A workspace override prices the endpoint (and halves sonnet's input).
    const rates = ratesOf(
      mergePrices([
        { model: 'my-endpoint', inputPerM: 1, outputPerM: 4, cacheReadPerM: 0, cacheWritePerM: 0, updatedBy: 'admin', updatedAt: null },
        { model: 'claude-sonnet-5', inputPerM: 1, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, updatedBy: 'admin', updatedAt: null },
      ]),
    );
    const priced = await usageByTicket(q, 'DAT-266', rates);
    expect(priced.unpricedModels).toEqual([]);
    expect(priced.total.costUsd).toBeCloseTo(1 + 0.4 + (1 + 1 + 0.1), 9);
    expect(priced.bySource.harness.costUsd).toBeCloseTo(1.4, 9);
    expect(priced.bySource.controlPlane.costUsd).toBeCloseTo(2.1, 9);
  });

  it('counts control-plane calls for the ticket alongside the harness runs (phase 3)', async () => {
    await recordUsageBatch(q, TASK, 'a', [{ input: 200, output: 40, cacheRead: 0, cacheCreate: 0, final: true, model: 'claude-opus-5' }]);
    await recordControlPlaneUsage(q, {
      role: 'planning', flow: 'ticket-refine', provider: 'anthropic', model: 'claude-sonnet-5', ticketKey: 'DAT-266', engagementId: 'exec',
      usage: { input: 1000, output: 300, cacheRead: 50, cacheCreate: 0 },
    });
    await recordControlPlaneUsage(q, {
      role: 'estimate', flow: 'estimate', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', ticketKey: 'DAT-266', engagementId: 'exec',
      usage: { input: 400, output: 60, cacheRead: 0, cacheCreate: 0 },
    });
    const u = await usageByTicket(q, 'DAT-266');
    expect(u.runs).toBe(1);
    expect(u.controlPlaneCalls).toBe(2);
    expect(u.total.input).toBe(1600);
    expect(u.bySource.harness.input).toBe(200);
    expect(u.bySource.controlPlane.input).toBe(1400);
    expect(u.models.map((m) => [m.provider, m.model, m.runs])).toEqual([
      ['anthropic', 'claude-sonnet-5', 0],
      ['anthropic', 'claude-haiku-4-5-20251001', 0],
      ['', 'claude-opus-5', 1],
    ]);
    // No row carried a recorded cost, so every one is estimated at the defaults:
    // sonnet-5 1000×$2 + 300×$10 + 50×$0.20; haiku-4-5 400×$1 + 60×$5; opus-5 200×$5 + 40×$25 (per 1M).
    expect(u.costEstimated).toBe(true);
    expect(u.unpricedModels).toEqual([]);
    expect(u.total.costUsd).toBeCloseTo(0.00501 + 0.0007 + 0.002, 9);
    expect(u.models.find((m) => m.model === 'claude-haiku-4-5-20251001')?.costUsd).toBeCloseTo(0.0007, 9);
    // The agent map's per-agent window never shows the control plane as a runner.
    expect((await usageByAgent(q, 24)).has('control-plane')).toBe(false);
  });

  it('writes no usage row when the provider reported nothing', async () => {
    await recordControlPlaneUsage(q, { role: 'draft', flow: 'status-draft', provider: 'anthropic', model: 'm', ticketKey: '', engagementId: 'exec', usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } });
    expect((await q('SELECT COUNT(*)::int AS n FROM app.run_token_usage')).rows[0].n).toBe(0);
  });
});
