import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPortableDb, type PortableDb } from './portable/db';
import { BOOT_SCHEMA_SQL } from './routes/api';
import { runWithTenant } from './db/tenant-context';
import { APP_ROLE, TENANT_TABLES } from './db/tenancy';

/**
 * Row-level security on real Postgres (platform-architecture phase 2).
 * pg-mem has no RLS, roles or DO blocks, so this file runs only when
 * `TEST_DATABASE_URL` points at a throwaway database — a Neon branch made
 * from production for the run and deleted afterwards:
 *
 *     neon branches create --name phase2-test --parent production
 *     TEST_DATABASE_URL="$(neon connection-string phase2-test --role-name neondb_owner --database-name neondb)" npx vitest run server/tenancy.integration.test.ts
 *     neon branches delete phase2-test
 *
 * Never the production branch, never the main checkout's `.env.local`. The
 * test boots the full schema (every module array plus the tenancy array) the
 * way the server does, so on a production copy it is the migration itself
 * that is under test, on real data.
 */

const url = process.env.TEST_DATABASE_URL?.trim();

const A = 't_itest_a';
const B = 't_itest_b';

interface CatalogSnapshot {
  constraints: unknown[];
  policies: unknown[];
  columns: unknown[];
  indexes: unknown[];
}

describe.skipIf(!url)('tenancy on Postgres', () => {
  let db: PortableDb;
  const admin = (text: string, params?: unknown[]) => db.adminQuery(text, params);
  const q = (text: string, params?: unknown[]) => db.query(text, params);

  /** Run the boot array the way initSchema does, but report every failure instead of only logging it. */
  async function boot(): Promise<string[]> {
    const failures: string[] = [];
    for (const sql of BOOT_SCHEMA_SQL) {
      try {
        await admin(sql);
      } catch (err) {
        failures.push(`${sql.slice(0, 80).replace(/\s+/g, ' ')} -> ${(err as Error).message}`);
      }
    }
    return failures;
  }

  async function snapshot(): Promise<CatalogSnapshot> {
    const constraints = (
      await admin(
        `SELECT conrelid::regclass::text AS tbl, conname, contype, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE connamespace = 'app'::regnamespace ORDER BY 1, 2`,
      )
    ).rows;
    const policies = (await admin(`SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'app' ORDER BY 1, 2`)).rows;
    const columns = (
      await admin(
        `SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns
         WHERE table_schema = 'app' AND column_name = 'tenant_id' ORDER BY 1`,
      )
    ).rows;
    const indexes = (await admin(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'app' ORDER BY 1`)).rows;
    return { constraints, policies, columns, indexes };
  }

  async function cleanup(): Promise<void> {
    for (const t of ['ticket_comments', 'tickets', 'engagements']) {
      await admin(`DELETE FROM app.${t} WHERE tenant_id IN ($1, $2)`, [A, B]);
    }
    await admin(`DELETE FROM app.tenants WHERE id IN ($1, $2)`, [A, B]);
  }

  beforeAll(async () => {
    db = createPortableDb(url as string);
    await cleanup().catch(() => undefined); // first run on a fresh branch: tables may lack tenant_id yet
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await cleanup().catch((err: unknown) => console.warn('cleanup failed:', (err as Error).message));
    await db.close();
  }, 60_000);

  it('boots the full schema, and a second boot is a no-op', async () => {
    expect(await boot()).toEqual([]);
    const first = await snapshot();
    expect(await boot()).toEqual([]);
    expect(await snapshot()).toEqual(first);

    // The shape the migration promises.
    for (const t of TENANT_TABLES) {
      expect(first.columns.map((c) => (c as { table_name: string }).table_name)).toContain(t);
      expect(first.policies).toContainEqual(
        expect.objectContaining({ tablename: t, policyname: 'tenant_isolation', qual: "(tenant_id = current_setting('app.tenant_id'::text, true))" }),
      );
    }
    const defs = first.constraints.map((c) => `${(c as { tbl: string }).tbl} ${(c as { def: string }).def}`);
    expect(defs).toContain('app.tickets PRIMARY KEY (tenant_id, key)');
    expect(defs).toContain('app.engagements PRIMARY KEY (tenant_id, id)');
    expect(defs).toContain('app.ticket_comments FOREIGN KEY (tenant_id, ticket_key) REFERENCES app.tickets(tenant_id, key) ON DELETE CASCADE');
    expect(defs).toContain('app.tickets FOREIGN KEY (tenant_id, engagement_id) REFERENCES app.engagements(tenant_id, id)');
    expect(defs.some((d) => d === 'app.tickets PRIMARY KEY (key)')).toBe(false);
    expect(defs.some((d) => /FOREIGN KEY \(ticket_key\) REFERENCES app\.tickets\(key\)/.test(d))).toBe(false);
    const forced = (await admin(`SELECT relname FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relrowsecurity AND relforcerowsecurity`)).rows.map((r) => r.relname);
    for (const t of TENANT_TABLES) expect(forced).toContain(t);
    expect(forced).not.toContain('tenants');
    const role = (await admin(`SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`, [APP_ROLE])).rows[0];
    expect(role).toEqual({ rolbypassrls: false, rolcanlogin: false });
  }, 300_000);

  it('the pre-tenancy rows all belong to t_cometloop', async () => {
    const { rows } = await admin(`SELECT count(*)::int AS n FROM app.tickets WHERE tenant_id <> 't_cometloop' AND tenant_id NOT IN ($1, $2)`, [A, B]);
    expect(rows[0].n).toBe(0);
    expect((await admin(`SELECT id FROM app.tenants ORDER BY id`)).rows.map((r) => r.id)).toContain('t_cometloop');
    expect((await admin(`SELECT tenant_id, role FROM app.tenant_members WHERE email = 'nigelsilva12@gmail.com'`)).rows).toEqual([{ tenant_id: 't_cometloop', role: 'owner' }]);
  });

  it('two tenants can both own CL-1, and each sees only its own', async () => {
    await admin(`INSERT INTO app.tenants (id, name) VALUES ($1, 'A'), ($2, 'B') ON CONFLICT DO NOTHING`, [A, B]);
    const seed = async () => {
      // Exactly what the routes do: no tenant_id in the INSERT — the default lands the row in the context tenant.
      await q(
        `INSERT INTO app.engagements (id, client, name, health, owner, phase) VALUES ('itest', 'IT', 'Integration', 'ok', 'tester', 'Build')`,
      );
      await q(`INSERT INTO app.tickets (key, engagement_id, title, est_hours, human_est_hours) VALUES ('CL-1', 'itest', 'first', 1, 4)`);
      await q(`INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ('CL-1', 'tester', 'hello')`);
    };
    await runWithTenant(A, seed);
    await runWithTenant(B, seed);

    const visible = (tenant: string) => runWithTenant(tenant, () => q(`SELECT tenant_id, key, engagement_id FROM app.tickets WHERE key = 'CL-1'`));
    expect((await visible(A)).rows).toEqual([{ tenant_id: A, key: 'CL-1', engagement_id: 'itest' }]);
    expect((await visible(B)).rows).toEqual([{ tenant_id: B, key: 'CL-1', engagement_id: 'itest' }]);
    // The whole board under A is A's — none of production's tickets, none of B's.
    expect((await runWithTenant(A, () => q(`SELECT count(*)::int AS n FROM app.tickets`))).rows[0].n).toBe(1);
    expect((await runWithTenant(A, () => q(`SELECT tenant_id FROM app.ticket_comments`))).rows).toEqual([{ tenant_id: A }]);
    // The owner sees both, so the rows really are there.
    expect((await admin(`SELECT count(*)::int AS n FROM app.tickets WHERE key = 'CL-1' AND tenant_id IN ($1, $2)`, [A, B])).rows[0].n).toBe(2);
  });

  it("rejects a write under A that names B's tenant_id (WITH CHECK), on insert and on update", async () => {
    await expect(
      runWithTenant(A, () =>
        q(`INSERT INTO app.tickets (tenant_id, key, engagement_id, title, est_hours, human_est_hours) VALUES ($1, 'CL-2', 'itest', 'smuggled', 1, 4)`, [B]),
      ),
    ).rejects.toThrow(/row-level security policy/);
    await expect(runWithTenant(A, () => q(`UPDATE app.tickets SET tenant_id = $1 WHERE key = 'CL-1'`, [B]))).rejects.toThrow(/row-level security policy/);
    // Cross-tenant deletes and updates simply see nothing.
    expect((await runWithTenant(B, () => q(`DELETE FROM app.tickets WHERE key = 'CL-1' AND tenant_id = $1 RETURNING key`, [A]))).rows).toEqual([]);
    expect((await admin(`SELECT count(*)::int AS n FROM app.tickets WHERE key = 'CL-1' AND tenant_id IN ($1, $2)`, [A, B])).rows[0].n).toBe(2);
  });

  it('fails closed with no tenant in the context', async () => {
    expect((await q(`SELECT count(*)::int AS n FROM app.tickets`)).rows[0].n).toBe(0);
    await expect(q(`INSERT INTO app.engagements (id, client, name, health, owner, phase) VALUES ('nowhere', 'X', 'X', 'ok', 'x', 'x')`)).rejects.toThrow(
      /row-level security policy/,
    );
  });

  it('leaves no tenant or role on the pooled connection after a scoped statement', async () => {
    await runWithTenant(A, () => q('SELECT 1'));
    const { rows } = await admin(`SELECT current_user AS who, current_setting('app.tenant_id', true) AS tenant`);
    expect(rows[0].who).not.toBe(APP_ROLE);
    expect(rows[0].tenant ?? '').toBe('');
  });
});
