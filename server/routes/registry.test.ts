import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import type express from 'express';
import type { Identity } from './roles';
import {
  REGISTRY_SCHEMA_SQL,
  authEnvFor,
  loadRegistry,
  resolveAttachments,
  setupRegistryRoutes,
  slugify,
  validAttachments,
} from './registry';

/**
 * Registry routes against pg-mem: scope rules (shared vs project), the lead
 * gate, slug uniqueness per scope, the secret refusal, and the attachment
 * resolution the claim path relies on.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY, client TEXT NOT NULL, name TEXT NOT NULL)`,
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT, actor TEXT, text TEXT, time_label TEXT, reversible BOOLEAN)`,
];

// pg-mem cannot index an expression over COALESCE; uniqueness is exercised by
// the route's own duplicate check, which is what production hits first anyway.
const REGISTRY_TABLES = REGISTRY_SCHEMA_SQL.filter((s) => !s.includes('CREATE UNIQUE INDEX')).map((s) =>
  s.replace(' REFERENCES app.engagements(id) ON DELETE CASCADE', '')
);

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...REGISTRY_TABLES]) await q(sql);
  await q(
    `INSERT INTO app.engagements (id, client, name) VALUES ('eng-a', 'ACME', 'Console'), ('eng-b', 'BETA', 'Portal')`
  );
});

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;

function captureRoutes(
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>
) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, h: Handler) => routes.set(`GET ${path}`, h),
    post: (path: string, h: Handler) => routes.set(`POST ${path}`, h),
    patch: (path: string, h: Handler) => routes.set(`PATCH ${path}`, h),
    delete: (path: string, h: Handler) => routes.set(`DELETE ${path}`, h),
  } as unknown as express.Application;
  setupRegistryRoutes(app, q, requireLead);
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

const call = async (
  routes: Map<string, Handler>,
  method: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
  query?: Record<string, string>
) => {
  const res = fakeRes();
  await routes.get(`${method} ${path}`)?.(
    { params, body, query: query ?? {} } as unknown as express.Request,
    res as unknown as express.Response
  );
  return res;
};

/** A lead of eng-a only: admin-only (shared) writes and eng-b writes are refused. */
const leadOfA = (
  _req: express.Request,
  res: express.Response,
  engagementId: string | null
): Promise<Identity | null> => {
  if (engagementId === 'eng-a') return Promise.resolve({ email: 'lead@datavail.com', role: 'lead' });
  res.status(403).json({ error: 'Engagement lead access required for this project' });
  return Promise.resolve(null);
};
const admin = (): Promise<Identity | null> => Promise.resolve({ email: 'admin@datavail.com', role: 'admin' });

describe('slugs', () => {
  it('derives a stable slug and the auth env stem from a name', () => {
    expect(slugify('  Jira Cloud (prod) ')).toBe('jira-cloud-prod');
    expect(authEnvFor('jira-cloud-prod')).toBe('MCP_AUTH_JIRA_CLOUD_PROD');
  });
});

describe('POST /api/registry/mcp-servers', () => {
  it('lets a project lead publish to their project and refuses shared or other-project scope', async () => {
    const routes = captureRoutes(leadOfA);
    const ok = await call(
      routes,
      'POST',
      '/api/registry/mcp-servers',
      {},
      { engagementId: 'eng-a', name: 'Jira', command: 'npx', args: ['-y', 'jira-mcp'], requiresAuth: true }
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.body).toMatchObject({
      slug: 'jira',
      engagementId: 'eng-a',
      transport: 'stdio',
      authEnv: 'MCP_AUTH_JIRA',
    });

    expect(
      (
        await call(
          routes,
          'POST',
          '/api/registry/mcp-servers',
          {},
          { engagementId: null, name: 'Shared', command: 'x' }
        )
      ).statusCode
    ).toBe(403);
    expect(
      (
        await call(
          routes,
          'POST',
          '/api/registry/mcp-servers',
          {},
          { engagementId: 'eng-b', name: 'Other', command: 'x' }
        )
      ).statusCode
    ).toBe(403);
    expect((await q('SELECT count(*)::int AS n FROM app.registry_mcp_servers')).rows[0].n).toBe(1);
  });

  it('lets an admin publish a shared entry, keeps slugs unique per scope, and validates transports', async () => {
    const routes = captureRoutes(admin);
    expect(
      (
        await call(
          routes,
          'POST',
          '/api/registry/mcp-servers',
          {},
          { engagementId: null, name: 'GitHub', transport: 'http', url: 'https://mcp.example.com/github' }
        )
      ).statusCode
    ).toBe(201);
    // Same slug, same (shared) scope → 409; same slug on a project → fine.
    expect(
      (
        await call(
          routes,
          'POST',
          '/api/registry/mcp-servers',
          {},
          { engagementId: null, name: 'github', transport: 'http', url: 'https://x.example' }
        )
      ).statusCode
    ).toBe(409);
    expect(
      (
        await call(
          routes,
          'POST',
          '/api/registry/mcp-servers',
          {},
          { engagementId: 'eng-a', name: 'GitHub', transport: 'http', url: 'https://x.example' }
        )
      ).statusCode
    ).toBe(201);
    // An http server without a url, a stdio server without a command.
    expect(
      (
        await call(
          routes,
          'POST',
          '/api/registry/mcp-servers',
          {},
          { engagementId: null, name: 'Broken', transport: 'http' }
        )
      ).statusCode
    ).toBe(400);
    expect(
      (
        await call(
          routes,
          'POST',
          '/api/registry/mcp-servers',
          {},
          { engagementId: null, name: 'Broken2', transport: 'stdio' }
        )
      ).statusCode
    ).toBe(400);
  });

  it('refuses env entries that look like secrets', async () => {
    const routes = captureRoutes(admin);
    const res = await call(
      routes,
      'POST',
      '/api/registry/mcp-servers',
      {},
      { engagementId: null, name: 'Leaky', command: 'x', env: { API_TOKEN: 'abc' } }
    );
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain('secrets');
  });
});

