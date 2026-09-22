import type express from 'express';
import { z } from 'zod';
import type { Caller } from './roles';

/**
 * The MCP / skills registry (DAT-238): the work-defining config that is not
 * a prompt — MCP servers an agent may reach, and skills (SKILL.md documents)
 * it may load — versioned server-side and attached to agents on the Agents
 * page. "Central definition, local execution": entries are published here by
 * leads, resolved into the work package at claim time, and materialized by the
 * runner in the task workdir (`.mcp.json`, `.claude/skills/<slug>/SKILL.md`).
 *
 * Scope: an entry is either SHARED (engagement_id NULL — every project sees
 * it; admin-only to publish) or scoped to one project (that project's leads
 * publish it). Reads are open to anyone who can see the project.
 *
 * Secrets never live here. An MCP server that needs a credential names the
 * env var the runner injects (`MCP_AUTH_<SLUG>`); desktop clients hold the
 * value encrypted per machine (identity.ts) and devboxes get it from their
 * environment. The registry only records that the credential is required.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Ownership note: these tables were first created by a local dev run against
 * the shared Lakebase, so they are developer-owned (the app SP holds ALL via
 * the schema's default privileges). Future ALTERs on them belong in
 * scripts/dev-migrate.cjs, not here — see docs/development-standards.md.
 */
