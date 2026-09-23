import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  FOREIGN_KEYS,
  GLOBAL_TABLES,
  PRIMARY_KEYS,
  TENANCY_SCHEMA_SQL,
  TENANT_DIRECTORY_SQL,
  TENANT_TABLES,
  UNIQUE_CONSTRAINTS,
  UNIQUE_INDEXES,
  tablesCreatedBy,
  tenancySchemaSql,
  tenancyTestSql,
} from './tenancy';
import { BOOT_SCHEMA_SQL } from '../routes/api';
import { DEFAULT_TENANT_ID } from './tenant-context';

/**
 * The migration is generated from lists; these tests keep the lists honest
 * against the module arrays (a new table cannot be forgotten) and exercise
 * the pg-mem-safe subset the route tests use. The DO-block / RLS statements
 * themselves need real Postgres — that is `server/tenancy.integration.test.ts`.
 */

const moduleTables = tablesCreatedBy(BOOT_SCHEMA_SQL);

describe('tenant table lists', () => {
  it('cover every app.* table the boot arrays create, and nothing else', () => {
    const listed = new Set<string>([...TENANT_TABLES, ...GLOBAL_TABLES]);
    const missing = moduleTables.filter((t) => !listed.has(t));
    expect(missing, 'tables created by a *_SCHEMA_SQL array but not listed in tenancy.ts').toEqual([]);
    const stale = TENANT_TABLES.filter((t) => !moduleTables.includes(t));
    expect(stale, 'tenancy.ts lists tables no array creates').toEqual([]);
  });

  it('keeps the global allowlist to the tenant directory', () => {
    expect([...GLOBAL_TABLES]).toEqual(['tenants', 'tenant_members']);
    expect(tablesCreatedBy(TENANT_DIRECTORY_SQL).sort()).toEqual([...GLOBAL_TABLES].sort());
  });

  it('is 45 tenant tables, as the architecture doc counts them', () => {
    expect(TENANT_TABLES.length).toBe(45);
    expect(new Set(TENANT_TABLES).size).toBe(45);
  });
});

describe('composite key rewrites match the module arrays', () => {
  it('rewrites every REFERENCES app.tickets(key) / app.engagements(id) to the composite form', () => {
    const wanted = new Set<string>();
    for (const sql of BOOT_SCHEMA_SQL) {
      const tables = tablesCreatedBy([sql]);
      const alter = /ALTER TABLE app\.(\w+) ADD COLUMN IF NOT EXISTS (\w+)/.exec(sql);
      for (const m of sql.matchAll(/(\w+) TEXT(?: NOT NULL)?(?: UNIQUE)?(?: PRIMARY KEY)? REFERENCES app\.(tickets|engagements)\((key|id)\)/g)) {
        const table = tables[0] ?? alter?.[1];
        if (table) wanted.add(`${table}.${m[1]}->${m[2]}`);
      }
    }
    const have = new Set(FOREIGN_KEYS.map((f) => `${f.table}.${f.column}->${f.ref}`));
    expect([...wanted].filter((w) => !have.has(w)), 'FKs in the arrays missing from FOREIGN_KEYS').toEqual([]);
    expect([...have].filter((h) => !wanted.has(h)), 'FOREIGN_KEYS entries no array declares').toEqual([]);
  });

  it('carries the ON DELETE action of the original FK', () => {
    for (const f of FOREIGN_KEYS) {
      const decl = BOOT_SCHEMA_SQL.find((sql) => tablesCreatedBy([sql])[0] === f.table && sql.includes(`${f.column} TEXT`));
      expect(decl, `${f.table}.${f.column}`).toBeDefined();
      const line = decl!.split('\n').find((l) => l.includes(`${f.column} TEXT`) && l.includes('REFERENCES'))!;
      const onDelete = /ON DELETE (CASCADE|SET NULL)/.exec(line)?.[1] ?? null;
      expect(onDelete, `${f.table}.${f.column}`).toBe(f.onDelete);
    }
  });

  it('gives every human-keyed table a tenant-first primary key', () => {
    for (const [table, columns] of Object.entries(PRIMARY_KEYS)) {
      expect(TENANT_TABLES).toContain(table);
      expect(columns[0]).toBe('tenant_id');
    }
    // The two keys the architecture doc calls out by name.
    expect(PRIMARY_KEYS.tickets).toEqual(['tenant_id', 'key']);
    expect(PRIMARY_KEYS.engagements).toEqual(['tenant_id', 'id']);
    for (const u of [...UNIQUE_CONSTRAINTS, ...UNIQUE_INDEXES]) {
      expect(TENANT_TABLES).toContain(u.table);
    }
    for (const u of UNIQUE_CONSTRAINTS) expect(u.columns[0]).toBe('tenant_id');
    for (const u of UNIQUE_INDEXES) expect(u.expression.startsWith('tenant_id,')).toBe(true);
  });

  it('owns the unique indexes the module arrays used to declare', () => {
    const moduleArrays = BOOT_SCHEMA_SQL.slice(0, BOOT_SCHEMA_SQL.indexOf(TENANCY_SCHEMA_SQL[0]));
    for (const sql of moduleArrays) expect(sql).not.toMatch(/CREATE UNIQUE INDEX/);
    for (const u of UNIQUE_INDEXES) expect(TENANCY_SCHEMA_SQL.join('\n')).toContain(`DROP INDEX IF EXISTS app.${u.oldName}`);
  });
});

