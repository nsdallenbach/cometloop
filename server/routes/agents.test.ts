import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type express from 'express';
import { PROJECT_AGENTS_SCHEMA_SQL, agentConfigForWorkPackage, inferHarness, loadAgentsOverview, setupProjectAgentRoutes } from './agents';
import { baselineSecurity, parseSecuritySettings } from './agent-security';
import type { Identity } from './roles';
import { REGISTRY_SCHEMA_SQL } from './registry';
import { FLEET_SCHEMA_SQL } from './fleet';

/**
 * Runs the agent-map overview against pg-mem, the same in-memory Postgres
 * harness the coordination tests use, so the aggregate SQL over agent_tasks
 * and the configured/observed merge behave exactly as they will on Lakebase.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Stand-ins for the console tables the overview reads (no FKs — pg-mem only
// needs the columns the queries touch).
const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY, client TEXT NOT NULL, name TEXT NOT NULL, health TEXT NOT NULL, phase TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, state TEXT NOT NULL, agent TEXT, last_heartbeat TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
];

// The FK to app.engagements is dropped for pg-mem (it's exercised in prod by
// the shared boot migration); everything else runs verbatim.
const AGENTS_TABLE_SQL = PROJECT_AGENTS_SCHEMA_SQL.map((s) => s.replace(' REFERENCES app.engagements(id) ON DELETE CASCADE', ''));

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...AGENTS_TABLE_SQL, ...FLEET_SCHEMA_SQL]) await q(sql);
  await q(`INSERT INTO app.engagements (id, client, name, health, phase) VALUES ('eng-a', 'ACME', 'Console', 'ok', 'Build')`);
  await q(`INSERT INTO app.engagements (id, client, name, health, phase) VALUES ('eng-b', 'BETA', 'Portal', 'risk', 'Plan')`);
});

describe('inferHarness', () => {
  it('defaults to claude-code and recognizes named harnesses', () => {
    expect(inferHarness('local-runner')).toBe('claude-code');
    expect(inferHarness('devbox-codex-3')).toBe('codex');
    expect(inferHarness('Gemini-Runner')).toBe('gemini');
  });
});

describe('loadAgentsOverview', () => {
  it('derives observed runner nodes from agent_tasks with activity status', async () => {
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-1', 'eng-a', 'done', 'runner-1')`);
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-2', 'eng-a', 'working', 'runner-1')`);
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-3', 'eng-b', 'failed', 'runner-2')`);
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-4', 'eng-b', 'queued', NULL)`);

    const { projects, agents } = await loadAgentsOverview(q);
    expect(projects.map((p) => p.id)).toEqual(['eng-a', 'eng-b']);
    expect(agents).toHaveLength(2);
    const r1 = agents.find((a) => a.name === 'runner-1');
    expect(r1).toMatchObject({ engagementId: 'eng-a', harness: 'claude-code', modelProvider: 'anthropic', status: 'active', tasks: 2, activeTasks: 1, source: 'observed' });
    expect(agents.find((a) => a.name === 'runner-2')).toMatchObject({ status: 'idle', source: 'observed' });
  });

  it('calls a runner that stopped reaching the console offline, not idle (DAT-224)', async () => {
    // Task history alone said 'idle' here — the exact reading that hid a dead
    // fleet for nine hours.
    await q(
      `INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent, created_at, updated_at)
       VALUES ('DAT-1', 'eng-a', 'done', 'dead-runner', NOW() - INTERVAL '9 hours', NOW() - INTERVAL '9 hours')`,
    );
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-2', 'eng-a', 'done', 'live-runner')`);
    await q(`INSERT INTO app.runner_polls (agent, engagement_id, source) VALUES ('live-runner', '', 'poll')`);

    const { agents } = await loadAgentsOverview(q);
    expect(agents.find((a) => a.name === 'dead-runner')).toMatchObject({ status: 'offline', source: 'observed' });
    expect(agents.find((a) => a.name === 'live-runner')).toMatchObject({ status: 'idle', source: 'observed' });
  });

  it('includes configured agents and lets an observed runner of the same name win', async () => {
    await q(`INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider) VALUES ('eng-a', 'runner-1', 'runner', 'claude-code', 'anthropic')`);
    await q(`INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider, model) VALUES ('eng-a', 'codex-writer', 'runner', 'codex', 'openai', 'gpt-5.2-codex')`);
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-1', 'eng-a', 'done', 'runner-1')`);

    const { agents } = await loadAgentsOverview(q);
    expect(agents).toHaveLength(2);
    // The duplicate configured 'runner-1' is dropped in favor of the observed node.
    expect(agents.find((a) => a.name === 'runner-1')).toMatchObject({ source: 'observed' });
    expect(agents.find((a) => a.name === 'codex-writer')).toMatchObject({ source: 'configured', status: 'configured', harness: 'codex', model: 'gpt-5.2-codex' });
  });

  it('keeps future-type configured entries (serving endpoints etc.) regardless of runner names', async () => {
    await q(`INSERT INTO app.project_agents (engagement_id, name, agent_type, endpoint_type, status) VALUES ('eng-b', 'runner-2', 'serving-endpoint', 'model-serving', 'planned')`);
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-3', 'eng-b', 'done', 'runner-2')`);

    const { agents } = await loadAgentsOverview(q);
    // Same name, but the configured row is not a runner — both survive.
    expect(agents).toHaveLength(2);
    expect(agents.find((a) => a.agentType === 'serving-endpoint')).toMatchObject({ endpointType: 'model-serving', status: 'planned' });
  });
});

// ---------- routes: reconfiguring a stored agent (DAT-278) ----------

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;

/** Captures the handlers setupProjectAgentRoutes registers, no express needed. */
function captureRoutes(requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, h: Handler) => routes.set(`GET ${path}`, h),
    post: (path: string, h: Handler) => routes.set(`POST ${path}`, h),
    patch: (path: string, h: Handler) => routes.set(`PATCH ${path}`, h),
    delete: (path: string, h: Handler) => routes.set(`DELETE ${path}`, h),
  } as unknown as express.Application;
  setupProjectAgentRoutes(app, q, requireLead, () => Promise.resolve({ email: 'lead@datavail.com', role: 'lead' }));
  return routes;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const leadGuard = (): Promise<Identity | null> => Promise.resolve({ email: 'lead@datavail.com', role: 'lead' });

