import type express from 'express';
import { z } from 'zod';
import type { Identity } from './roles';

/**
 * Project agents: the entities behind the /agents architecture map. Two kinds
 * of records feed the overview:
 *
 * - Configured agents (app.project_agents): created through the scaffolded
 *   "Deploy agent" flow. Today the deploy endpoint is a stub — it persists the
 *   submitted configuration as a placeholder record and posts a feed item;
 *   actual rollout to a runner fleet is future work. The table already carries
 *   agent_type values for future node kinds (model serving endpoints,
 *   AgentBricks, Foundry agents) so those can light up without a migration.
 *
 * - Observed runners: derived from app.agent_tasks history — any runner that
 *   ever claimed work on an engagement shows up as a live agent node with its
 *   task counts and last-seen time. This is the "real data" half of the map.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const PROJECT_AGENTS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.project_agents (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    agent_type TEXT NOT NULL DEFAULT 'runner',
    harness TEXT,
    model_provider TEXT,
    model TEXT,
    endpoint_type TEXT,
    status TEXT NOT NULL DEFAULT 'configured',
    config JSONB NOT NULL DEFAULT '{}',
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

/** Node kinds the map renders; only 'runner' has a real deploy path today. */
export const AGENT_TYPES = ['runner', 'serving-endpoint', 'agentbricks', 'foundry'] as const;

const DeployAgentBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    agentType: z.enum(AGENT_TYPES).default('runner'),
    harness: z.string().trim().max(40).optional(),
    modelProvider: z.string().trim().max(40).optional(),
    model: z.string().trim().max(80).optional(),
    endpointType: z.string().trim().max(40).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((b) => b.agentType !== 'runner' || b.harness || b.modelProvider, {
    message: 'A runner needs a harness or a model provider',
  });

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

/**
 * Every runner in the fleet today is a Claude Code instance (see
 * RunnerLogo.tsx client-side); named harnesses in the runner id override that
 * default as other harness types come online.
 */
export function inferHarness(agentName: string): string {
  const n = agentName.toLowerCase();
  if (n.includes('codex')) return 'codex';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('copilot')) return 'copilot';
  if (n.includes('cursor')) return 'cursor';
  return 'claude-code';
}

/** Default model provider behind each harness, for logo fallback and grouping. */
const HARNESS_PROVIDER: Record<string, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  gemini: 'google',
  copilot: 'microsoft',
  cursor: 'anysphere',
};

export interface OverviewAgent {
  id: string;
  engagementId: string;
  name: string;
  agentType: string;
  harness: string | null;
  modelProvider: string | null;
  model: string | null;
  endpointType: string | null;
  status: string;
  source: 'configured' | 'observed';
  tasks: number;
  activeTasks: number;
  lastSeen: string | null;
  createdAt: string | null;
}

export interface OverviewProject {
  id: string;
  client: string;
  name: string;
  health: string;
  phase: string;
}