describe('generated boot array', () => {
  it('adds tenant_id with the compatibility default to every tenant table, then the context-aware default', () => {
    for (const t of TENANT_TABLES) {
      expect(TENANCY_SCHEMA_SQL).toContain(`ALTER TABLE app.${t} ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_ID}'`);
      expect(TENANCY_SCHEMA_SQL.some((s) => s.startsWith(`ALTER TABLE app.${t} ALTER COLUMN tenant_id SET DEFAULT COALESCE(NULLIF(current_setting('app.tenant_id', true), ''), '${DEFAULT_TENANT_ID}')`))).toBe(true);
    }
  });

  it('enables and forces RLS with one tenant_isolation policy per tenant table, and none on the directory', () => {
    const joined = TENANCY_SCHEMA_SQL.join('\n');
    for (const t of TENANT_TABLES) {
      expect(TENANCY_SCHEMA_SQL).toContain(`ALTER TABLE app.${t} ENABLE ROW LEVEL SECURITY`);
      expect(TENANCY_SCHEMA_SQL).toContain(`ALTER TABLE app.${t} FORCE ROW LEVEL SECURITY`);
      expect(joined).toContain(`CREATE POLICY tenant_isolation ON app.${t} USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`);
    }
    for (const g of GLOBAL_TABLES) {
      expect(joined).not.toContain(`app.${g} ENABLE ROW LEVEL SECURITY`);
      expect(joined).not.toContain(`POLICY tenant_isolation ON app.${g}`);
    }
  });

  it('guards every constraint and policy with a catalog check so a second boot is a no-op', () => {
    const ddl = TENANCY_SCHEMA_SQL.filter((s) => /ADD CONSTRAINT|CREATE POLICY|CREATE ROLE/.test(s));
    expect(ddl.length).toBeGreaterThan(50);
    for (const s of ddl) {
      expect(s.startsWith('DO $$')).toBe(true);
      expect(s).toMatch(/pg_constraint|pg_policies|pg_roles/);
    }
    for (const s of TENANCY_SCHEMA_SQL.filter((sql) => /CREATE (UNIQUE )?INDEX|CREATE TABLE|ADD COLUMN/.test(sql))) {
      expect(s).toMatch(/IF NOT EXISTS/);
    }
  });

  it('runs after every module array and can leave isolation off for the AppKit runtime', () => {
    const idx = BOOT_SCHEMA_SQL.indexOf(TENANCY_SCHEMA_SQL[0]);
    expect(idx).toBeGreaterThan(0);
    expect(BOOT_SCHEMA_SQL.slice(idx)).toEqual([...TENANCY_SCHEMA_SQL]);
    const off = tenancySchemaSql({ isolation: false });
    expect(off.some((s) => s.includes('ROW LEVEL SECURITY'))).toBe(false);
    expect(off.some((s) => s.includes('CREATE ROLE'))).toBe(false);
    expect(off.some((s) => s.includes('ADD COLUMN IF NOT EXISTS tenant_id'))).toBe(true);
  });
});

describe('tenancyTestSql (pg-mem)', () => {
  interface MemPg {
    Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  }
  let q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  const SUPPORT = [
    `CREATE SCHEMA app`,
    `CREATE TABLE app.engagements (id TEXT PRIMARY KEY)`,
    `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL)`,
    `CREATE TABLE app.ticket_activity (ticket_key TEXT NOT NULL, activity_type TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (ticket_key, activity_type))`,
  ];

  beforeEach(async () => {
    const { Pool } = newDb().adapters.createPg() as MemPg;
    const pool = new Pool();
    q = (text, params) => pool.query(text, params);
    for (const sql of SUPPORT) await q(sql);
    for (const sql of tenancyTestSql(SUPPORT)) await q(sql);
  });

  it('reads the tables off the CREATE TABLE statements and skips the rest', () => {
    expect(tablesCreatedBy(SUPPORT)).toEqual(['engagements', 'tickets', 'ticket_activity']);
    expect(tenancyTestSql(SUPPORT).some((s) => s.includes('app.runner_polls'))).toBe(false);
    expect(tenancyTestSql(['tickets'])).toEqual(tenancyTestSql([`CREATE TABLE app.tickets (key TEXT PRIMARY KEY)`]));
  });

  it('gives rows the compatibility tenant and makes the human key unique per tenant', async () => {
    await q(`INSERT INTO app.tickets (key, engagement_id) VALUES ('CL-1', 'e')`);
    expect((await q(`SELECT tenant_id FROM app.tickets`)).rows[0].tenant_id).toBe(DEFAULT_TENANT_ID);
    await expect(q(`INSERT INTO app.tickets (key, engagement_id) VALUES ('CL-1', 'e')`)).rejects.toThrow(/duplicate|unique/i);
    await q(`INSERT INTO app.tickets (tenant_id, key, engagement_id) VALUES ('t_other', 'CL-1', 'e')`);
    expect((await q(`SELECT count(*)::int AS n FROM app.tickets WHERE key = 'CL-1'`)).rows[0].n).toBe(2);
  });

  it('lets the rewritten ON CONFLICT targets resolve', async () => {
    const upsert = () =>
      q(
        `INSERT INTO app.ticket_activity (ticket_key, activity_type) VALUES ('CL-1', 'x')
         ON CONFLICT (tenant_id, ticket_key, activity_type) DO UPDATE SET started_at = NOW()`,
      );
    await upsert();
    await upsert();
    expect((await q(`SELECT count(*)::int AS n FROM app.ticket_activity`)).rows[0].n).toBe(1);
  });
});
