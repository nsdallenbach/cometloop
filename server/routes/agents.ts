import type express from 'express';
import { z } from 'zod';
import type { Identity } from './roles';
import { loadRunnerPolls, runnerStatus } from './fleet';
import { AGENT_SECURITY_SCHEMA_SQL, type AgentSecuritySettings, baselineSecurity, parseSecuritySettings } from './agent-security';
import { accessibleProjectIds } from './project-access';
import { usageByAgent, type UsageTotals } from './token-usage';
import { resolveAttachments, validAttachments, type RegistryMcpServer, type RegistrySkill } from './registry';

/**
 * Project agents: the entities behind the /agents architecture map. Three
 * kinds of records feed the overview:
 *
 * - Endpoint-backed agents (app.project_agents, agent_type 'agentbricks' or
 *   'serving-endpoint'): a workspace endpoint someone built in AgentBricks or
 *   Model Serving, registered against a project. These are real from the
 *   moment they are created — status comes from the workspace serving API, and
 *   an agent with role 'pr-reviewer' is what the PR review gate invokes.
 *
 * - Configured runners (agent_type 'runner'): the scaffolded deploy flow.
 *   Persists the submitted configuration; actual rollout to a devbox fleet is
 *   still future work, so the record sits at status 'configured'.
 *
 * - Observed runners: derived from app.agent_tasks history — any runner that
 *   ever claimed work on an engagement shows up as a live agent node with its
 *   task counts and last-seen time. This is the "real data" half of the map.
 *   Their status is not task counts alone: a runner is 'idle' only while it is
 *   still polling the queue, and 'offline' once it stops (DAT-224), because
 *   task history alone cannot tell a waiting runner from a dead one.
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
  // Upsert identity for the sync pass (observed runners + auto-registered
  // serving endpoints): one row per engagement × agent name.
  `CREATE UNIQUE INDEX IF NOT EXISTS project_agents_eng_name ON app.project_agents (engagement_id, lower(name))`,
  // DAT-209 columns. The app SP created this table (DAT-203), so boot ALTERs
  // succeed here — unlike the dev-role tables that need dev-migrate.cjs.
  `ALTER TABLE app.project_agents ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'delivery'`,
  `ALTER TABLE app.project_agents ADD COLUMN IF NOT EXISTS endpoint_name TEXT`,
  `ALTER TABLE app.project_agents ADD COLUMN IF NOT EXISTS description TEXT`,
  // DAT-212: per-agent security settings + the safe-baseline rollout migration.
  ...AGENT_SECURITY_SCHEMA_SQL,
  // DAT-238: registry attachments live in their own columns, not in `config` —
  // the sync pass rewrites `config` for observed runners on every overview
  // load, which would silently drop anything a lead attached.
  `ALTER TABLE app.project_agents ADD COLUMN IF NOT EXISTS mcp_servers JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE app.project_agents ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'`,
];

/** Node kinds the map renders. 'foundry' is still a placeholder. */
export const AGENT_TYPES = ['runner', 'serving-endpoint', 'agentbricks', 'foundry'] as const;

/**
 * What an agent is for. 'pr-reviewer' is wired: a PR opening on the engagement
 * invokes that agent's endpoint (see pr-review.ts). The rest are labels today.
 */
