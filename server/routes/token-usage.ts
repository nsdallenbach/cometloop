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
 *
 * Models (DAT-260): a sample may name the model that spent the tokens, and a
 * final sample may split its totals `byModel`. Rows keep the model so a ticket
 * can show what it cost across every run, per model. Rows written before this
 * have no model and read back as "unknown".
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
  // DAT-260 — the app SP created run_token_usage, so the boot ALTER works.
  `ALTER TABLE app.run_token_usage ADD COLUMN IF NOT EXISTS model TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX IF NOT EXISTS run_token_usage_ticket ON app.run_token_usage (ticket_key)`,
  // Phase 3 (platform-architecture §6): the same ledger takes the control
  // plane's own calls. `source` tells the two apart; `provider` and `role`
  // say who served the call and why it was made.
  `ALTER TABLE app.run_token_usage ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'harness'`,
  `ALTER TABLE app.run_token_usage ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE app.run_token_usage ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT ''`,
];

export const USAGE_SOURCES = ['harness', 'control-plane'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** The agent name control-plane rows carry, so the per-agent window never shows them as a runner. */
export const CONTROL_PLANE_AGENT = 'control-plane';

export interface ControlPlaneUsage {
  role: string;
  flow: string;
  provider: string;
  model: string;
  ticketKey: string;
  engagementId: string;
  usage: { input: number; output: number; cacheRead: number; cacheCreate: number };
}

/**
 * One row per server-side model call (`invokeModel`), attributed to the
 * ticket and project it was made for when the caller knew them. `task_id` is
 * 0 — there is no runner task — and the row is never `final`, so
 * `foldTicketUsage` counts it exactly once alongside the harness runs.
 */
export async function recordControlPlaneUsage(q: Query, u: ControlPlaneUsage): Promise<void> {
  const total = u.usage.input + u.usage.output + u.usage.cacheRead + u.usage.cacheCreate;
  if (total <= 0) return; // a provider that reports no usage leaves no row
  await q(
    `INSERT INTO app.run_token_usage (task_id, ticket_key, engagement_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, model, source, provider, role)
     VALUES (0,$1,$2,$3,$4,$5,$6,$7,$8,'control-plane',$9,$10)`,
    [u.ticketKey, u.engagementId, CONTROL_PLANE_AGENT, u.usage.input, u.usage.output, u.usage.cacheRead, u.usage.cacheCreate, u.model, u.provider, u.role],
  );
}

const Counts = {
  input: z.number().int().min(0).max(1_000_000_000),
  output: z.number().int().min(0).max(1_000_000_000),
  cacheRead: z.number().int().min(0).max(1_000_000_000).default(0),
  cacheCreate: z.number().int().min(0).max(1_000_000_000).default(0),
  costUsd: z.number().min(0).max(100_000).optional(),
};
const ModelName = z.string().trim().max(120);

const Sample = z.object({
  ...Counts,
  model: ModelName.optional(),
  final: z.boolean().optional(),
  /** On a final sample: the same totals split by model (claude's modelUsage). */
  byModel: z.array(z.object({ ...Counts, model: ModelName })).max(20).optional(),
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
    const sum = (of: typeof partials, k: 'input' | 'output' | 'cacheRead' | 'cacheCreate') => of.reduce((a, s) => a + s[k], 0);
    const row = { input: sum(partials, 'input'), output: sum(partials, 'output'), cacheRead: sum(partials, 'cacheRead'), cacheCreate: sum(partials, 'cacheCreate') };
    // One row per model in the batch — usually exactly one.
    const models = [...new Set(partials.map((s) => s.model ?? ''))];
    for (const model of models) {
      const of = partials.filter((s) => (s.model ?? '') === model);
      await q(
        `INSERT INTO app.run_token_usage (task_id, ticket_key, engagement_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [task.id, task.ticketKey, task.engagementId, agent, sum(of, 'input'), sum(of, 'output'), sum(of, 'cacheRead'), sum(of, 'cacheCreate'), model],
      );
    }
    await q(
      `UPDATE app.agent_tasks SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3,
         tokens_cache_read = tokens_cache_read + $4, updated_at = NOW() WHERE id = $1`,
      [task.id, row.input, row.output, row.cacheRead],
    );
  }

  // Final totals replace the accumulation — the harness counted the whole run.
  const final = finals[finals.length - 1];
  if (final) {
    // Split by model when the harness said how; otherwise one row for the run.
    const parts = final.byModel?.length ? final.byModel : [{ ...final, model: final.model ?? '' }];
    for (const part of parts) {
      await q(
        `INSERT INTO app.run_token_usage (task_id, ticket_key, engagement_id, agent, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, final, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)`,
        [task.id, task.ticketKey, task.engagementId, agent, part.input, part.output, part.cacheRead, part.cacheCreate, part.costUsd ?? null, part.model],
      );
    }
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
     WHERE created_at >= NOW() - ($1 || ' hours')::interval AND source = 'harness'
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

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface TicketUsage {
  /** Agent runs that reported any usage. */
  runs: number;
  /** Server-side model calls (planning, estimate, review, draft) made for the ticket. */
  controlPlaneCalls: number;
  total: UsageTotals;
  /** Largest first; model is '' for usage recorded before models were tracked. */
  models: (UsageTotals & { model: string; provider: string; runs: number })[];
  /** The same total split by where it was spent. */
  bySource: { harness: UsageTotals; controlPlane: UsageTotals };
}

interface UsageRow {
  taskId: number;
  model: string;
  provider: string;
  source: UsageSource;
  final: boolean;
  /** Control-plane rows: how many calls the row aggregates. */
  calls: number;
  totals: UsageTotals;
}

const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: null });
function addTotals(into: UsageTotals, t: UsageTotals): void {
  into.input += t.input;
  into.output += t.output;
  into.cacheRead += t.cacheRead;
  into.cacheCreate += t.cacheCreate;
  if (t.costUsd != null) into.costUsd = (into.costUsd ?? 0) + t.costUsd;
}
const tokenSum = (t: UsageTotals): number => t.input + t.output + t.cacheRead + t.cacheCreate;

/**
 * Fold a ticket's usage rows into totals per model (DAT-260). A run that
 * finished has final rows — the harness's own count — and those stand alone;
 * a run that never finished (crashed, cancelled, still going) only has its
 * per-turn rows, so those are what count for it. Never both for one run.
 */
export function foldTicketUsage(rows: UsageRow[]): TicketUsage {
  const harness = rows.filter((r) => r.source === 'harness');
  const finished = new Set(harness.filter((r) => r.final).map((r) => r.taskId));
  // Control-plane rows are never final and have no run: every one counts.
  const counted = [...harness.filter((r) => r.final === finished.has(r.taskId)), ...rows.filter((r) => r.source === 'control-plane')];
  const total = emptyTotals();
  const bySource = { harness: emptyTotals(), controlPlane: emptyTotals() };
  const byModel = new Map<string, { model: string; provider: string; totals: UsageTotals; tasks: Set<number> }>();
  let controlPlaneCalls = 0;
  for (const r of counted) {
    addTotals(total, r.totals);
    addTotals(r.source === 'harness' ? bySource.harness : bySource.controlPlane, r.totals);
    if (r.source === 'control-plane') controlPlaneCalls += r.calls;
    const key = `${r.provider} ${r.model}`;
    const m = byModel.get(key) ?? { model: r.model, provider: r.provider, totals: emptyTotals(), tasks: new Set<number>() };
    addTotals(m.totals, r.totals);
    if (r.source === 'harness') m.tasks.add(r.taskId);
    byModel.set(key, m);
  }
  const models = [...byModel.values()]
    .map((m) => ({ model: m.model, provider: m.provider, runs: m.tasks.size, ...m.totals }))
    .sort((a, b) => tokenSum(b) - tokenSum(a));
  return { runs: new Set(counted.filter((r) => r.source === 'harness').map((r) => r.taskId)).size, controlPlaneCalls, total, models, bySource };
}

export async function usageByTicket(q: Query, ticketKey: string): Promise<TicketUsage> {
  const { rows } = await q(
    `SELECT task_id, model, provider, source, final, COUNT(*)::int AS calls,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_create_tokens) AS cache_create_tokens,
            SUM(cost_usd) AS cost_usd
     FROM app.run_token_usage WHERE ticket_key = $1
     GROUP BY task_id, model, provider, source, final`,
    [ticketKey],
  );
  return foldTicketUsage(
    rows.map((r) => ({
      taskId: Number(r.task_id),
      model: str(r.model),
      provider: str(r.provider),
      source: str(r.source) === 'control-plane' ? 'control-plane' : 'harness',
      final: r.final === true,
      calls: Number(r.calls ?? 0),
      totals: {
        input: Number(r.input_tokens ?? 0),
        output: Number(r.output_tokens ?? 0),
        cacheRead: Number(r.cache_read_tokens ?? 0),
        cacheCreate: Number(r.cache_create_tokens ?? 0),
        costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
      },
    })),
  );
}

export function setupTokenUsageRoutes(app: express.Application, q: Query): void {
  // What a ticket has cost so far, across every agent run, per model (DAT-260).
  app.get('/api/tickets/:key/usage', async (req, res) => {
    try {
      res.json(await usageByTicket(q, String(req.params.key)));
    } catch (err) {
      console.error('ticket usage failed:', err);
      res.status(500).json({ error: 'Failed to load token usage' });
    }
  });

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
