import { DEFAULT_TENANT_ID, TENANT_SETTING } from './tenant-context';

/**
 * Multi-tenancy schema (platform-architecture phase 2): one shared database,
 * `tenant_id` on every `app.*` table, human keys unique per tenant, and
 * Postgres row-level security doing the isolation.
 *
 * `TENANCY_SCHEMA_SQL` is the last boot array `initSchema` runs, after every
 * module's own `*_SCHEMA_SQL`, so the tables it rewrites already exist. It is
 * forward-only and idempotent: a second boot is a no-op. Every statement is
 * generated from the tables below rather than written by hand so a table
 * cannot be forgotten (`tenancy.test.ts` cross-checks the lists against the
 * `CREATE TABLE`s in the module arrays).
 *
 * What it does, in order:
 *
 *  1. `app.tenants` / `app.tenant_members` (the only global tables — the
 *     tenant directory has to be readable before a tenant is known) and the
 *     first tenant, `t_cometloop`, which every pre-tenancy row belongs to.
 *  2. `ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 't_cometloop'`
 *     on every tenant table — the constant default backfills existing rows
 *     without a table rewrite — then swaps the default to the request's
 *     tenant (`current_setting('app.tenant_id')`, falling back to
 *     `t_cometloop`). Route modules never name `tenant_id` in their INSERTs;
 *     the default lands the row in the caller's tenant. The fallback is the
 *     single-tenant compatibility path and is phase 3's first cleanup.
 *  3. Composite keys. Every primary key / unique constraint on a human key
 *     (`tickets.key`, `engagements.id`, the per-engagement singleton tables,
 *     `UNIQUE (engagement_id, …)` / `UNIQUE (ticket_key, …)`) becomes
 *     `(tenant_id, …)`, and every foreign key onto those keys is rewritten to
 *     the composite form. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so
 *     each rewrite is a `DO $$ … $$` block that inspects `pg_constraint`
 *     (live names, live definitions — not the names the boot arrays assume).
 *     Dropping the old primary key `CASCADE`s the old single-column FKs away;
 *     the composite ones are added right after.
 *  4. Row-level security: ENABLE + FORCE + one `tenant_isolation` policy per
 *     table, `USING` and `WITH CHECK` on `tenant_id = current_setting(…)`.
 *
 * Who the policies apply to — read this before touching the role logic:
 * Neon's `neondb_owner` (the role in `DATABASE_URL`) owns every table AND
 * carries `BYPASSRLS`. `FORCE ROW LEVEL SECURITY` makes an owner subject to
 * its policies, but a role with `BYPASSRLS` skips them regardless — so on
 * Neon FORCE alone would enforce nothing. The migration therefore creates a
 * `cometloop_app` role (NOLOGIN, NOBYPASSRLS, plain DML grants) and the
 * scoped query layer (`scoped-query.ts`) runs every tenant query as
 * `SET LOCAL ROLE cometloop_app` inside a transaction. The boot migration
 * itself keeps running as the owner, which is exactly what lets it ALTER
 * tables and backfill without a tenant set; the same goes for the tenant
 * directory reads and the one-off scripts. FORCE is still set so an owner
 * without BYPASSRLS (docker-compose's Postgres, a future non-Neon host) is
 * covered too.
 */

