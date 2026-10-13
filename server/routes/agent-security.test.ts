import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newDb } from 'pg-mem';
import type express from 'express';
import {
  ACCESS_LEVEL_ACTIONS,
  AGENT_ACTIONS,
  AGENT_SECURITY_SCHEMA_SQL,
  activeEngagementFor,
  baselineSecurity,
  checkAgentAction,
  decideAction,
  describeChange,
  loadAgentSecurity,
  mergeSecurityUpdate,
  parseSecuritySettings,
  saveAgentSecurity,
  setupAgentSecurityRoutes,
  type AgentSecuritySettings,
} from './agent-security';
import { PROJECT_AGENTS_SCHEMA_SQL } from './agents';
import type { Caller } from './roles';

/**
 * Per-agent security controls (DAT-212) against pg-mem — same in-memory
 * Postgres harness as the agent-map tests, so the rollout migration and the
 * enforcement queries run as they will on Lakebase.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY, client TEXT NOT NULL, name TEXT NOT NULL, health TEXT NOT NULL, phase TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, state TEXT NOT NULL, agent TEXT, last_heartbeat TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, time_label TEXT NOT NULL, reversible BOOLEAN NOT NULL DEFAULT false)`,
];

// The engagements FK is dropped for pg-mem; everything else runs verbatim,
// including the DAT-212 column and its backfill.
const AGENTS_TABLE_SQL = PROJECT_AGENTS_SCHEMA_SQL.map((s) => s.replace(' REFERENCES app.engagements(id) ON DELETE CASCADE', ''));

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

/**
 * Just the rollout half of the schema (the ALTER is skipped — pg-mem creates
 * the column with the rest of the table). Seed rows are inserted without
 * security_settings, exactly like a row written before this feature, and these
 * are the statements that migrate them.
 */
const BACKFILL_SQL = AGENT_SECURITY_SCHEMA_SQL.filter((s) => s.startsWith('UPDATE'));

let q: Query;

/** Boot the schema the way api.ts does, then seed rows and migrate them. */
async function boot(seed: string[] = []): Promise<void> {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...AGENTS_TABLE_SQL]) await q(sql);
  await q(`INSERT INTO app.engagements (id, client, name, health, phase) VALUES ('eng-a', 'ACME', 'Console', 'ok', 'Build')`);
  for (const sql of seed) await q(sql);
  for (const sql of BACKFILL_SQL) await q(sql);
}

const settingsFor = (name: string): Promise<AgentSecuritySettings> => loadAgentSecurity(q, 'eng-a', name);

beforeEach(async () => {
  await boot();
});

describe('baselineSecurity', () => {
  it('gives delivery agents exactly the standard runner scopes', () => {
    const base = baselineSecurity('delivery');
    expect(base).toMatchObject({ enabled: true, accessLevel: 'standard', updatedBy: null });
    expect(base.allowedActions).toEqual(ACCESS_LEVEL_ACTIONS.standard);
    expect(base.allowedActions).not.toContain('pr_review');
  });

  it('keeps the review gate working without granting it runner privileges', () => {
    const base = baselineSecurity('pr-reviewer');
    expect(base.enabled).toBe(true);
    expect(base.allowedActions).toContain('pr_review');
    expect(base.allowedActions).not.toContain('claim_work');
    expect(base.allowedActions).not.toContain('git_credential');
  });
});

