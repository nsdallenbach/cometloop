import type express from 'express';
import { z } from 'zod';
import type { Caller } from './roles';
import { inferHarness } from './agents';

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const GENERAL_CODING_MODELS = ['claude-code', 'codex', 'omnigent', 'gemini', 'copilot', 'cursor'] as const;

export const RUNNER_LOAD_BALANCING_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.runner_load_balancing (
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    model_type TEXT NOT NULL,
    runner_name TEXT NOT NULL,
    weight INT NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),
    concurrency_cap INT CHECK (concurrency_cap BETWEEN 1 AND 100),
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (engagement_id, model_type, runner_name)
  )`,
];

export const RunnerLoadBalancingBody = z.object({
  runners: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        weight: z.number().int().min(0).max(100),
        cap: z.number().int().min(1).max(100).nullable(),
      })
    )
    .min(1)
    .max(100)
    .refine(
      (rows) => new Set(rows.map((r) => r.name.toLowerCase())).size === rows.length,
      'Runner names must be unique'
    )
    .refine((rows) => rows.some((r) => r.weight > 0), 'At least one runner must have a positive weight'),
});

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const normalizeModelType = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

export function isGeneralCodingModel(modelType: string | null | undefined): boolean {
  return Boolean(modelType && (GENERAL_CODING_MODELS as readonly string[]).includes(normalizeModelType(modelType)));
}

async function availableRunners(q: Query, engagementId: string, modelType: string) {
  return (
    await q(
      `SELECT pa.name, pa.status, lb.weight, lb.concurrency_cap,
              COALESCE(active.active_tasks, 0)::int AS active_tasks
       FROM app.project_agents pa
       LEFT JOIN app.runner_load_balancing lb
         ON lb.engagement_id = pa.engagement_id AND lb.model_type = $2 AND lower(lb.runner_name) = lower(pa.name)
       LEFT JOIN (
         SELECT agent, COUNT(*)::int AS active_tasks
         FROM app.agent_tasks WHERE engagement_id = $1 AND state IN ('claimed','working') GROUP BY agent
       ) active ON lower(active.agent) = lower(pa.name)
       WHERE pa.engagement_id = $1 AND pa.agent_type = 'runner' AND pa.harness = $2
         AND pa.status IN ('active','idle')
       ORDER BY pa.name`,
      [engagementId, modelType]
    )
  ).rows.map((r) => ({
    name: txt(r.name),
    status: txt(r.status),
    weight: r.weight == null ? 1 : num(r.weight),
    cap: r.concurrency_cap == null ? null : num(r.concurrency_cap),
    activeTasks: num(r.active_tasks),
  }));
}

export function setupRunnerLoadBalancingRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>
) {
  app.get('/api/projects/:id/runner-load-balancing/:modelType', async (req, res) => {
    const modelType = normalizeModelType(req.params.modelType);
    if (!isGeneralCodingModel(modelType)) {
      res.status(404).json({ error: 'Load balancing is only available for general coding models' });
      return;
    }
    try {
      res.json({ modelType, runners: await availableRunners(q, req.params.id, modelType) });
    } catch (err) {
      console.error('read runner load balancing failed:', err);
      res.status(500).json({ error: 'Failed to load available runners' });
    }
  });

  app.put('/api/projects/:id/runner-load-balancing/:modelType', async (req, res) => {
    const modelType = normalizeModelType(req.params.modelType);
    if (!isGeneralCodingModel(modelType)) {
      res.status(404).json({ error: 'Load balancing is only available for general coding models' });
      return;
    }
    const parsed = RunnerLoadBalancingBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid runner load-balancing configuration' });
      return;
    }
    const identity = await requireLead(req, res, req.params.id);
    if (!identity) return;
    try {
      const available = await availableRunners(q, req.params.id, modelType);
      const names = new Set(available.map((r) => r.name.toLowerCase()));
      if (parsed.data.runners.some((r) => !names.has(r.name.toLowerCase()))) {
        res
          .status(400)
          .json({ error: 'Configuration contains a runner that is not currently available for this model' });
        return;
      }
      for (const runner of parsed.data.runners) {
        await q(
          `INSERT INTO app.runner_load_balancing
             (engagement_id, model_type, runner_name, weight, concurrency_cap, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (tenant_id, engagement_id, model_type, runner_name)
           DO UPDATE SET weight = $4, concurrency_cap = $5, updated_by = $6, updated_at = NOW()`,
          [req.params.id, modelType, runner.name, runner.weight, runner.cap, identity.email]
        );
      }
      await q(
        `DELETE FROM app.runner_load_balancing
         WHERE engagement_id = $1 AND model_type = $2 AND NOT (runner_name = ANY($3))`,
        [req.params.id, modelType, parsed.data.runners.map((runner) => runner.name)]
      );
      res.json({ modelType, runners: await availableRunners(q, req.params.id, modelType) });
    } catch (err) {
      console.error('save runner load balancing failed:', err);
      res.status(500).json({ error: 'Failed to save runner load balancing' });
    }
  });
}

/**
 * Pull-based weighted fair scheduling. Counts reset when the pool is saved;
 * the lowest assignments/weight score gets the next claim. A cap limits only
 * concurrent claimed/working tasks. No saved pool means legacy first-come behavior.
 */
export async function runnerCanClaim(q: Query, engagementId: string, runnerName: string): Promise<boolean> {
  const modelType = inferHarness(runnerName);
  if (!isGeneralCodingModel(modelType)) return true;
  const configs = (
    await q(
      `SELECT runner_name, weight, concurrency_cap, updated_at
       FROM app.runner_load_balancing WHERE engagement_id = $1 AND model_type = $2 ORDER BY runner_name`,
      [engagementId, modelType]
    )
  ).rows;
  if (configs.length === 0) return true;
  const requested = configs.find((r) => txt(r.runner_name).toLowerCase() === runnerName.toLowerCase());
  if (!requested || num(requested.weight) <= 0) return false;

  const active = (
    await q(
      `SELECT agent, COUNT(*)::int AS count FROM app.agent_tasks
       WHERE engagement_id = $1 AND state IN ('claimed','working') GROUP BY agent`,
      [engagementId]
    )
  ).rows;
  const activeByRunner = new Map(active.map((r) => [txt(r.agent).toLowerCase(), num(r.count)]));
  const cap = requested.concurrency_cap == null ? null : num(requested.concurrency_cap);
  if (cap !== null && (activeByRunner.get(runnerName.toLowerCase()) ?? 0) >= cap) return false;

  const since = configs.reduce((oldest, r) => {
    const value = r.updated_at instanceof Date ? r.updated_at.toISOString() : txt(r.updated_at);
    return !oldest || (value && value < oldest) ? value : oldest;
  }, '');
  const dispatched = (
    await q(
      `SELECT agent, COUNT(*)::int AS count FROM app.agent_tasks
       WHERE engagement_id = $1 AND claimed_at >= $2 GROUP BY agent`,
      [engagementId, since]
    )
  ).rows;
  const counts = new Map(dispatched.map((r) => [txt(r.agent).toLowerCase(), num(r.count)]));
  const scores = configs
    .filter((r) => num(r.weight) > 0)
    .filter((r) => {
      const configuredCap = r.concurrency_cap == null ? null : num(r.concurrency_cap);
      return configuredCap === null || (activeByRunner.get(txt(r.runner_name).toLowerCase()) ?? 0) < configuredCap;
    })
    .map((r) => ({
      name: txt(r.runner_name).toLowerCase(),
      score: (counts.get(txt(r.runner_name).toLowerCase()) ?? 0) / num(r.weight),
    }));
  const minimum = Math.min(...scores.map((r) => r.score));
  return scores.some((r) => r.name === runnerName.toLowerCase() && r.score <= minimum);
}