/** Every tenant-scoped `app.*` table, one entry per `CREATE TABLE IF NOT EXISTS` in the boot arrays. */
export const TENANT_TABLES = [
  // SCHEMA_SQL (api.ts)
  'engagements',
  'tickets',
  'sources',
  'team_members',
  'suggestions',
  'engagement_members',
  'engagement_leads',
  'ticket_comments',
  'feed_items',
  // NOTIFICATION_SCHEMA_SQL
  'notifications',
  // REPO_SCHEMA_SQL
  'repo_connections',
  'repo_prs',
  'repo_commits',
  // AGENT_SCHEMA_SQL, PROJECT_AGENTS_SCHEMA_SQL
  'agent_tasks',
  'project_agents',
  // REGISTRY_SCHEMA_SQL
  'registry_mcp_servers',
  'registry_skills',
  // FLEET_SCHEMA_SQL, RUNNER_LOAD_BALANCING_SCHEMA_SQL
  'runner_polls',
  'runner_load_balancing',
  // TOOL_CALL_SCHEMA_SQL, TOKEN_USAGE_SCHEMA_SQL
  'agent_tool_calls',
  'run_token_usage',
  // COORDINATION_SCHEMA_SQL
  'coordination_messages',
  'branch_activity',
  // DEPLOY_EVENTS_SCHEMA_SQL
  'deploy_events',
  // STANDARDS_SCHEMA_SQL, PROJECT_CONFIG_SCHEMA_SQL
  'project_standards',
  'project_runner_configs',
  // TICKET_*_SCHEMA_SQL, LINKS, ESTIMATE, ATTACHMENT
  'ticket_events',
  'ticket_activity',
  'ticket_links',
  'ticket_estimates',
  'ticket_attachments',
  'ticket_rejections',
  // FILE_LIBRARY_SCHEMA_SQL
  'file_folders',
  'file_entries',
  'file_rules',
  'file_rule_runs',
  // PR_REVIEW, PR_REQUEUE, PR_ESCALATION
  'pr_reviews',
  'pr_requeues',
  'pr_review_escalations',
  // PLANNING_REVIEW_SCHEMA_SQL, STALE_NUDGE_SCHEMA_SQL
  'planning_reviews',
  'nudge_settings',
  'ticket_nudges',
  // WORKFLOWS_SCHEMA_SQL
  'workflows',
  // MODEL_CONFIG_SCHEMA_SQL (server/llm/config.ts, incl. MODEL_PRICES_SCHEMA_SQL from pricing.ts)
  'model_providers',
  'model_roles',
  'model_prices',
] as const;

/** Tables that are not tenant-scoped: the tenant directory itself. */
export const GLOBAL_TABLES = ['tenants', 'tenant_members', 'desktop_handoffs', 'desktop_sessions'] as const;

/** Role every tenant-scoped query runs as (see the header). */
export const APP_ROLE = 'cometloop_app';

/**
 * Primary keys that carried a human key and now lead with `tenant_id`.
 * `SERIAL` ids stay as they are — a globally unique surrogate is fine, RLS
 * hides the rows. The `file_*` / `ticket_attachments` `id TEXT` keys are
 * random UUIDs, so they stay too.
 */
export const PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  engagements: ['tenant_id', 'id'],
  tickets: ['tenant_id', 'key'],
  suggestions: ['tenant_id', 'id'],
  engagement_members: ['tenant_id', 'engagement_id', 'member_id'],
  engagement_leads: ['tenant_id', 'engagement_id', 'email'],
  branch_activity: ['tenant_id', 'branch_name'],
  runner_polls: ['tenant_id', 'agent'],
  planning_reviews: ['tenant_id', 'ticket_key'],
  project_runner_configs: ['tenant_id', 'engagement_id'],
  project_standards: ['tenant_id', 'engagement_id'],
  nudge_settings: ['tenant_id', 'engagement_id'],
  runner_load_balancing: ['tenant_id', 'engagement_id', 'model_type', 'runner_name'],
  ticket_activity: ['tenant_id', 'ticket_key', 'activity_type'],
  model_roles: ['tenant_id', 'role'],
  model_prices: ['tenant_id', 'model'],
};

export interface UniqueConstraintRewrite {
  table: string;
  /** Columns of the pre-tenancy inline `UNIQUE (…)`, used to find it by definition. */
  oldColumns: readonly string[];
  name: string;
  columns: readonly string[];
}