export const AGENT_ROLES = ['delivery', 'pr-reviewer', 'planning', 'other'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Types whose liveness is a workspace serving endpoint rather than a runner. */
export const ENDPOINT_BACKED: readonly string[] = ['agentbricks', 'serving-endpoint'];

const DeployAgentBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    agentType: z.enum(AGENT_TYPES).default('runner'),
    role: z.enum(AGENT_ROLES).default('delivery'),
    harness: z.string().trim().max(40).optional(),
    modelProvider: z.string().trim().max(40).optional(),
    model: z.string().trim().max(80).optional(),
    endpointType: z.string().trim().max(40).optional(),
    endpointName: z.string().trim().max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((b) => b.agentType !== 'runner' || b.harness || b.modelProvider, {
    message: 'A runner needs a harness or a model provider',
  })
  .refine((b) => !ENDPOINT_BACKED.includes(b.agentType) || Boolean(b.endpointName), {
    message: 'Name the workspace serving endpoint this agent runs on',
  });

/**
 * Everything a lead can change after creation. `agentType` stays immutable —
 * a runner and an endpoint are different things, re-register instead. `name`
 * is accepted only for rows a person created: system-synced rows are keyed
 * by the runner's own name and would re-register under the old one.
 */
const UpdateAgentBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  role: z.enum(AGENT_ROLES).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  endpointName: z.string().trim().max(200).optional(),
  harness: z.string().trim().max(40).nullable().optional(),
  modelProvider: z.string().trim().max(40).nullable().optional(),
  model: z.string().trim().max(80).nullable().optional(),
  // Registry attachments (DAT-238): ids of published MCP servers / skills the
  // agent may reach. Validated against the agent's project scope on save.
  mcpServers: z.array(z.number().int().positive()).max(40).optional(),
  skills: z.array(z.number().int().positive()).max(40).optional(),
});

/**
 * What a run should be configured with (DAT-279): the model the lead picked
 * for this agent and its registry attachments, resolved to full entries.
 * Rides in the work package; the runner materializes it in the task workdir.
 */
export interface AgentRunConfig {
  /** Model id for the harness CLI (`claude --model …`, `codex -m …`); null = the harness default. */
  model: string | null;
  mcpServers: RegistryMcpServer[];
  skills: RegistrySkill[];
}

const EMPTY_RUN_CONFIG: AgentRunConfig = { model: null, mcpServers: [], skills: [] };

/**
 * The claiming runner's record, by the same (engagement, lower(name)) key the
 * sync pass upserts on. A runner with no record yet — or a name the console
 * never saw — gets the empty config, never an error: a missing config must
 * not fail a claim.
 */
export async function agentConfigForWorkPackage(q: Query, engagementId: string, agentName: string): Promise<AgentRunConfig> {
  if (!agentName) return EMPTY_RUN_CONFIG;
  try {
    const row = (
      await q('SELECT model, mcp_servers, skills FROM app.project_agents WHERE engagement_id = $1 AND lower(name) = lower($2)', [
        engagementId,
        agentName,
      ])
    ).rows[0];
    if (!row) return EMPTY_RUN_CONFIG;
    const ids = attachmentsFromRow(row);
    const resolved = await resolveAttachments(q, engagementId, ids);
    const model = txt(row.model).trim();
    return { model: model || null, mcpServers: resolved.mcpServers, skills: resolved.skills };
  } catch (err) {
    console.warn(`[agents] run config lookup failed for ${agentName} on ${engagementId}:`, (err as Error).message);
    return EMPTY_RUN_CONFIG;
  }
}

/** Attachment ids off a project_agents row (jsonb columns, possibly still strings from pg). */
export function attachmentsFromRow(row: Record<string, unknown> | undefined): { mcpServers: number[]; skills: number[] } {
  const ids = (v: unknown): number[] => {
    let raw: unknown = v;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = [];
      }
    }
    return Array.isArray(raw) ? raw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0) : [];
  };
  return { mcpServers: ids(row?.mcp_servers), skills: ids(row?.skills) };
}

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

/** Timestamp column → epoch ms, or null when absent/unparseable. */
const at = (v: unknown): number | null => {
  const s = iso(v);
  if (s === null) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Every runner in the fleet today is a Claude Code instance (see
 * RunnerLogo.tsx client-side); named harnesses in the runner id override that
 * default as other harness types come online.
 */
export function inferHarness(agentName: string): string {
  const n = agentName.toLowerCase();
  if (n.includes('codex')) return 'codex';
  if (n.includes('omnigent')) return 'omnigent';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('copilot')) return 'copilot';
  if (n.includes('cursor')) return 'cursor';
  if (n.includes('omnigent')) return 'omnigent';
  return 'claude-code';
}

/**
 * Default model provider behind each harness, for logo fallback and grouping.
 * The client mirrors this as HARNESS_DEFAULT_PROVIDER (AgentLogos.tsx); the two
 * are pinned together by tests/harness-abstraction.test.ts.
 */