const patch = async (routes: Map<string, Handler>, params: Record<string, string>, body: unknown) => {
  const res = fakeRes();
  await routes.get('PATCH /api/projects/:id/agents/:agentId')?.({ params, body } as unknown as express.Request, res as unknown as express.Response);
  return res;
};

describe('PATCH /api/projects/:id/agents/:agentId', () => {
  beforeEach(async () => {
    await q(`CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT, actor TEXT, text TEXT, time_label TEXT, reversible BOOLEAN)`);
    await q(
      `INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider, model, created_by)
       VALUES ('eng-a', 'codex-writer', 'runner', 'codex', 'openai', 'gpt-5.2-codex', 'lead@datavail.com')`,
    );
    await q(
      `INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider, created_by)
       VALUES ('eng-a', 'desktop-box-claude-1', 'runner', 'claude-code', 'anthropic', 'system:observed')`,
    );
  });

  const rowFor = async (name: string) => (await q('SELECT * FROM app.project_agents WHERE name = $1', [name])).rows[0];

  it('lets a lead change model, harness and provider, and clears a field sent as null', async () => {
    const routes = captureRoutes(leadGuard);
    const id = String((await rowFor('codex-writer')).id);
    const res = await patch(routes, { id: 'eng-a', agentId: id }, { harness: 'claude-code', modelProvider: 'anthropic', model: 'claude-opus-5' });
    expect(res.statusCode).toBe(200);
    expect(await rowFor('codex-writer')).toMatchObject({ harness: 'claude-code', model_provider: 'anthropic', model: 'claude-opus-5' });

    const cleared = await patch(routes, { id: 'eng-a', agentId: id }, { model: null });
    expect(cleared.statusCode).toBe(200);
    expect((await rowFor('codex-writer')).model).toBeNull();
    // Untouched fields survive a partial update.
    expect((await rowFor('codex-writer')).harness).toBe('claude-code');

    const feed = (await q('SELECT text FROM app.feed_items')).rows.map((r) => String(r.text));
    expect(feed.some((t) => t.includes('Reconfigured agent codex-writer') && t.includes('claude-opus-5'))).toBe(true);
  });

  it('refuses to rename a system-synced row and refuses a name another agent on the project holds', async () => {
    const routes = captureRoutes(leadGuard);
    const systemId = String((await rowFor('desktop-box-claude-1')).id);
    expect((await patch(routes, { id: 'eng-a', agentId: systemId }, { name: 'renamed' })).statusCode).toBe(409);
    expect((await rowFor('desktop-box-claude-1')).name).toBe('desktop-box-claude-1');

    const ownId = String((await rowFor('codex-writer')).id);
    expect((await patch(routes, { id: 'eng-a', agentId: ownId }, { name: 'Desktop-Box-Claude-1' })).statusCode).toBe(409);
    expect((await patch(routes, { id: 'eng-a', agentId: ownId }, { name: 'codex-author' })).statusCode).toBe(200);
    expect(await rowFor('codex-author')).toBeTruthy();
  });

  it('re-baselines security when the role changes and no lead has edited the scope', async () => {
    const routes = captureRoutes(leadGuard);
    const id = String((await rowFor('codex-writer')).id);
    expect((await patch(routes, { id: 'eng-a', agentId: id }, { role: 'pr-reviewer' })).statusCode).toBe(200);
    const row = await rowFor('codex-writer');
    expect(row.role).toBe('pr-reviewer');
    expect(parseSecuritySettings(row.security_settings, 'pr-reviewer')).toMatchObject(baselineSecurity('pr-reviewer'));
  });

  it('404s for an agent that is not on the project and 400s an invalid body', async () => {
    const routes = captureRoutes(leadGuard);
    const id = String((await rowFor('codex-writer')).id);
    expect((await patch(routes, { id: 'eng-b', agentId: id }, { model: 'x' })).statusCode).toBe(404);
    expect((await patch(routes, { id: 'eng-a', agentId: id }, { role: 'overlord' })).statusCode).toBe(400);
  });
});