export const REGISTRY_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.registry_mcp_servers (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT REFERENCES app.engagements(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    args JSONB NOT NULL DEFAULT '[]',
    url TEXT,
    env JSONB NOT NULL DEFAULT '{}',
    requires_auth BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'published',
    created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // One slug per scope: shared entries share one namespace, each project its own.
  `CREATE UNIQUE INDEX IF NOT EXISTS registry_mcp_servers_scope_slug ON app.registry_mcp_servers (COALESCE(engagement_id, ''), lower(slug))`,
  `CREATE TABLE IF NOT EXISTS app.registry_skills (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT REFERENCES app.engagements(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    harnesses JSONB NOT NULL DEFAULT '["claude-code"]',
    status TEXT NOT NULL DEFAULT 'published',
    created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS registry_skills_scope_slug ON app.registry_skills (COALESCE(engagement_id, ''), lower(slug))`,
];

export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export const REGISTRY_STATUSES = ['published', 'retired'] as const;

/** `My Server (v2)` → `my-server-v2`; also the MCP_AUTH_<SLUG> env stem. */
export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** The env var a runner injects for a server that requires auth. */
export const authEnvFor = (slug: string): string => `MCP_AUTH_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

const Slug = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug: lowercase letters, digits and dashes only');

/** Only well-formed, non-secret env: values that look like tokens are refused. */
const EnvMap = z
  .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'env keys are UPPER_SNAKE'), z.string().max(500))
  .refine((m) => Object.keys(m).length <= 20, 'at most 20 env entries')
  .refine((m) => !Object.keys(m).some((k) => /TOKEN|SECRET|PASSWORD|API_KEY|APIKEY/.test(k)), {
    message: 'secrets do not go in the registry — mark the server as requiring auth instead',
  });

const McpServerFields = z.object({
  engagementId: z.string().trim().min(1).nullable().default(null),
  slug: Slug.optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(''),
  transport: z.enum(MCP_TRANSPORTS).default('stdio'),
  command: z.string().trim().max(200).nullable().optional(),
  args: z.array(z.string().max(500)).max(40).default([]),
  url: z.string().trim().url().max(500).nullable().optional(),
  env: EnvMap.default({}),
  requiresAuth: z.boolean().default(false),
  status: z.enum(REGISTRY_STATUSES).default('published'),
});

const McpServerBody = McpServerFields.refine((b) => (b.transport === 'stdio' ? Boolean(b.command) : Boolean(b.url)), {
  message: 'a stdio server needs a command; an http server needs a url',
});

// The transport ↔ command/url rule is re-checked against the merged row in
// the PATCH handler, since a partial body cannot know the stored half.
const McpServerPatch = McpServerFields.partial().omit({ engagementId: true });

const SkillBody = z.object({
  engagementId: z.string().trim().min(1).nullable().default(null),
  slug: Slug.optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(''),
  content: z.string().max(60_000).default(''),
  harnesses: z.array(z.string().trim().min(1).max(40)).max(10).default(['claude-code']),
  status: z.enum(REGISTRY_STATUSES).default('published'),
});

const SkillPatch = SkillBody.partial().omit({ engagementId: true });

export interface RegistryMcpServer {
  id: number;
  engagementId: string | null;
  slug: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  requiresAuth: boolean;
  /** The env var a runner must provide when requiresAuth. */
  authEnv: string | null;
  status: string;
  createdBy: string;
  updatedBy: string;
  updatedAt: string | null;
}

export interface RegistrySkill {
  id: number;
  engagementId: string | null;
  slug: string;
  name: string;
  description: string;
  content: string;
  harnesses: string[];
  status: string;
  createdBy: string;
  updatedBy: string;
  updatedAt: string | null;
}

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
const jsonArr = (v: unknown): string[] => {
  const raw: unknown = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
};
const jsonObj = (v: unknown): Record<string, string> => {
  const raw: unknown = typeof v === 'string' ? JSON.parse(v) : v;
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, val]) => typeof val === 'string')
  ) as Record<string, string>;
};

export function toMcpServer(r: Record<string, unknown>): RegistryMcpServer {
  const slug = txt(r.slug);
  const requiresAuth = r.requires_auth === true || r.requires_auth === 't';
  return {
    id: num(r.id),
    engagementId: r.engagement_id == null ? null : txt(r.engagement_id),
    slug,
    name: txt(r.name),
    description: txt(r.description),
    transport: txt(r.transport) === 'http' ? 'http' : 'stdio',
    command: r.command == null ? null : txt(r.command),
    args: jsonArr(r.args),
    url: r.url == null ? null : txt(r.url),
    env: jsonObj(r.env),
    requiresAuth,
    authEnv: requiresAuth ? authEnvFor(slug) : null,
    status: txt(r.status) || 'published',
    createdBy: txt(r.created_by),
    updatedBy: txt(r.updated_by),
    updatedAt: iso(r.updated_at),
  };
}

export function toSkill(r: Record<string, unknown>): RegistrySkill {
  return {
    id: num(r.id),
    engagementId: r.engagement_id == null ? null : txt(r.engagement_id),
    slug: txt(r.slug),
    name: txt(r.name),
    description: txt(r.description),
    content: txt(r.content),
    harnesses: jsonArr(r.harnesses),
    status: txt(r.status) || 'published',
    createdBy: txt(r.created_by),
    updatedBy: txt(r.updated_by),
    updatedAt: iso(r.updated_at),
  };
}

/** Everything a project can attach: shared entries plus its own. */
export async function loadRegistry(
  q: Query,
  engagementId: string | null
): Promise<{ mcpServers: RegistryMcpServer[]; skills: RegistrySkill[] }> {
  const where = engagementId ? 'engagement_id IS NULL OR engagement_id = $1' : 'engagement_id IS NULL';
  const params = engagementId ? [engagementId] : [];
  const mcpServers = (
    await q(
      `SELECT * FROM app.registry_mcp_servers WHERE ${where} ORDER BY engagement_id NULLS FIRST, lower(name)`,
      params
    )
  ).rows.map(toMcpServer);
  const skills = (
    await q(`SELECT * FROM app.registry_skills WHERE ${where} ORDER BY engagement_id NULLS FIRST, lower(name)`, params)
  ).rows.map(toSkill);
  return { mcpServers, skills };
}

/**
 * Attachments an agent may hold: ids that are shared or belong to the agent's
 * own project, and are still published. Anything else is silently dropped —
 * the drawer only offers valid ids, so a stray id is a stale reference.
 */
export async function validAttachments(
  q: Query,
  engagementId: string,
  ids: { mcpServers?: number[]; skills?: number[] }
): Promise<{ mcpServers: number[]; skills: number[] }> {
  const pick = async (table: string, wanted: number[] | undefined): Promise<number[]> => {
    if (!wanted?.length) return [];
    const rows = (
      await q(
        `SELECT id FROM app.${table} WHERE id IN (${placeholders(wanted, 2)}) AND (engagement_id IS NULL OR engagement_id = $1) AND status = 'published'`,
        [engagementId, ...wanted]
      )
    ).rows.map((r) => num(r.id));
    return wanted.filter((id) => rows.includes(id));
  };
  return {
    mcpServers: await pick('registry_mcp_servers', ids.mcpServers),
    skills: await pick('registry_skills', ids.skills),
  };
}

/** What an agent's attachments resolve to right now — the claim-time payload. */
export async function resolveAttachments(
  q: Query,
  engagementId: string,
  ids: { mcpServers: number[]; skills: number[] }
): Promise<{ mcpServers: RegistryMcpServer[]; skills: RegistrySkill[] }> {
  const valid = await validAttachments(q, engagementId, ids);
  const mcpServers = valid.mcpServers.length
    ? (
        await q(
          `SELECT * FROM app.registry_mcp_servers WHERE id IN (${placeholders(valid.mcpServers)}) ORDER BY lower(name)`,
          valid.mcpServers
        )
      ).rows.map(toMcpServer)
    : [];
  const skills = valid.skills.length
    ? (
        await q(
          `SELECT * FROM app.registry_skills WHERE id IN (${placeholders(valid.skills)}) ORDER BY lower(name)`,
          valid.skills
        )
      ).rows.map(toSkill)
    : [];
  return { mcpServers, skills };
}

/** `$2, $3, $4` for an id list — an IN list rather than `= ANY($1::int[])`, which the test Postgres cannot type. */
const placeholders = (ids: number[], from = 1): string => ids.map((_, i) => `$${i + from}`).join(', ');

const feed = async (q: Query, engagementId: string | null, text: string) => {
  if (!engagementId) return;
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible) VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
    [engagementId, text]
  ).catch(() => {});
};

export function setupRegistryRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>
) {
  /**
   * Publishing is lead-gated: a project's leads publish for that project, only
   * admins publish shared entries (requireLead with a null engagement is the
   * admin check). Reads are open.
   */
  const guard = (req: express.Request, res: express.Response, engagementId: string | null) =>
    requireLead(req, res, engagementId);

  app.get('/api/registry', async (req, res) => {
    try {
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : null;
      res.json(await loadRegistry(q, project));
    } catch (err) {
      console.error('registry load failed:', err);
      res.status(500).json({ error: 'Failed to load the registry' });
    }
  });

  // ---- MCP servers ----

  app.post('/api/registry/mcp-servers', async (req, res) => {
    const parsed = McpServerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid MCP server' });
      return;
    }
    const b = parsed.data;
    try {
      if (b.engagementId && !(await q('SELECT 1 FROM app.engagements WHERE id = $1', [b.engagementId])).rows[0]) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const who = await guard(req, res, b.engagementId);
      if (!who) return;
      const slug = b.slug ?? slugify(b.name);
      if (!slug) {
        res.status(400).json({ error: 'The name must contain a letter or digit' });
        return;
      }
      const dup = (
        await q(`SELECT id FROM app.registry_mcp_servers WHERE COALESCE(engagement_id, '') = $1 AND lower(slug) = $2`, [
          b.engagementId ?? '',
          slug,
        ])
      ).rows[0];
      if (dup) {
        res.status(409).json({ error: `An MCP server with slug ${slug} already exists in this scope` });
        return;
      }
      const inserted = await q(
        `INSERT INTO app.registry_mcp_servers (engagement_id, slug, name, description, transport, command, args, url, env, requires_auth, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
        [
          b.engagementId,
          slug,
          b.name,
          b.description,
          b.transport,
          b.command ?? null,
          JSON.stringify(b.args),
          b.url ?? null,
          JSON.stringify(b.env),
          b.requiresAuth,
          b.status,
          who.email,
        ]
      );
      await feed(q, b.engagementId, `Published MCP server ${b.name} (${slug}) to the registry.`);
      res.status(201).json(toMcpServer(inserted.rows[0]));
    } catch (err) {
      console.error('registry mcp create failed:', err);
      res.status(500).json({ error: 'Failed to publish the MCP server' });
    }
  });

  app.patch('/api/registry/mcp-servers/:id', async (req, res) => {
    const parsed = McpServerPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid MCP server update' });
      return;
    }
    try {
      const row = (await q('SELECT * FROM app.registry_mcp_servers WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'MCP server not found' });
        return;
      }
      const current = toMcpServer(row);
      const who = await guard(req, res, current.engagementId);
      if (!who) return;
      const next = {
        ...current,
        ...parsed.data,
        args: parsed.data.args ?? current.args,
        env: parsed.data.env ?? current.env,
      };
      if ((next.transport === 'stdio' && !next.command) || (next.transport === 'http' && !next.url)) {
        res.status(400).json({ error: 'a stdio server needs a command; an http server needs a url' });
        return;
      }
      if (next.slug !== current.slug) {
        const dup = (
          await q(
            `SELECT id FROM app.registry_mcp_servers WHERE COALESCE(engagement_id, '') = $1 AND lower(slug) = $2 AND id <> $3`,
            [current.engagementId ?? '', next.slug, current.id]
          )
        ).rows[0];
        if (dup) {
          res.status(409).json({ error: `An MCP server with slug ${next.slug} already exists in this scope` });
          return;
        }
      }
      const updated = await q(
        `UPDATE app.registry_mcp_servers
         SET slug = $2, name = $3, description = $4, transport = $5, command = $6, args = $7, url = $8, env = $9, requires_auth = $10, status = $11, updated_by = $12, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          current.id,
          next.slug,
          next.name,
          next.description,
          next.transport,
          next.command ?? null,
          JSON.stringify(next.args),
          next.url ?? null,
          JSON.stringify(next.env),
          next.requiresAuth,
          next.status,
          who.email,
        ]
      );
      await feed(
        q,
        current.engagementId,
        `${next.status === 'retired' && current.status !== 'retired' ? 'Retired' : 'Updated'} MCP server ${next.name} in the registry.`
      );
      res.json(toMcpServer(updated.rows[0]));
    } catch (err) {
      console.error('registry mcp update failed:', err);
      res.status(500).json({ error: 'Failed to update the MCP server' });
    }
  });

  app.delete('/api/registry/mcp-servers/:id', async (req, res) => {
    try {
      const row = (await q('SELECT * FROM app.registry_mcp_servers WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'MCP server not found' });
        return;
      }
      const current = toMcpServer(row);
      const who = await guard(req, res, current.engagementId);
      if (!who) return;
      await q('DELETE FROM app.registry_mcp_servers WHERE id = $1', [current.id]);
      await feed(q, current.engagementId, `Removed MCP server ${current.name} from the registry.`);
      res.json({ ok: true });
    } catch (err) {
      console.error('registry mcp delete failed:', err);
      res.status(500).json({ error: 'Failed to remove the MCP server' });
    }
  });

  // ---- skills ----

  app.post('/api/registry/skills', async (req, res) => {
    const parsed = SkillBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid skill' });
      return;
    }
    const b = parsed.data;
    try {
      if (b.engagementId && !(await q('SELECT 1 FROM app.engagements WHERE id = $1', [b.engagementId])).rows[0]) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const who = await guard(req, res, b.engagementId);
      if (!who) return;
      const slug = b.slug ?? slugify(b.name);
      if (!slug) {
        res.status(400).json({ error: 'The name must contain a letter or digit' });
        return;
      }
      const dup = (
        await q(`SELECT id FROM app.registry_skills WHERE COALESCE(engagement_id, '') = $1 AND lower(slug) = $2`, [
          b.engagementId ?? '',
          slug,
        ])
      ).rows[0];
      if (dup) {
        res.status(409).json({ error: `A skill with slug ${slug} already exists in this scope` });
        return;
      }
      const inserted = await q(
        `INSERT INTO app.registry_skills (engagement_id, slug, name, description, content, harnesses, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,
        [b.engagementId, slug, b.name, b.description, b.content, JSON.stringify(b.harnesses), b.status, who.email]
      );
      await feed(q, b.engagementId, `Published skill ${b.name} (${slug}) to the registry.`);
      res.status(201).json(toSkill(inserted.rows[0]));
    } catch (err) {
      console.error('registry skill create failed:', err);
      res.status(500).json({ error: 'Failed to publish the skill' });
    }
  });

  app.patch('/api/registry/skills/:id', async (req, res) => {
    const parsed = SkillPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid skill update' });
      return;
    }
    try {
      const row = (await q('SELECT * FROM app.registry_skills WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Skill not found' });
        return;
      }
      const current = toSkill(row);
      const who = await guard(req, res, current.engagementId);
      if (!who) return;
      const next = { ...current, ...parsed.data, harnesses: parsed.data.harnesses ?? current.harnesses };
      if (next.slug !== current.slug) {
        const dup = (
          await q(
            `SELECT id FROM app.registry_skills WHERE COALESCE(engagement_id, '') = $1 AND lower(slug) = $2 AND id <> $3`,
            [current.engagementId ?? '', next.slug, current.id]
          )
        ).rows[0];
        if (dup) {
          res.status(409).json({ error: `A skill with slug ${next.slug} already exists in this scope` });
          return;
        }
      }
      const updated = await q(
        `UPDATE app.registry_skills
         SET slug = $2, name = $3, description = $4, content = $5, harnesses = $6, status = $7, updated_by = $8, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          current.id,
          next.slug,
          next.name,
          next.description,
          next.content,
          JSON.stringify(next.harnesses),
          next.status,
          who.email,
        ]
      );
      await feed(
        q,
        current.engagementId,
        `${next.status === 'retired' && current.status !== 'retired' ? 'Retired' : 'Updated'} skill ${next.name} in the registry.`
      );
      res.json(toSkill(updated.rows[0]));
    } catch (err) {
      console.error('registry skill update failed:', err);
      res.status(500).json({ error: 'Failed to update the skill' });
    }
  });

  app.delete('/api/registry/skills/:id', async (req, res) => {
    try {
      const row = (await q('SELECT * FROM app.registry_skills WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Skill not found' });
        return;
      }
      const current = toSkill(row);
      const who = await guard(req, res, current.engagementId);
      if (!who) return;
      await q('DELETE FROM app.registry_skills WHERE id = $1', [current.id]);
      await feed(q, current.engagementId, `Removed skill ${current.name} from the registry.`);
      res.json({ ok: true });
    } catch (err) {
      console.error('registry skill delete failed:', err);
      res.status(500).json({ error: 'Failed to remove the skill' });
    }
  });
}
