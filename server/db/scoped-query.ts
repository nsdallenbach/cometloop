import { APP_ROLE } from './tenancy';
import { currentTenantId, isValidTenantId, TENANT_SETTING } from './tenant-context';

/**
 * The tenant-scoped `Query` the portable runtime hands to every route module
 * (platform-architecture phase 2).
 *
 * Each call checks a client out of the pool and runs the statement inside its
 * own short transaction:
 *
 *     BEGIN; SET LOCAL ROLE cometloop_app; SELECT set_config('app.tenant_id', <tenant>, true);
 *     <the statement>;
 *     COMMIT;
 *
 * `SET LOCAL` and a transaction-scoped `set_config` are undone by the COMMIT /
 * ROLLBACK, so a pooled connection can never leak one request's tenant (or
 * the app role) into the next — even if the process is interrupted between
 * statements, the client is released with the transaction ended. One
 * transaction *per statement*, not per request, on purpose: route handlers
 * catch and continue past individual query errors, the runner long-poll holds
 * a request open for ~55s, and both would break inside one request-long
 * transaction (an aborted transaction rejects everything after the first
 * error; a long one pins a pool client and its row locks).
 *
 * Fail closed: with no tenant in the async context the statement still runs
 * as `cometloop_app` with the setting unset, and the RLS policies then match
 * nothing — a read returns no rows, a write is rejected. That is deliberate;
 * a code path that reaches the database outside `runWithTenant` is a bug
 * this makes visible (it is logged once per statement shape) rather than a
 * data leak. Boot migrations and the tenant directory use the owner query
 * (`PortableDb.adminQuery`) instead.
 *
 * Cost: two extra round trips per statement (the preamble is one
 * multi-statement message; COMMIT is the other). Fine at this scale; the
 * phase-4 worker split is the point to revisit it if it ever shows.
 */

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** The slice of `pg.Pool` / `pg.PoolClient` this needs — narrow so tests can fake it. */
export interface ScopedPoolClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(destroy?: boolean | Error): void;
}
export interface ScopedPool {
  connect(): Promise<ScopedPoolClient>;
}

/** `BEGIN` plus the role switch and, when a tenant is set, the setting. Tenant ids are validated, never free text. */
export function scopePreamble(tenantId: string | null): string {
  const parts = ['BEGIN', `SET LOCAL ROLE ${APP_ROLE}`];
  if (tenantId !== null) {
    if (!isValidTenantId(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
    parts.push(`SELECT set_config('${TENANT_SETTING}', '${tenantId}', true)`);
  }
  return parts.join('; ');
}

const warned = new Set<string>();
function warnUnscoped(text: string): void {
  const shape = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  if (warned.has(shape)) return;
  warned.add(shape);
  console.warn(`[db] query outside any tenant context (RLS will match nothing): ${shape}`);
}

/** Test seam: forget which unscoped statement shapes were already reported. */
export function resetUnscopedWarnings(): void {
  warned.clear();
}

export function scopedQuery(pool: ScopedPool): Query {
  return async (text, params) => {
    const tenantId = currentTenantId();
    if (tenantId === null) warnUnscoped(text);
    const client = await pool.connect();
    try {
      await client.query(scopePreamble(tenantId));
      const result = await client.query(text, params);
      await client.query('COMMIT');
      client.release();
      return { rows: result.rows as Record<string, unknown>[] };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch {
        // The connection itself is broken; destroy it rather than return it to the pool.
        client.release(true);
      }
      throw err;
    }
  };
}
