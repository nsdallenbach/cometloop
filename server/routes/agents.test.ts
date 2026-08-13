import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { PROJECT_AGENTS_SCHEMA_SQL, inferHarness, loadAgentsOverview } from './agents';
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