/** Inline `UNIQUE (…)` constraints over human keys. */
export const UNIQUE_CONSTRAINTS: readonly UniqueConstraintRewrite[] = [
  {
    table: 'repo_connections',
    oldColumns: ['engagement_id'],
    name: 'repo_connections_tenant_engagement_id_key',
    columns: ['tenant_id', 'engagement_id'],
  },
  {
    table: 'ticket_links',
    oldColumns: ['ticket_key', 'linked_key', 'type'],
    name: 'ticket_links_tenant_link_key',
    columns: ['tenant_id', 'ticket_key', 'linked_key', 'type'],
  },
  {
    table: 'file_folders',
    oldColumns: ['engagement_id', 'parent_id', 'name'],
    name: 'file_folders_tenant_folder_key',
    columns: ['tenant_id', 'engagement_id', 'parent_id', 'name'],
  },
];

export interface UniqueIndexRewrite {
  table: string;
  /** Pre-tenancy index name (dropped); the module arrays no longer create it. */
  oldName: string;
  name: string;
  expression: string;
  where?: string;
}

/**
 * Unique indexes that used to live in the module arrays. They moved here so
 * the boot does not recreate the global version every start only for this
 * array to drop it again. Each is the old index with `tenant_id` in front.
 */
export const UNIQUE_INDEXES: readonly UniqueIndexRewrite[] = [
  {
    table: 'team_members',
    oldName: 'team_members_email_unique',
    name: 'team_members_tenant_email_unique',
    expression: 'tenant_id, LOWER(email)',
    where: 'email IS NOT NULL',
  },
  {
    // One active run per ticket; completed/cancelled runs stay as history.
    table: 'agent_tasks',
    oldName: 'agent_tasks_active_ticket',
    name: 'agent_tasks_tenant_active_ticket',
    expression: 'tenant_id, ticket_key',
    where: `state IN ('queued','claimed','working')`,
  },
  {
    table: 'project_agents',
    oldName: 'project_agents_eng_name',
    name: 'project_agents_tenant_eng_name',
    expression: 'tenant_id, engagement_id, lower(name)',
  },
  {
    // One slug per scope: shared entries share one namespace (within the tenant), each project its own.
    table: 'registry_mcp_servers',
    oldName: 'registry_mcp_servers_scope_slug',
    name: 'registry_mcp_servers_tenant_scope_slug',
    expression: `tenant_id, COALESCE(engagement_id, ''), lower(slug)`,
  },
  {
    table: 'registry_skills',
    oldName: 'registry_skills_scope_slug',
    name: 'registry_skills_tenant_scope_slug',
    expression: `tenant_id, COALESCE(engagement_id, ''), lower(slug)`,
  },
  {
    // The one-nudge-per-quiet-period claim (stale-nudges.ts).
    table: 'ticket_nudges',
    oldName: 'ticket_nudges_quiet_period',
    name: 'ticket_nudges_tenant_quiet_period',
    expression: 'tenant_id, ticket_key, quiet_since',
  },
];

/**
 * Plain indexes over the composite (tenant-first) key shape that the board's
 * detail route needs. Each one earned its place on an EXPLAIN (ANALYZE) of
 * that route against a copy of production (docs/platform-architecture.md §4):
 * candidates the planner ignored at this data size were not added.
 */
export const PERFORMANCE_INDEXES: readonly string[] = [
  // The feed page: latest N for an engagement, and the older-page cursor.
  `CREATE INDEX IF NOT EXISTS feed_items_tenant_engagement_created ON app.feed_items (tenant_id, engagement_id, created_at DESC, id DESC)`,
  // The detail query's two repo_prs LATERALs run once per ticket; this turns
  // a per-ticket seq scan of repo_prs into an index probe (13 ms → 5 ms on 177 tickets).
  `CREATE INDEX IF NOT EXISTS repo_prs_tenant_ticket ON app.repo_prs (tenant_id, ticket_key)`,
];

export interface ForeignKeyRewrite {
  table: string;
  column: string;
  ref: 'engagements' | 'tickets';
  onDelete: 'CASCADE' | 'SET NULL' | null;
}

const fk = (table: string, column: string, ref: 'engagements' | 'tickets', onDelete: ForeignKeyRewrite['onDelete']): ForeignKeyRewrite => ({
  table,
  column,
  ref,
  onDelete,
});