describe('registry reads and attachments', () => {
  beforeEach(async () => {
    const routes = captureRoutes(admin);
    await call(
      routes,
      'POST',
      '/api/registry/mcp-servers',
      {},
      { engagementId: null, name: 'Shared MCP', command: 'x' }
    );
    await call(routes, 'POST', '/api/registry/mcp-servers', {}, { engagementId: 'eng-a', name: 'A MCP', command: 'x' });
    await call(routes, 'POST', '/api/registry/mcp-servers', {}, { engagementId: 'eng-b', name: 'B MCP', command: 'x' });
    await call(
      routes,
      'POST',
      '/api/registry/skills',
      {},
      { engagementId: null, name: 'Review style', content: '# Review\nBe kind.' }
    );
    await call(
      routes,
      'POST',
      '/api/registry/skills',
      {},
      { engagementId: 'eng-a', name: 'A skill', content: 'x', status: 'retired' }
    );
  });

  it('shows a project the shared entries plus its own, never those of another project', async () => {
    const forA = await loadRegistry(q, 'eng-a');
    expect(forA.mcpServers.map((m) => m.name)).toEqual(['Shared MCP', 'A MCP']);
    expect(forA.skills.map((s) => s.name)).toEqual(['Review style', 'A skill']);
    const shared = await loadRegistry(q, null);
    expect(shared.mcpServers.map((m) => m.name)).toEqual(['Shared MCP']);
  });

  it('keeps only attachments that are visible to the project and still published', async () => {
    const reg = await loadRegistry(q, 'eng-b');
    const bMcp = reg.mcpServers.find((m) => m.name === 'B MCP')!.id;
    const sharedMcp = reg.mcpServers.find((m) => m.name === 'Shared MCP')!.id;
    const aMcp = (await q(`SELECT id FROM app.registry_mcp_servers WHERE name = 'A MCP'`)).rows[0].id as number;
    const retiredSkill = (await q(`SELECT id FROM app.registry_skills WHERE name = 'A skill'`)).rows[0].id as number;
    const sharedSkill = (await q(`SELECT id FROM app.registry_skills WHERE name = 'Review style'`)).rows[0]
      .id as number;

    const valid = await validAttachments(q, 'eng-b', {
      mcpServers: [bMcp, sharedMcp, aMcp, 999],
      skills: [retiredSkill, sharedSkill],
    });
    expect(valid).toEqual({ mcpServers: [bMcp, sharedMcp], skills: [sharedSkill] });

    const resolved = await resolveAttachments(q, 'eng-b', valid);
    expect(resolved.mcpServers.map((m) => m.name)).toEqual(['B MCP', 'Shared MCP']);
    expect(resolved.skills[0]).toMatchObject({ slug: 'review-style', content: '# Review\nBe kind.' });
  });

  it('gates updates and deletes by the entry’s own scope', async () => {
    const routes = captureRoutes(leadOfA);
    const shared = (await q(`SELECT id FROM app.registry_mcp_servers WHERE name = 'Shared MCP'`)).rows[0].id as number;
    const own = (await q(`SELECT id FROM app.registry_mcp_servers WHERE name = 'A MCP'`)).rows[0].id as number;
    expect(
      (await call(routes, 'PATCH', '/api/registry/mcp-servers/:id', { id: String(shared) }, { name: 'Hijack' }))
        .statusCode
    ).toBe(403);
    expect(
      (
        await call(
          routes,
          'PATCH',
          '/api/registry/mcp-servers/:id',
          { id: String(own) },
          { name: 'A MCP v2', status: 'retired' }
        )
      ).statusCode
    ).toBe(200);
    expect((await q('SELECT name, status FROM app.registry_mcp_servers WHERE id = $1', [own])).rows[0]).toMatchObject({
      name: 'A MCP v2',
      status: 'retired',
    });
    expect(
      (await call(routes, 'DELETE', '/api/registry/mcp-servers/:id', { id: String(shared) }, undefined)).statusCode
    ).toBe(403);
    expect(
      (await call(routes, 'DELETE', '/api/registry/mcp-servers/:id', { id: String(own) }, undefined)).statusCode
    ).toBe(200);
    expect((await call(routes, 'DELETE', '/api/registry/mcp-servers/:id', { id: '4242' }, undefined)).statusCode).toBe(
      404
    );
  });
});