describe('parseSecuritySettings', () => {
  it('falls back to the role baseline for empty, null and unparseable values', () => {
    expect(parseSecuritySettings(null, 'delivery')).toEqual(baselineSecurity('delivery'));
    expect(parseSecuritySettings({}, 'pr-reviewer')).toEqual(baselineSecurity('pr-reviewer'));
    expect(parseSecuritySettings('not json', 'delivery')).toEqual(baselineSecurity('delivery'));
    expect(parseSecuritySettings([1, 2, 3], 'delivery')).toEqual(baselineSecurity('delivery'));
  });

  it('reads a stored object and drops unknown actions', () => {
    const parsed = parseSecuritySettings({
      enabled: false,
      accessLevel: 'custom',
      allowedActions: ['claim_work', 'delete_everything'],
      updatedBy: 'lead@example.com',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(parsed).toEqual({
      enabled: false,
      accessLevel: 'custom',
      allowedActions: ['claim_work'],
      updatedBy: 'lead@example.com',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
  });

  it('lets a preset access level override a drifted action list', () => {
    const parsed = parseSecuritySettings({ enabled: true, accessLevel: 'restricted', allowedActions: [...AGENT_ACTIONS] });
    expect(parsed.allowedActions).toEqual([]);
  });

  it('keeps a partial object from locking an agent out', () => {
    // A write that only set enabled must not read back as "no scopes".
    expect(parseSecuritySettings({ enabled: true }, 'delivery').allowedActions).toEqual(ACCESS_LEVEL_ACTIONS.standard);
  });
});

describe('rollout migration', () => {
  it('backfills existing agents with the safe baseline for their role', async () => {
    await boot([
      `INSERT INTO app.project_agents (engagement_id, name, agent_type, role) VALUES ('eng-a', 'runner-1', 'runner', 'delivery')`,
      `INSERT INTO app.project_agents (engagement_id, name, agent_type, role, endpoint_name) VALUES ('eng-a', 'ka-reviewer', 'agentbricks', 'pr-reviewer', 'ka-pr-reviewer')`,
    ]);
    expect(await settingsFor('runner-1')).toEqual(baselineSecurity('delivery'));
    expect(await settingsFor('ka-reviewer')).toEqual(baselineSecurity('pr-reviewer'));
    // No agent is locked out and none gains a scope it did not already exercise.
    expect((await settingsFor('runner-1')).enabled).toBe(true);
    expect((await settingsFor('ka-reviewer')).allowedActions).toContain('pr_review');
  });

  it('is idempotent and never re-grants a scope a lead revoked', async () => {
    await boot([`INSERT INTO app.project_agents (engagement_id, name, role) VALUES ('eng-a', 'runner-1', 'delivery')`]);
    await saveAgentSecurity(q, 'eng-a', 1, { enabled: false, accessLevel: 'restricted' }, 'lead@example.com');
    // Re-running the boot migration must leave the lead's decision alone.
    for (const sql of BACKFILL_SQL) await q(sql);
    const after = await settingsFor('runner-1');
    expect(after.enabled).toBe(false);
    expect(after.allowedActions).toEqual([]);
    expect(after.updatedBy).toBe('lead@example.com');
  });
});

describe('decideAction', () => {
  const base = baselineSecurity('delivery');

  it('allows an action inside the scope', () => {
    expect(decideAction(base, 'claim_work', 'runner-1').allowed).toBe(true);
  });

  it('rejects every action for a disabled agent, with a reason naming the agent', () => {
    const off = { ...base, enabled: false };
    for (const action of AGENT_ACTIONS) {
      const d = decideAction(off, action, 'runner-1');
      expect(d.allowed).toBe(false);
      expect(d.reason).toContain('runner-1');
      expect(d.reason).toContain('disabled');
    }
  });

  it('rejects an out-of-scope action and points at the access level', () => {
    const d = decideAction(base, 'pr_review', 'runner-1');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('standard');
  });
});

describe('checkAgentAction', () => {
  beforeEach(async () => {
    await boot([
      `INSERT INTO app.project_agents (engagement_id, name, role) VALUES ('eng-a', 'runner-1', 'delivery')`,
      `INSERT INTO app.project_agents (engagement_id, name, role) VALUES ('eng-a', 'runner-2', 'delivery')`,
    ]);
  });

  it('allows an agent with no stored record at all — enforcement never locks out', async () => {
    const d = await checkAgentAction(q, { engagementId: 'eng-a', agent: 'brand-new-runner', action: 'claim_work' });
    expect(d.allowed).toBe(true);
  });

  it('blocks a disabled agent and writes the denial to the feed', async () => {
    await saveAgentSecurity(q, 'eng-a', 1, { enabled: false }, 'lead@example.com');
    const d = await checkAgentAction(q, { engagementId: 'eng-a', agent: 'runner-1', action: 'claim_work', detail: 'DAT-1' });
    expect(d.allowed).toBe(false);
    const feed = (await q('SELECT text FROM app.feed_items')).rows;
    expect(feed).toHaveLength(1);
    expect(String(feed[0].text)).toContain('runner-1');
    expect(String(feed[0].text)).toContain('DAT-1');
  });

  it('scopes settings per agent — narrowing one leaves the other untouched', async () => {
    await saveAgentSecurity(q, 'eng-a', 1, { accessLevel: 'restricted' }, 'lead@example.com');
    expect((await checkAgentAction(q, { engagementId: 'eng-a', agent: 'runner-1', action: 'git_credential' })).allowed).toBe(false);
    expect((await checkAgentAction(q, { engagementId: 'eng-a', agent: 'runner-2', action: 'git_credential' })).allowed).toBe(true);
  });

  it('fails open when the settings lookup itself errors', async () => {
    const broken: Query = () => Promise.reject(new Error('connection terminated'));
    const d = await checkAgentAction(broken, { engagementId: 'eng-a', agent: 'runner-1', action: 'git_credential' });
    expect(d.allowed).toBe(true);
  });

  it('is scoped per engagement — the same runner name elsewhere keeps its own settings', async () => {
    await q(`INSERT INTO app.engagements (id, client, name, health, phase) VALUES ('eng-b', 'BETA', 'Portal', 'ok', 'Plan')`);
    await q(`INSERT INTO app.project_agents (engagement_id, name, role, security_settings) VALUES ('eng-b', 'runner-1', 'delivery', '{}')`);
    await saveAgentSecurity(q, 'eng-a', 1, { enabled: false }, 'lead@example.com');
    expect((await checkAgentAction(q, { engagementId: 'eng-a', agent: 'runner-1', action: 'claim_work' })).allowed).toBe(false);
    expect((await checkAgentAction(q, { engagementId: 'eng-b', agent: 'runner-1', action: 'claim_work' })).allowed).toBe(true);
  });
});

describe('mergeSecurityUpdate', () => {
  const base = baselineSecurity('delivery');

  it('rewrites the action list from a preset so a level cannot drift from its label', () => {
    const next = mergeSecurityUpdate(base, { accessLevel: 'elevated', allowedActions: [] }, 'lead@example.com');
    expect(next.allowedActions).toEqual(ACCESS_LEVEL_ACTIONS.elevated);
  });

  it('treats a bare action list as a custom scope and stamps the actor', () => {
    const next = mergeSecurityUpdate(base, { allowedActions: ['pr_review'] }, 'lead@example.com');
    expect(next).toMatchObject({ accessLevel: 'custom', allowedActions: ['pr_review'], updatedBy: 'lead@example.com' });
    expect(next.updatedAt).toBeTruthy();
  });

  it('leaves untouched fields alone', () => {
    const next = mergeSecurityUpdate(base, { enabled: false }, 'lead@example.com');
    expect(next.accessLevel).toBe('standard');
    expect(next.allowedActions).toEqual(base.allowedActions);
  });
});

describe('activeEngagementFor', () => {
  it('resolves the engagement of the agent’s live claim, and null when it holds none', async () => {
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-1', 'eng-a', 'working', 'runner-1')`);
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-2', 'eng-a', 'done', 'runner-9')`);
    expect(await activeEngagementFor(q, 'runner-1')).toBe('eng-a');
    expect(await activeEngagementFor(q, 'runner-9')).toBeNull();
  });
});

describe('describeChange', () => {
  it('summarizes what actually changed', () => {
    const before = baselineSecurity('delivery');
    const after = mergeSecurityUpdate(before, { enabled: false, accessLevel: 'restricted' }, 'lead@example.com');
    const text = describeChange(before, after, 'runner-1');
    expect(text).toContain('disabled');
    expect(text).toContain('revoked');
    expect(describeChange(before, before, 'runner-1')).toContain('no change');
  });
});

// ---------- routes: who may change an agent's security settings ----------

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;

/** Captures the handlers setupAgentSecurityRoutes registers, no express needed. */
function captureRoutes(requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, h: Handler) => routes.set(`GET ${path}`, h),
    put: (path: string, h: Handler) => routes.set(`PUT ${path}`, h),
  } as unknown as express.Application;
  setupAgentSecurityRoutes(app, q, requireLead);
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

const leadGuard = (): Promise<Caller | null> => Promise.resolve({ email: 'lead@example.com', role: 'lead' });
/** Stands in for requireLead's own 403 path (developer, or a lead on another project). */
const denyGuard = (_req: express.Request, res: express.Response): Promise<Caller | null> => {
  res.status(403).json({ error: 'Engagement lead access required for this project' });
  return Promise.resolve(null);
};

describe('PUT /api/projects/:id/agents/:agentId/security', () => {
  beforeEach(async () => {
    await boot([`INSERT INTO app.project_agents (engagement_id, name, role) VALUES ('eng-a', 'runner-1', 'delivery')`]);
  });

  const call = async (
    routes: Map<string, Handler>,
    method: string,
    path: string,
    params: Record<string, string>,
    body?: unknown,
  ) => {
    const res = fakeRes();
    await routes.get(`${method} ${path}`)?.({ params, body } as unknown as express.Request, res as unknown as express.Response);
    return res;
  };

  it('saves an edit for a lead and records who made it', async () => {
    const routes = captureRoutes(leadGuard);
    const res = await call(routes, 'PUT', '/api/projects/:id/agents/:agentId/security', { id: 'eng-a', agentId: '1' }, { enabled: false, accessLevel: 'restricted' });
    expect(res.statusCode).toBe(200);
    const saved = await settingsFor('runner-1');
    expect(saved).toMatchObject({ enabled: false, accessLevel: 'restricted', updatedBy: 'lead@example.com' });
    expect(saved.allowedActions).toEqual([]);
  });

  it('rejects an unauthorized caller and leaves the settings untouched', async () => {
    const routes = captureRoutes(denyGuard);
    const res = await call(routes, 'PUT', '/api/projects/:id/agents/:agentId/security', { id: 'eng-a', agentId: '1' }, { enabled: false });
    expect(res.statusCode).toBe(403);
    expect(await settingsFor('runner-1')).toEqual(baselineSecurity('delivery'));
  });

  it('rejects an invalid action before it reaches the authorization check', async () => {
    const guard = vi.fn(leadGuard);
    const routes = captureRoutes(guard);
    const res = await call(routes, 'PUT', '/api/projects/:id/agents/:agentId/security', { id: 'eng-a', agentId: '1' }, { allowedActions: ['rm_-rf'] });
    expect(res.statusCode).toBe(400);
    expect(guard).not.toHaveBeenCalled();
  });

  it('404s for an agent that is not on the project', async () => {
    const routes = captureRoutes(leadGuard);
    const res = await call(routes, 'PUT', '/api/projects/:id/agents/:agentId/security', { id: 'eng-b', agentId: '1' }, { enabled: false });
    expect(res.statusCode).toBe(404);
  });

  it('reads settings back for any caller', async () => {
    const routes = captureRoutes(denyGuard);
    const res = await call(routes, 'GET', '/api/projects/:id/agents/:agentId/security', { id: 'eng-a', agentId: '1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ name: 'runner-1', security: baselineSecurity('delivery') });
  });
});