/**
 * Every `REFERENCES app.engagements(id)` / `REFERENCES app.tickets(key)` in
 * the module arrays, as the composite form. `tenancy.test.ts` asserts the
 * list matches the arrays.
 */
export const FOREIGN_KEYS: readonly ForeignKeyRewrite[] = [
  fk('tickets', 'engagement_id', 'engagements', null),
  fk('sources', 'engagement_id', 'engagements', null),
  fk('engagement_members', 'engagement_id', 'engagements', 'CASCADE'),
  fk('engagement_leads', 'engagement_id', 'engagements', 'CASCADE'),
  fk('feed_items', 'engagement_id', 'engagements', null),
  fk('notifications', 'engagement_id', 'engagements', 'CASCADE'),
  fk('repo_connections', 'engagement_id', 'engagements', 'CASCADE'),
  fk('agent_tasks', 'engagement_id', 'engagements', 'CASCADE'),
  fk('project_agents', 'engagement_id', 'engagements', 'CASCADE'),
  fk('registry_mcp_servers', 'engagement_id', 'engagements', 'CASCADE'),
  fk('registry_skills', 'engagement_id', 'engagements', 'CASCADE'),
  fk('runner_load_balancing', 'engagement_id', 'engagements', 'CASCADE'),
  fk('deploy_events', 'engagement_id', 'engagements', 'CASCADE'),
  fk('ticket_estimates', 'engagement_id', 'engagements', 'CASCADE'),
  fk('file_folders', 'engagement_id', 'engagements', 'CASCADE'),
  fk('file_entries', 'engagement_id', 'engagements', 'CASCADE'),
  fk('file_rules', 'engagement_id', 'engagements', 'CASCADE'),
  fk('project_standards', 'engagement_id', 'engagements', 'CASCADE'),
  fk('project_runner_configs', 'engagement_id', 'engagements', 'CASCADE'),
  fk('nudge_settings', 'engagement_id', 'engagements', 'CASCADE'),
  fk('ticket_comments', 'ticket_key', 'tickets', 'CASCADE'),
  fk('notifications', 'ticket_key', 'tickets', 'CASCADE'),
  fk('agent_tasks', 'ticket_key', 'tickets', 'CASCADE'),
  fk('deploy_events', 'ticket_key', 'tickets', 'CASCADE'),
  fk('ticket_estimates', 'ticket_key', 'tickets', 'CASCADE'),
  fk('file_rules', 'target_ticket', 'tickets', 'SET NULL'),
  fk('file_rule_runs', 'result_ticket', 'tickets', 'SET NULL'),
  fk('ticket_events', 'ticket_key', 'tickets', 'CASCADE'),
  fk('ticket_activity', 'ticket_key', 'tickets', 'CASCADE'),
  fk('ticket_links', 'ticket_key', 'tickets', 'CASCADE'),
  fk('ticket_links', 'linked_key', 'tickets', 'CASCADE'),
  fk('ticket_attachments', 'ticket_key', 'tickets', 'CASCADE'),
  fk('ticket_rejections', 'ticket_key', 'tickets', 'CASCADE'),
  fk('ticket_nudges', 'ticket_key', 'tickets', 'CASCADE'),
];

const REF_KEY: Record<ForeignKeyRewrite['ref'], string> = { engagements: 'id', tickets: 'key' };

export const foreignKeyName = (f: ForeignKeyRewrite): string => `${f.table}_${f.column}_tenant_fkey`;

/** The literal every `tenant_id` column defaults to when no tenant is set on the connection. */
const TENANT_DEFAULT_EXPR = `COALESCE(NULLIF(current_setting('${TENANT_SETTING}', true), ''), '${DEFAULT_TENANT_ID}')`;

const policyExpr = `tenant_id = current_setting('${TENANT_SETTING}', true)`;

const cols = (c: readonly string[]) => c.join(', ');

// ---- statement builders (real Postgres) ----