/** One payload for the whole map: every project plus every agent tied to one. */
export async function loadAgentsOverview(q: Query): Promise<{ projects: OverviewProject[]; agents: OverviewAgent[] }> {
  const projects = (
    await q('SELECT id, client, name, health, phase FROM app.engagements ORDER BY created_at, id')
  ).rows.map((r) => ({
    id: txt(r.id),
    client: txt(r.client),
    name: txt(r.name),
    health: txt(r.health) || 'ok',
    phase: txt(r.phase),
  }));

  const configured: OverviewAgent[] = (await q('SELECT * FROM app.project_agents ORDER BY id')).rows.map((r) => ({
    id: `cfg-${num(r.id)}`,
    engagementId: txt(r.engagement_id),
    name: txt(r.name),
    agentType: txt(r.agent_type) || 'runner',
    harness: r.harness == null ? null : txt(r.harness),
    modelProvider: r.model_provider == null ? null : txt(r.model_provider),
    model: r.model == null ? null : txt(r.model),
    endpointType: r.endpoint_type == null ? null : txt(r.endpoint_type),
    status: txt(r.status) || 'configured',
    source: 'configured',
    tasks: 0,
    activeTasks: 0,
    lastSeen: null,
    createdAt: iso(r.created_at),
  }));

  // Real runner history: one node per (engagement, runner) that has ever
  // claimed work there. Active = currently holding a claimed/working task.
  const observed: OverviewAgent[] = (
    await q(
      `SELECT engagement_id, agent,
              COUNT(*)::int AS tasks,
              SUM(CASE WHEN state IN ('claimed','working') THEN 1 ELSE 0 END)::int AS active_tasks,
              MAX(COALESCE(last_heartbeat, updated_at, created_at)) AS last_seen
       FROM app.agent_tasks
       WHERE agent IS NOT NULL AND agent <> ''
       GROUP BY engagement_id, agent
       ORDER BY engagement_id, agent`,
    )
  ).rows.map((r) => {
    const name = txt(r.agent);
    const harness = inferHarness(name);
    return {
      id: `run-${txt(r.engagement_id)}-${name}`,
      engagementId: txt(r.engagement_id),
      name,
      agentType: 'runner',
      harness,
      modelProvider: HARNESS_PROVIDER[harness] ?? null,
      model: null,
      endpointType: null,
      status: num(r.active_tasks) > 0 ? 'active' : 'idle',
      source: 'observed' as const,
      tasks: num(r.tasks),
      activeTasks: num(r.active_tasks),
      lastSeen: iso(r.last_seen),
      createdAt: null,
    };
  });

  // A runner that was configured here AND has task history shows once: the
  // observed node wins (it carries live activity).
  const observedKeys = new Set(observed.map((a) => `${a.engagementId} ${a.name.toLowerCase()}`));
  const agents = [
    ...observed,
    ...configured.filter((a) => a.agentType !== 'runner' || !observedKeys.has(`${a.engagementId} ${a.name.toLowerCase()}`)),
  ];
  return { projects, agents };
}

export function setupProjectAgentRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>,
) {
  app.get('/api/agents/overview', async (_req, res) => {
    try {
      res.json(await loadAgentsOverview(q));
    } catch (err) {
      console.error('agents overview failed:', err);
      res.status(500).json({ error: 'Failed to load the agent map' });
    }
  });

  /**
   * Scaffolded deploy endpoint: validates and persists the submitted agent
   * configuration as a placeholder record. Full deployment (provisioning a
   * devbox runner with this config) is intentionally out of scope — the
   * record's 'configured' status is what the map renders as "not live yet".
   */
  app.post('/api/projects/:id/agents', async (req, res) => {
    const parsed = DeployAgentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid agent configuration' });
      return;
    }
    try {
      const engId = req.params.id;
      const eng = (await q('SELECT id, client FROM app.engagements WHERE id = $1', [engId])).rows[0];
      if (!eng) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const who = await requireLead(req, res, engId);
      if (!who) return;
      const { name, agentType, harness, modelProvider, model, endpointType, notes } = parsed.data;
      if (agentType !== 'runner') {
        // Future node types are visible in the picker but not deployable yet.
        res.status(422).json({ error: 'Only harness runners can be configured today — endpoint types are coming soon' });
        return;
      }
      const inserted = await q(
        `INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider, model, endpoint_type, config, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          engId,
          name,
          agentType,
          harness ?? null,
          modelProvider ?? null,
          model ?? null,
          endpointType ?? null,
          JSON.stringify(notes ? { notes } : {}),
          who.email,
        ],
      );
      console.log(`[agents] configured agent '${name}' (${harness ?? modelProvider ?? agentType}) for ${engId} — deployment stubbed`);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [engId, `Configured agent ${name}${harness ? ` (${harness})` : ''} — deployment pending rollout.`],
      );
      res.status(201).json(inserted.rows[0]);
    } catch (err) {
      console.error('deploy agent failed:', err);
      res.status(500).json({ error: 'Failed to save the agent configuration' });
    }
  });
}