describe('PATCH /api/projects/:id/agents/:agentId — registry attachments (DAT-238)', () => {
  beforeEach(async () => {
    await q(`CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT, actor TEXT, text TEXT, time_label TEXT, reversible BOOLEAN)`);
    for (const sql of REGISTRY_SCHEMA_SQL.filter((s) => !s.includes('CREATE UNIQUE INDEX')).map((s) => s.replace(' REFERENCES app.engagements(id) ON DELETE CASCADE', ''))) await q(sql);
    await q(`INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model_provider, config, created_by) VALUES ('eng-a', 'codex-writer', 'runner', 'codex', 'openai', '{"notes":"keep"}', 'lead@datavail.com')`);
    await q(`INSERT INTO app.registry_mcp_servers (engagement_id, slug, name, command) VALUES (NULL, 'shared', 'Shared', 'x'), ('eng-a', 'own', 'Own', 'x'), ('eng-b', 'other', 'Other', 'x')`);
    await q(`INSERT INTO app.registry_skills (engagement_id, slug, name, status) VALUES (NULL, 'live', 'Live', 'published'), (NULL, 'gone', 'Gone', 'retired')`);
  });

  it('stores only attachments the project may see, keeps the rest of config, and reports them on the overview', async () => {
    const routes = captureRoutes(leadGuard);
    const agent = (await q(`SELECT id FROM app.project_agents WHERE name = 'codex-writer'`)).rows[0];
    const ids = Object.fromEntries((await q('SELECT slug, id FROM app.registry_mcp_servers')).rows.map((r) => [String(r.slug), Number(r.id)]));
    const skillIds = Object.fromEntries((await q('SELECT slug, id FROM app.registry_skills')).rows.map((r) => [String(r.slug), Number(r.id)]));
    const res = await patch(routes, { id: 'eng-a', agentId: String(agent.id) }, { mcpServers: [ids.shared, ids.own, ids.other, 4242], skills: [skillIds.live, skillIds.gone] });
    expect(res.statusCode).toBe(200);
    const row = (await q('SELECT config::text AS c, mcp_servers::text AS m, skills::text AS s FROM app.project_agents WHERE id = $1', [agent.id])).rows[0];
    // Attachments live in their own columns; config (the sync pass's scratch space) is untouched.
    expect(JSON.parse(String(row.c))).toEqual({ notes: 'keep' });
    expect(JSON.parse(String(row.m))).toEqual([ids.shared, ids.own]);
    expect(JSON.parse(String(row.s))).toEqual([skillIds.live]);

    const { agents } = await loadAgentsOverview(q);
    expect(agents.find((a) => a.name === 'codex-writer')).toMatchObject({ mcpServers: [ids.shared, ids.own], skills: [skillIds.live] });

    // A later update without attachment fields leaves them alone.
    expect((await patch(routes, { id: 'eng-a', agentId: String(agent.id) }, { model: 'gpt-5.3-codex' })).statusCode).toBe(200);
    expect(JSON.parse(String((await q('SELECT mcp_servers::text AS m FROM app.project_agents WHERE id = $1', [agent.id])).rows[0].m))).toEqual([ids.shared, ids.own]);
  });
});

