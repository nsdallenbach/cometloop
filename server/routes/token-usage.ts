import { z } from 'zod';
import type express from 'express';

/**
 * Live token consumption (DAT-266): harness adapters surface per-turn usage
 * from their event streams (claude: every assistant event + authoritative
 * final totals with cost; codex: per turn.completed), runners batch it here,
 * and it lands in Lakebase — the ticket drawer, the agent map, and the beta
 * dashboard (Lakehouse-Federation path) all read from the same rows.
 *
 * Semantics: non-final samples ACCUMULATE onto the task's rollup columns;
 * a final sample REPLACES them (it is the harness's own cumulative count, so
 * dropped batches can never leave the rollup short). Usage is telemetry —
 * losing a batch costs accuracy until the final sample, never a run.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const TOKEN_USAGE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.run_token_usage (
    id SERIAL PRIMARY KEY,
    task_id INT NOT NULL,
    ticket_key TEXT NOT NULL DEFAULT '',
    engagement_id TEXT NOT NULL DEFAULT '',
    agent TEXT NOT NULL DEFAULT '',
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    cache_create_tokens BIGINT NOT NULL DEFAULT 0,
    cost_usd DOUBLE PRECISION,
    final BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS run_token_usage_task ON app.run_token_usage (task_id, id)`,
  `CREATE INDEX IF NOT EXISTS run_token_usage_agent_time ON app.run_token_usage (agent, created_at)`,
  // Rollups live on the task row (app SP owns agent_tasks — boot ALTERs work).
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS tokens_in BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS tokens_out BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS tokens_cache_read BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION`,
];

const Sample = z.object({
  input: z.number().int().min(0).max(1_000_000_000),
  output: z.number().int().min(0).max(1_000_000_000),
  cacheRead: z.number().int().min(0).max(1_000_000_000).default(0),
  cacheCreate: z.number().int().min(0).max(1_000_000_000).default(0),
  costUsd: z.number().min(0).max(100_000).optional(),
  final: z.boolean().optional(),
});

const UsageBody = z.object({
  agent: z.string().min(1).max(80),
  samples: z.array(Sample).min(1).max(200),
});

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  costUsd: number | null;
}

/**
 * Fold a batch into one insert + one rollup update. Exported for the pg-mem
 * test; the route is a thin wrapper around it.
 */
export async function recordUsageBatch(
  q: Query,
  task: { id: number; ticketKey: string; engagementId: string },
  agent: string,
  samples: z.infer<typeof Sample>[],
): Promise<void> {
  // One row per batch keeps the table small at 4s cadence; the final sample
  // gets its own row so the dashboard can find authoritative totals.
  const finals = samples.filter((s) => s.final);
  const partials = samples.filter((s) => !s.final);

  if (partials.length > 0) {
    const sum = (k: 'input' | 'output' | 'cacheRead' | 'cacheCreate') => partials.reduce((a, s) => a + s[k], 0);
    const row = { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheCreate: sum('cacheCreate') };
    await q(
      `INSERT INTO app.run_token_usage (task_id, ticket_key, engagement_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [task.id, task.ticketKey, task.engagementId, agent, row.input, row.output, row.cacheRead, row.cacheCreate],
    );
    await q(
      `UPDATE app.agent_tasks SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3,
         tokens_cache_read = tokens_cache_read + $4, updated_at = NOW() WHERE id = $1`,
      [task.id, row.input, row.output, row.cacheRead],
    );
  }

  // Final totals replace the accumulation — the harness counted the whole run.
  const final = finals[finals.length - 1];
  if (final) {
    await q(
      `INSERT INTO app.run_token_usage (task_id, ticket_key, engagement_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, final)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,
      [task.id, task.ticketKey, task.engagementId, agent, final.input, final.output, final.cacheRead, final.cacheCreate, final.costUsd ?? null],
    );
    await q(
      `UPDATE app.agent_tasks SET tokens_in = $2, tokens_out = $3, tokens_cache_read = $4, cost_usd = $5, updated_at = NOW() WHERE id = $1`,
      [task.id, final.input, final.output, final.cacheRead, final.costUsd ?? null],
    );
  }
}

/** Per-agent totals over a trailing window — the agent map's badge (DAT-266). */
export async function usageByAgent(q: Query, hours: number): Promise<Map<string, UsageTotals>> {
  const { rows } = await q(
    `SELECT agent,
            SUM(CASE WHEN final THEN 0 ELSE input_tokens END) AS input_tokens,
            SUM(CASE WHEN final THEN 0 ELSE output_tokens END) AS output_tokens,
            SUM(CASE WHEN final THEN 0 ELSE cache_read_tokens END) AS cache_read_tokens,
            SUM(CASE WHEN final THEN 0 ELSE cache_create_tokens END) AS cache_create_tokens,
            SUM(cost_usd) AS cost_usd
     FROM app.run_token_usage
     WHERE created_at >= NOW() - ($1 || ' hours')::interval
     GROUP BY agent`,
    [String(Math.min(720, Math.max(1, Math.round(hours))))],
  );
  const out = new Map<string, UsageTotals>();
  for (const r of rows) {
    out.set(String(r.agent), {
      input: Number(r.input_tokens ?? 0),
      output: Number(r.output_tokens ?? 0),
      cacheRead: Number(r.cache_read_tokens ?? 0),
      cacheCreate: Number(r.cache_create_tokens ?? 0),
      costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    });
  }
  return out;
}

export function setupTokenUsageRoutes(app: express.Application, q: Query): void {
  app.post('/api/agent/work/:id/usage', async (req, res) => {
    const parsed = UsageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent and samples (1-200) are required' });
      return;
    }
    try {
      const task = (
        await q(`SELECT id, ticket_key, engagement_id, agent FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [
          Number(req.params.id),
        ])
      ).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      if (String(task.agent) !== parsed.data.agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
      await recordUsageBatch(
        q,
        { id: Number(task.id), ticketKey: String(task.ticket_key), engagementId: String(task.engagement_id) },
        parsed.data.agent,
        parsed.data.samples,
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('usage batch failed:', err);
      res.status(500).json({ error: 'Failed to record token usage' });
    }
  });
}