const primaryKeySql = (table: string, columns: readonly string[]): string => `DO $$
DECLARE cur_name TEXT; cur_def TEXT;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO cur_name, cur_def
    FROM pg_constraint WHERE conrelid = 'app.${table}'::regclass AND contype = 'p';
  IF cur_def IS DISTINCT FROM 'PRIMARY KEY (${cols(columns)})' THEN
    IF cur_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE app.${table} DROP CONSTRAINT %I CASCADE', cur_name);
    END IF;
    ALTER TABLE app.${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (${cols(columns)});
  END IF;
END $$`;

const uniqueConstraintSql = (u: UniqueConstraintRewrite): string => `DO $$
DECLARE old_name TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'app.${u.table}'::regclass AND contype = 'u'
                   AND pg_get_constraintdef(oid) = 'UNIQUE (${cols(u.columns)})') THEN
    SELECT conname INTO old_name FROM pg_constraint WHERE conrelid = 'app.${u.table}'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (${cols(u.oldColumns)})';
    IF old_name IS NOT NULL THEN
      EXECUTE format('ALTER TABLE app.${u.table} DROP CONSTRAINT %I CASCADE', old_name);
    END IF;
    ALTER TABLE app.${u.table} ADD CONSTRAINT ${u.name} UNIQUE (${cols(u.columns)});
  END IF;
END $$`;

const foreignKeySql = (f: ForeignKeyRewrite): string => {
  const name = foreignKeyName(f);
  const onDelete = f.onDelete ? ` ON DELETE ${f.onDelete}` : '';
  return `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'app.${f.table}'::regclass) THEN
    ALTER TABLE app.${f.table} ADD CONSTRAINT ${name}
      FOREIGN KEY (tenant_id, ${f.column}) REFERENCES app.${f.ref} (tenant_id, ${REF_KEY[f.ref]})${onDelete};
  END IF;
END $$`;
};

const uniqueIndexSql = (u: UniqueIndexRewrite): string[] => [
  `DROP INDEX IF EXISTS app.${u.oldName}`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${u.name} ON app.${u.table} (${u.expression})${u.where ? ` WHERE ${u.where}` : ''}`,
];

const policySql = (table: string): string[] => [
  `ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`,
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'app' AND tablename = '${table}' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON app.${table} USING (${policyExpr}) WITH CHECK (${policyExpr});
  END IF;
END $$`,
];

/** The tenant directory: global tables, no RLS, readable before a tenant is known. */
export const TENANT_DIRECTORY_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS app.tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `INSERT INTO app.tenants (id, name) VALUES ('${DEFAULT_TENANT_ID}', 'Cometloop') ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS app.tenant_members (
    tenant_id TEXT NOT NULL REFERENCES app.tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tenant_members_tenant_email ON app.tenant_members (tenant_id, LOWER(email))`,
  // The first console admin, so a Better Auth sign-in with that email lands
  // in the default tenant before the organization plugin is wired (phase 3).
  // Set BOOTSTRAP_OWNER_EMAIL for the first boot; later members are added
  // through /api/admin/members. Idempotent, so leaving it set is harmless.
  ...(process.env.BOOTSTRAP_OWNER_EMAIL
    ? [
        `INSERT INTO app.tenant_members (tenant_id, email, role) VALUES ('${DEFAULT_TENANT_ID}', '${process.env.BOOTSTRAP_OWNER_EMAIL.trim().replace(/'/g, "''")}', 'owner')
   ON CONFLICT (tenant_id, LOWER(email)) DO NOTHING`,
      ]
    : []),
];

/** The app role the scoped query layer switches to, plus its grants. Idempotent. */
export const APP_ROLE_SQL: readonly string[] = [
  `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END $$`,
  // The connecting role must be allowed to SET ROLE to it. The creator holds
  // ADMIN OPTION on a role it created, which is what makes this self-grant
  // legal; a superuser (docker-compose) already passes pg_has_role.
  `DO $$
BEGIN
  IF NOT pg_has_role(current_user, '${APP_ROLE}', 'SET') THEN
    EXECUTE format('GRANT ${APP_ROLE} TO %I', current_user);
  END IF;
END $$`,
  `GRANT USAGE ON SCHEMA app TO ${APP_ROLE}`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO ${APP_ROLE}`,
  `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO ${APP_ROLE}`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}`,
];