describe('agentConfigForWorkPackage (DAT-279)', () => {
  beforeEach(async () => {
    for (const sql of REGISTRY_SCHEMA_SQL.filter((s) => !s.includes('CREATE UNIQUE INDEX')).map((s) =>
      s.replace(' REFERENCES app.engagements(id) ON DELETE CASCADE', ''),
    ))
      await q(sql);
    await q(
      `INSERT INTO app.registry_mcp_servers (engagement_id, slug, name, command, args, requires_auth)
       VALUES (NULL, 'jira', 'Jira', 'npx', '["-y","jira-mcp"]', true), ('eng-b', 'other', 'Other', 'x', '[]', false)`,
    );
    await q(
      `INSERT INTO app.registry_skills (engagement_id, slug, name, content, status)
       VALUES (NULL, 'style', 'Style', '# Style', 'published'), (NULL, 'old', 'Old', 'x', 'retired')`,
    );
    const idOf = async (table: string, slug: string) =>
      Number((await q(`SELECT id FROM app.${table} WHERE slug = $1`, [slug])).rows[0].id);
    const attachedServers = [await idOf('registry_mcp_servers', 'jira'), await idOf('registry_mcp_servers', 'other')];
    const attachedSkills = [await idOf('registry_skills', 'style'), await idOf('registry_skills', 'old')];
    await q(
      `INSERT INTO app.project_agents (engagement_id, name, agent_type, harness, model, mcp_servers, skills)
       VALUES ('eng-a', 'Desktop-Box-Claude-1', 'runner', 'claude-code', 'claude-opus-5', $1, $2)`,
      [JSON.stringify(attachedServers), JSON.stringify(attachedSkills)],
    );
  });

  it('resolves the claiming agent’s model and attachments, case-insensitively, dropping what it may no longer use', async () => {
    const cfg = await agentConfigForWorkPackage(q, 'eng-a', 'desktop-box-claude-1');
    expect(cfg.model).toBe('claude-opus-5');
    // 'other' belongs to eng-b and 'old' is retired — neither reaches the run.
    expect(cfg.mcpServers.map((m) => m.slug)).toEqual(['jira']);
    expect(cfg.mcpServers[0]).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'jira-mcp'],
      requiresAuth: true,
      authEnv: 'MCP_AUTH_JIRA',
    });
    expect(cfg.skills.map((s) => s.slug)).toEqual(['style']);
    expect(cfg.skills[0].content).toBe('# Style');
  });

  it('gives an unknown or unnamed agent the empty config rather than an error', async () => {
    expect(await agentConfigForWorkPackage(q, 'eng-a', 'nobody')).toEqual({ model: null, mcpServers: [], skills: [] });
    expect(await agentConfigForWorkPackage(q, 'eng-a', '')).toEqual({ model: null, mcpServers: [], skills: [] });
  });
});