export const HARNESS_PROVIDER: Record<string, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  gemini: 'google',
  copilot: 'microsoft',
  cursor: 'anysphere',
  // Omnigent is a hosted service rather than a CLI over someone else's model, so
  // it is its own provider — the model behind a run is the vendor's business
  // (DAT-221, docs/omnigent-runner-architecture.md).
  omnigent: 'omnigent',
};

// ---------- live model-serving state (DAT-203) ----------

/** The planning agent IS this endpoint; its name comes from the app resource env. */
const SERVING_ENDPOINT = process.env.DATABRICKS_SERVING_ENDPOINT_NAME ?? '';

export interface ServingState {
  ready: boolean;
  configUpdate: string;
  task: string | null;
  servedModel: string | null;
  /** Set when the endpoint could not be read — surfaced on the node so a
   *  missing CAN_QUERY grant looks like a permission problem, not a dead agent. */
  error?: string;
}

const servingCache = new Map<string, { at: number; state: ServingState | null }>();
const SERVING_CACHE_MS = 60_000;

function workspaceBase(): string | null {
  const host = process.env.DATABRICKS_HOST;
  if (!host) return null;
  return host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`;
}

/** M2M token for the app's service principal (Databricks Apps inject the OAuth pair). */
export async function workspaceToken(): Promise<string | null> {
  const base = workspaceBase();
  const id = process.env.DATABRICKS_CLIENT_ID;
  const secret = process.env.DATABRICKS_CLIENT_SECRET;
  if (!base || !id || !secret) return null;
  const resp = await fetch(`${base}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=all-apis',
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/**
 * Live state for any workspace serving endpoint — the planning endpoint, an
 * AgentBricks agent, anything registered on the map. Cached ~60s per endpoint;
 * null means "could not read it" (no credentials, no such endpoint, or the app
 * service principal lacks CAN_QUERY).
 */
export async function fetchEndpointState(endpoint: string): Promise<ServingState | null> {
  if (!endpoint) return null;
  const hit = servingCache.get(endpoint);
  if (hit && Date.now() - hit.at < SERVING_CACHE_MS) return hit.state;
  try {
    const base = workspaceBase();
    const token = await workspaceToken();
    if (!base || !token) throw new Error('workspace credentials unavailable');
    const resp = await fetch(`${base}/api/2.0/serving-endpoints/${encodeURIComponent(endpoint)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const state: ServingState = {
        ready: false,
        configUpdate: 'UNKNOWN',
        task: null,
        servedModel: null,
        error: resp.status === 403 || resp.status === 401 ? 'no access — grant the app service principal CAN_QUERY' : `serving api returned ${resp.status}`,
      };
      servingCache.set(endpoint, { at: Date.now(), state });
      return state;
    }
    const d = (await resp.json()) as {
      state?: { ready?: string; config_update?: string };
      task?: string;
      config?: { served_entities?: { entity_name?: string; name?: string }[] };
    };
    const state: ServingState = {
      ready: d.state?.ready === 'READY',
      configUpdate: d.state?.config_update ?? 'UNKNOWN',
      task: d.task ?? null,
      servedModel: d.config?.served_entities?.[0]?.entity_name ?? d.config?.served_entities?.[0]?.name ?? null,
    };
    servingCache.set(endpoint, { at: Date.now(), state });
    return state;
  } catch (err) {
    console.warn(`[agents] serving endpoint '${endpoint}' state fetch failed:`, (err as Error).message);
    servingCache.set(endpoint, { at: Date.now(), state: null });
    return null;
  }
}

/**
 * Persist the map into app.project_agents so agents are stored records, not
 * request-time inference (DAT-203): every observed runner upserts with its
 * live status/task counts, and the planning model-serving endpoint registers
 * per engagement with real workspace state.
 */
export async function syncProjectAgents(q: Query): Promise<void> {
  const observed = (
    await q(
      `SELECT engagement_id, agent,
              COUNT(*)::int AS tasks,
              SUM(CASE WHEN state IN ('claimed','working') THEN 1 ELSE 0 END)::int AS active_tasks,
              MAX(COALESCE(last_heartbeat, updated_at, created_at)) AS last_seen
       FROM app.agent_tasks
       WHERE agent IS NOT NULL AND agent <> ''
       GROUP BY engagement_id, agent`,
    )
  ).rows;
  const polls = await loadRunnerPolls(q);
  for (const r of observed) {
    const name = txt(r.agent);
    const harness = inferHarness(name);
    const lastPolled = polls.get(name) ?? null;
    const status = runnerStatus(num(r.active_tasks), lastPolled, at(r.last_seen));
    const config = JSON.stringify({
      tasks: num(r.tasks),
      activeTasks: num(r.active_tasks),
      lastSeen: iso(r.last_seen),
      lastPolled: lastPolled === null ? null : new Date(lastPolled).toISOString(),
    });
    // security_settings is written on insert only — a sync must never overwrite
    // a scope a lead has set on the panel (DAT-212).
    await q(
      `INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider, status, config, created_by, security_settings)
       VALUES ($1,$2,'runner',$3,$4,$5,$6,'system:observed',$7)
       ON CONFLICT (engagement_id, lower(name))
       DO UPDATE SET status = $5, config = $6, harness = COALESCE(app.project_agents.harness, $3),
                     model_provider = COALESCE(app.project_agents.model_provider, $4)`,
      [txt(r.engagement_id), name, harness, HARNESS_PROVIDER[harness] ?? null, status, config, JSON.stringify(baselineSecurity('delivery'))],
    );
  }

  // Registered endpoint-backed agents (AgentBricks / model serving): status is
  // whatever the workspace says right now, per distinct endpoint.
  const endpointRows = (
    await q(
      `SELECT id, endpoint_name FROM app.project_agents
       WHERE agent_type = ANY($1) AND endpoint_name IS NOT NULL AND endpoint_name <> ''`,
      [ENDPOINT_BACKED],
    )
  ).rows;
  for (const r of endpointRows) {
    const endpoint = txt(r.endpoint_name);
    const state = await fetchEndpointState(endpoint);
    await q(
      `UPDATE app.project_agents
       SET status = $2,
           config = COALESCE(config, '{}'::jsonb) || $3::jsonb,
           model = COALESCE(NULLIF(model, ''), $4)
       WHERE id = $1`,
      [
        num(r.id),
        endpointStatus(state),
        JSON.stringify({
          endpoint,
          servedModel: state?.servedModel ?? null,
          task: state?.task ?? null,
          configUpdate: state?.configUpdate ?? null,
          endpointError: state?.error ?? null,
          checkedAt: new Date().toISOString(),
        }),
        state?.servedModel ?? null,
      ],
    );
  }

  if (!SERVING_ENDPOINT) return;
  const state = await fetchEndpointState(SERVING_ENDPOINT);
  const config = JSON.stringify({
    endpoint: SERVING_ENDPOINT,
    servedModel: state?.servedModel ?? null,
    task: state?.task ?? null,
    configUpdate: state?.configUpdate ?? null,
    endpointError: state?.error ?? null,
    checkedAt: new Date().toISOString(),
  });
  const engagements = (await q('SELECT id FROM app.engagements')).rows;
  for (const e of engagements) {
    await q(
      `INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider, model, endpoint_type, endpoint_name, role, status, config, created_by, security_settings)
       VALUES ($1,'planning-agent','serving-endpoint',NULL,'databricks',$2,'model-serving',$5,'planning',$3,$4,'system:serving',$6)
       ON CONFLICT (engagement_id, lower(name))
       -- role is forced, not COALESCEd: rows that predate the role column
       -- carry the 'delivery' default, and this row is system-owned anyway.
       DO UPDATE SET model = $2, status = $3, config = $4, role = 'planning',
                     endpoint_name = COALESCE(app.project_agents.endpoint_name, $5)`,
      [txt(e.id), state?.servedModel ?? SERVING_ENDPOINT, endpointStatus(state), config, SERVING_ENDPOINT, JSON.stringify(baselineSecurity('planning'))],
    );
  }
}

/**
 * Invoke a workspace serving endpoint (an AgentBricks agent, a custom model)
 * with the app's service principal. AgentBricks agents differ in request
 * schema — chat-style `messages` for supervisor/custom-LLM agents, responses
 * style `input` for others — so a schema rejection retries the other shape
 * before giving up. Returns the raw JSON body; extraction is the caller's job.
 */
export async function invokeAgentEndpoint(endpoint: string, prompt: string): Promise<unknown> {
  const base = workspaceBase();
  const token = await workspaceToken();
  if (!base || !token) throw new Error('workspace credentials unavailable — cannot reach the agent endpoint');
  const url = `${base}/serving-endpoints/${encodeURIComponent(endpoint)}/invocations`;
  const shapes: Record<string, unknown>[] = [
    { messages: [{ role: 'user', content: prompt }] },
    { input: [{ role: 'user', content: prompt }] },
  ];
  let lastError = 'agent endpoint call failed';
  for (const body of shapes) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_INVOKE_TIMEOUT_MS),
    });
    if (resp.ok) return await resp.json();
    const text = (await resp.text().catch(() => '')).slice(0, 400);
    lastError = `endpoint returned ${resp.status}${text ? `: ${text}` : ''}`;
    // Only a schema complaint is worth retrying with the other request shape.
    if (resp.status !== 400 && resp.status !== 422) break;
  }
  throw new Error(lastError);
}

/** Agent turns are long — a reviewer reads a diff and may call MCP tools. */
const AGENT_INVOKE_TIMEOUT_MS = 300_000;

/** READY → active, reachable-but-not-ready → idle, unreadable → 'unreachable'. */
function endpointStatus(state: ServingState | null): string {
  if (state === null) return 'unreachable';
  if (state.error) return 'unreachable';
  return state.ready ? 'active' : 'idle';
}

export interface OverviewAgent {
  id: string;
  /** Numeric project_agents.id for stored records; null for observed runners. */
  recordId: number | null;
  engagementId: string;
  name: string;
  agentType: string;
  role: string;
  description: string | null;
  harness: string | null;
  modelProvider: string | null;
  model: string | null;
  endpointType: string | null;
  endpointName: string | null;
  endpointError: string | null;
  status: string;
  source: 'configured' | 'observed';
  tasks: number;
  activeTasks: number;
  lastSeen: string | null;
  createdAt: string | null;
  /** Per-agent security controls (DAT-212) — the settings the runtime enforces. */
  security: AgentSecuritySettings;
  /** Registry attachments (DAT-238): published MCP server / skill ids. */
  mcpServers: number[];
  skills: number[];
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

  const storedRows = (await q('SELECT * FROM app.project_agents ORDER BY id')).rows;
  const configured: OverviewAgent[] = storedRows.map((r) => {
    // Synced rows carry live facts in config (task counts, last-seen or the
    // serving endpoint's checked-at) — surface them on the node.
    const cfg = (() => {
      try {
        const raw: unknown = typeof r.config === 'string' ? JSON.parse(r.config) : (r.config ?? {});
        return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();
    return {
      id: `cfg-${num(r.id)}`,
      recordId: num(r.id),
      engagementId: txt(r.engagement_id),
      name: txt(r.name),
      agentType: txt(r.agent_type) || 'runner',
      role: txt(r.role) || 'delivery',
      description: r.description == null ? null : txt(r.description),
      harness: r.harness == null ? null : txt(r.harness),
      modelProvider: r.model_provider == null ? null : txt(r.model_provider),
      model: r.model == null ? null : txt(r.model),
      endpointType: r.endpoint_type == null ? null : txt(r.endpoint_type),
      endpointName: r.endpoint_name == null ? null : txt(r.endpoint_name),
      endpointError: typeof cfg.endpointError === 'string' ? cfg.endpointError : null,
      status: txt(r.status) || 'configured',
      source: 'configured' as const,
      tasks: num(cfg.tasks),
      activeTasks: num(cfg.activeTasks),
      lastSeen: typeof cfg.lastSeen === 'string' ? cfg.lastSeen : typeof cfg.checkedAt === 'string' ? cfg.checkedAt : null,
      createdAt: iso(r.created_at),
      security: parseSecuritySettings(r.security_settings, txt(r.role) || 'delivery'),
      ...attachmentsFromRow(r),
    };
  });

  // The stored row behind an observed runner, so the security panel can address
  // it by id — the sync upserts one per runner before every overview load.
  const storedByKey = new Map(storedRows.map((r) => [`${txt(r.engagement_id)} ${txt(r.name).toLowerCase()}`, r]));

  // Real runner history: one node per (engagement, runner) that has ever
  // claimed work there. Active = currently holding a claimed/working task,
  // idle = still polling with nothing to do, offline = stopped reaching us.
  const runnerPolls = await loadRunnerPolls(q);
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
    const stored = storedByKey.get(`${txt(r.engagement_id)} ${name.toLowerCase()}`);
    const role = txt(stored?.role) || 'delivery';
    return {
      id: `run-${txt(r.engagement_id)}-${name}`,
      // Null only until the first sync writes the runner's row; the panel shows
      // its settings read-only in that window rather than editing a ghost.
      recordId: stored ? num(stored.id) : null,
      engagementId: txt(r.engagement_id),
      name,
      agentType: 'runner',
      role,
      description: stored?.description == null ? null : txt(stored.description),
      harness,
      modelProvider: HARNESS_PROVIDER[harness] ?? null,
      model: null,
      endpointType: null,
      endpointName: null,
      endpointError: null,
      status: runnerStatus(num(r.active_tasks), runnerPolls.get(name) ?? null, at(r.last_seen)),
      source: 'observed' as const,
      tasks: num(r.tasks),
      activeTasks: num(r.active_tasks),
      lastSeen: iso(r.last_seen),
      createdAt: null,
      security: parseSecuritySettings(stored?.security_settings, role),
      ...attachmentsFromRow(stored),
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
  resolveIdentity: (req: express.Request) => Promise<Identity>,
) {
  app.get('/api/agents/overview', async (req, res) => {
    try {
      // Persist before reading: the table is the record of truth, refreshed
      // from runner history + live serving state on every overview load. A
      // sync failure must not blank the map.
      await syncProjectAgents(q).catch((err) => console.warn('[agents] sync failed:', (err as Error).message));
      const overview = await loadAgentsOverview(q);
      // Live token consumption per runner (DAT-266): trailing-24h totals from
      // run_token_usage, keyed by the agent name claims record. Telemetry —
      // a failed read never blanks the map.
      const usage = await usageByAgent(q, 24).catch(() => new Map<string, UsageTotals>());
      const withTokens = <T extends { name: string }>(agents: T[]): (T & { tokens24h?: UsageTotals })[] =>
        agents.map((agent) => {
          const totals = usage.get(agent.name);
          return totals ? { ...agent, tokens24h: totals } : agent;
        });
      const allowed = await accessibleProjectIds(q, await resolveIdentity(req));
      if (allowed === null) {
        res.json({ ...overview, agents: withTokens(overview.agents) });
        return;
      }
      const ids = new Set(allowed);
      res.json({
        projects: overview.projects.filter((project) => ids.has(project.id)),
        agents: withTokens(overview.agents.filter((agent) => ids.has(agent.engagementId))),
      });
    } catch (err) {
      console.error('agents overview failed:', err);
      res.status(500).json({ error: 'Failed to load the agent map' });
    }
  });

  /**
   * Register an agent on a project. Endpoint-backed agents (AgentBricks, model
   * serving) are live records: the endpoint already exists in the workspace, so
   * the row is created and its status resolved against the serving API right
   * away. Harness runners remain scaffolded — the record is saved at
   * 'configured' and the map renders it as staged until fleet rollout lands.
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
      const { name, agentType, role, harness, modelProvider, model, endpointType, endpointName, description, notes } = parsed.data;
      if (agentType === 'foundry') {
        res.status(422).json({ error: 'Foundry agents are not supported yet — register an AgentBricks or model serving endpoint' });
        return;
      }
      const dup = (await q('SELECT id FROM app.project_agents WHERE engagement_id = $1 AND lower(name) = lower($2)', [engId, name])).rows[0];
      if (dup) {
        res.status(409).json({ error: `This project already has an agent named ${name}` });
        return;
      }
      const endpointBacked = ENDPOINT_BACKED.includes(agentType);
      // Resolve liveness at creation so the node shows real state immediately
      // (and a missing CAN_QUERY grant is visible now, not at first review).
      const state = endpointBacked && endpointName ? await fetchEndpointState(endpointName) : null;
      const status = endpointBacked ? endpointStatus(state) : 'configured';
      const config: Record<string, unknown> = notes ? { notes } : {};
      if (endpointBacked) {
        Object.assign(config, {
          endpoint: endpointName,
          servedModel: state?.servedModel ?? null,
          task: state?.task ?? null,
          configUpdate: state?.configUpdate ?? null,
          endpointError: state?.error ?? null,
          checkedAt: new Date().toISOString(),
        });
      }
      const inserted = await q(
        `INSERT INTO app.project_agents
           (engagement_id, name, agent_type, role, description, harness, model_provider, model, endpoint_type, endpoint_name, status, config, created_by, security_settings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [
          engId,
          name,
          agentType,
          role,
          description ?? null,
          harness ?? null,
          modelProvider ?? (endpointBacked ? 'databricks' : null),
          model ?? state?.servedModel ?? null,
          endpointType ?? (endpointBacked ? 'model-serving' : null),
          endpointName ?? null,
          status,
          JSON.stringify(config),
          who.email,
          // A new agent starts on the baseline for its role; the lead narrows or
          // widens it from the security panel afterwards.
          JSON.stringify(baselineSecurity(role)),
        ],
      );
      const what = endpointBacked ? `${agentType} endpoint '${endpointName ?? ''}'` : (harness ?? modelProvider ?? agentType);
      console.log(`[agents] registered agent '${name}' (${what}, role ${role}) for ${engId} — status ${status}`);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [
          engId,
          endpointBacked
            ? `Registered ${agentType === 'agentbricks' ? 'AgentBricks' : 'serving endpoint'} agent ${name} (${endpointName ?? ''}) as ${role} — endpoint ${status}.`
            : `Configured agent ${name}${harness ? ` (${harness})` : ''} — deployment pending rollout.`,
        ],
      );
      res.status(201).json({ ...inserted.rows[0], endpointError: state?.error ?? null });
    } catch (err) {
      console.error('register agent failed:', err);
      res.status(500).json({ error: 'Failed to save the agent configuration' });
    }
  });

  /** Edit the mutable parts of a stored agent: what it is for, and where it lives. */
  app.patch('/api/projects/:id/agents/:agentId', async (req, res) => {
    const parsed = UpdateAgentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid agent update' });
      return;
    }
    try {
      const engId = req.params.id;
      const who = await requireLead(req, res, engId);
      if (!who) return;
      const row = (await q('SELECT * FROM app.project_agents WHERE id = $1 AND engagement_id = $2', [Number(req.params.agentId), engId]))
        .rows[0];
      if (!row) {
        res.status(404).json({ error: 'Agent not found on this project' });
        return;
      }
      const { name, role, description, endpointName, harness, modelProvider, model, mcpServers, skills } = parsed.data;
      if (name !== undefined && txt(row.created_by).startsWith('system:')) {
        res.status(409).json({ error: 'System-synced agents are named by the runner itself — rename the runner, not the record' });
        return;
      }
      if (name !== undefined && name.toLowerCase() !== txt(row.name).toLowerCase()) {
        const dup = (
          await q('SELECT id FROM app.project_agents WHERE engagement_id = $1 AND lower(name) = lower($2) AND id <> $3', [
            engId,
            name,
            num(row.id),
          ])
        ).rows[0];
        if (dup) {
          res.status(409).json({ error: `This project already has an agent named ${name}` });
          return;
        }
      }
      // Re-role an agent and its baseline scope follows — otherwise promoting an
      // agent to pr-reviewer would leave it without the review scope and the
      // gate would reject it. Settings a lead has edited (updatedBy set) are
      // never rewritten here; they change only through the security panel.
      const current = parseSecuritySettings(row.security_settings, txt(row.role) || 'delivery');
      const rebaseline = role && role !== txt(row.role) && current.updatedBy === null ? JSON.stringify(baselineSecurity(role)) : null;
      // Nullable text fields: `undefined` keeps the stored value, `null` clears
      // it — the drawer sends null when a lead empties the model or harness.
      const keep = <T>(v: T | undefined): { set: boolean; value: T | null } => ({ set: v !== undefined, value: v ?? null });
      const h = keep(harness);
      const p = keep(modelProvider);
      const m = keep(model);
      const d = keep(description);
      // Attachments: only ids the project may see (shared or its own, published)
      // survive; the drawer offers exactly those, so a dropped id was stale.
      const attach =
        mcpServers !== undefined || skills !== undefined
          ? await validAttachments(q, engId, { mcpServers, skills })
          : null;
      const setMcp = attach !== null && mcpServers !== undefined;
      const setSkills = attach !== null && skills !== undefined;
      const updated = await q(
        `UPDATE app.project_agents
         SET name = COALESCE($2, name),
             role = COALESCE($3, role),
             description = CASE WHEN $4 THEN $5 ELSE description END,
             endpoint_name = COALESCE($6, endpoint_name),
             harness = CASE WHEN $7 THEN $8 ELSE harness END,
             model_provider = CASE WHEN $9 THEN $10 ELSE model_provider END,
             model = CASE WHEN $11 THEN $12 ELSE model END,
             security_settings = COALESCE($13::jsonb, security_settings),
             mcp_servers = CASE WHEN $15 THEN $14::jsonb ELSE mcp_servers END,
             skills = CASE WHEN $17 THEN $16::jsonb ELSE skills END
         WHERE id = $1 RETURNING *`,
        [
          num(row.id),
          name ?? null,
          role ?? null,
          d.set,
          d.value,
          endpointName ?? null,
          h.set,
          h.value,
          p.set,
          p.value,
          m.set,
          m.value,
          rebaseline,
          JSON.stringify(attach?.mcpServers ?? []),
          setMcp,
          JSON.stringify(attach?.skills ?? []),
          setSkills,
        ],
      );
      const changed = Object.entries({
        name,
        role,
        model,
        harness,
        modelProvider: modelProvider,
        endpointName,
        mcpServers: attach && mcpServers !== undefined ? `${attach.mcpServers.length} server${attach.mcpServers.length === 1 ? '' : 's'}` : undefined,
        skills: attach && skills !== undefined ? `${attach.skills.length} skill${attach.skills.length === 1 ? '' : 's'}` : undefined,
      })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k} → ${v ?? '—'}`);
      if (changed.length) {
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [engId, `Reconfigured agent ${txt(row.name)}: ${changed.join(', ')}.`],
        ).catch(() => {});
      }
      res.json(updated.rows[0]);
    } catch (err) {
      console.error('update agent failed:', err);
      res.status(500).json({ error: 'Failed to update the agent' });
    }
  });

  /**
   * Remove a stored agent. Observed runners are not stored records and cannot
   * be deleted here — they disappear when their task history does.
   */
  app.delete('/api/projects/:id/agents/:agentId', async (req, res) => {
    try {
      const engId = req.params.id;
      const who = await requireLead(req, res, engId);
      if (!who) return;
      const row = (await q('SELECT name, created_by FROM app.project_agents WHERE id = $1 AND engagement_id = $2', [
        Number(req.params.agentId),
        engId,
      ])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Agent not found on this project' });
        return;
      }
      if (txt(row.created_by).startsWith('system:')) {
        res.status(409).json({ error: 'System-synced agents cannot be removed — they re-register on the next sync' });
        return;
      }
      await q('DELETE FROM app.project_agents WHERE id = $1', [Number(req.params.agentId)]);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [engId, `Removed agent ${txt(row.name)} from the project.`],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('delete agent failed:', err);
      res.status(500).json({ error: 'Failed to remove the agent' });
    }
  });
}