export interface TenancySchemaOptions {
  /**
   * Include the row-level-security policies and the app role. True on the
   * portable runtime, whose query layer switches role per query. Off on the
   * AppKit runtime, where `lakebase.query` is a bare pool and the setting has
   * nowhere to live — there the columns and composite keys still land, and
   * isolation is single-tenant compatibility only.
   */
  isolation: boolean;
}

/** Build the boot array. `TENANCY_SCHEMA_SQL` is the isolation-on form. */
export function tenancySchemaSql(opts: TenancySchemaOptions): string[] {
  const out: string[] = [...TENANT_DIRECTORY_SQL];
  for (const t of TENANT_TABLES) {
    out.push(`ALTER TABLE app.${t} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`);
    out.push(`ALTER TABLE app.${t} ALTER COLUMN tenant_id SET DEFAULT ${TENANT_DEFAULT_EXPR}`);
  }
  // Keys first (dropping a primary key cascades the old FKs away), then the
  // composite FKs that need the new keys to exist.
  for (const [table, columns] of Object.entries(PRIMARY_KEYS)) out.push(primaryKeySql(table, columns));
  for (const u of UNIQUE_CONSTRAINTS) out.push(uniqueConstraintSql(u));
  for (const u of UNIQUE_INDEXES) out.push(...uniqueIndexSql(u));
  for (const f of FOREIGN_KEYS) out.push(foreignKeySql(f));
  out.push(...PERFORMANCE_INDEXES);
  if (opts.isolation) {
    out.push(...APP_ROLE_SQL);
    for (const t of TENANT_TABLES) out.push(...policySql(t));
  }
  return out;
}

export const TENANCY_SCHEMA_SQL: readonly string[] = tenancySchemaSql({ isolation: true });

const CREATE_TABLE_RE = /CREATE TABLE(?: IF NOT EXISTS)? app\.(\w+)/g;

/** Table names named by `CREATE TABLE … app.X` in a list of statements. */
export function tablesCreatedBy(statements: readonly string[]): string[] {
  const out = new Set<string>();
  for (const sql of statements) for (const m of sql.matchAll(CREATE_TABLE_RE)) out.add(m[1]);
  return [...out];
}

/**
 * The pg-mem-safe subset for route tests: the column, the composite keys and
 * the unique indexes over whichever of the tables the test created — no `DO`
 * blocks, no `current_setting`, no RLS (pg-mem has none). It gives a test the
 * same key shape production has, so `ON CONFLICT (tenant_id, …)` targets
 * resolve. Pass the statements the test ran (tables are read off their
 * `CREATE TABLE`s) or plain table names; tables not created are skipped.
 */
export function tenancyTestSql(created: readonly string[]): string[] {
  const tables = created.some((s) => /\s/.test(s)) ? tablesCreatedBy(created) : [...created];
  const has = new Set(tables);
  const out: string[] = [];
  for (const t of tables) out.push(`ALTER TABLE app.${t} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`);
  for (const [table, columns] of Object.entries(PRIMARY_KEYS)) {
    if (!has.has(table)) continue;
    out.push(`ALTER TABLE app.${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
    out.push(`ALTER TABLE app.${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (${cols(columns)})`);
  }
  for (const u of UNIQUE_CONSTRAINTS) {
    if (!has.has(u.table)) continue;
    out.push(`ALTER TABLE app.${u.table} DROP CONSTRAINT IF EXISTS ${u.table}_${u.oldColumns.join('_')}_key`);
    out.push(`ALTER TABLE app.${u.table} ADD CONSTRAINT ${u.name} UNIQUE (${cols(u.columns)})`);
  }
  for (const u of UNIQUE_INDEXES) {
    if (!has.has(u.table)) continue;
    out.push(...uniqueIndexSql(u));
  }
  return out;
}
