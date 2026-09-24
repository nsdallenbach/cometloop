import { APP_ROLE } from './tenancy';
import {
  currentTenantStore,
  isValidTenantId,
  TENANT_SETTING,
  type PinnedConnection,
  type ScopedPoolClient,
  type TenantStore,
} from './tenant-context';

/**
 * The tenant-scoped `Query` the portable runtime hands to every route module
 * (platform-architecture phase 2). Two modes, chosen per statement from the
 * tenant context (`tenant-context.ts`) and the pool's capabilities:
 *
 * **Pinned** — the fast path; needs a direct connection (`DATABASE_URL_UNPOOLED`).
 * The first statement in a request checks one client out of the pool and
 * runs, once, at session level:
 *
 *     SET ROLE cometloop_app; SELECT set_config('app.tenant_id', '<tenant>', false)
 *
 * Every later statement in the same context goes straight to that client:
 * one round trip each. There is no transaction, so a failing statement does
 * not poison the ones after it. A statement issued while the pinned client
 * is still busy — a `Promise.all` fan-out of independent reads — spills over
 * to the per-statement path on another checkout instead of queueing, so
 * fan-outs stay as parallel as they were. When the context ends (response finished or
 * closed) the client runs `RESET ROLE; RESET app.tenant_id` and goes back to
 * the pool; if that reset fails the client is destroyed, never returned —
 * a pooled connection can never carry one tenant's role or setting into the
 * next checkout. Session-level `SET` only sticks on a direct connection:
 * behind PgBouncer in transaction mode every statement may land on a
 * different backend, which is why this mode is off unless the pool was built
 * on the unpooled URL.
 *
 * **Per statement** — the fallback, and what long-lived handlers and the
 * background loops always use. Each statement takes its own short
 * transaction on a fresh checkout:
 *
 *     BEGIN; SET LOCAL ROLE cometloop_app; SELECT set_config('app.tenant_id', '<tenant>', true);
 *     <the statement>;
 *     COMMIT;
 *
 * Three round trips, but nothing is held between statements — right for the
 * ~55 s runner long-poll (`markLongLived()`), the loop ticks, and any pool
 * that goes through a transaction-mode pooler.
 *
 * Fail closed either way: with no tenant in the async context the statement
 * runs as `cometloop_app` with the setting unset, and the RLS policies match
 * nothing — a read returns no rows, a write is rejected. A code path that
 * reaches the database outside a tenant context is a bug this makes visible
 * (logged once per statement shape), never a leak. Boot migrations and the
 * tenant directory use the owner query (`PortableDb.adminQuery`) instead.
 */

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type { ScopedPoolClient };
export interface ScopedPool {
  connect(): Promise<ScopedPoolClient>;
}

export interface ScopedQueryOptions {
  /**
   * Allow pinned mode. True only when the pool sits on a direct connection;
   * false makes every statement take the per-statement path whatever the
   * context's mode says.
   */
  pinning: boolean;
}

/** The per-statement transaction preamble. Tenant ids are validated, never free text. */
export function scopePreamble(tenantId: string | null): string {
  const parts = ['BEGIN', `SET LOCAL ROLE ${APP_ROLE}`];
  if (tenantId !== null) {
    if (!isValidTenantId(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
    parts.push(`SELECT set_config('${TENANT_SETTING}', '${tenantId}', true)`);
  }
  return parts.join('; ');
}

/** The session-level preamble a pinned client runs once. */
export function sessionPreamble(tenantId: string): string {
  if (!isValidTenantId(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
  return `SET ROLE ${APP_ROLE}; SELECT set_config('${TENANT_SETTING}', '${tenantId}', false)`;
}

/** What a pinned client runs before going back to the pool. */
export const SESSION_RESET = `RESET ROLE; RESET ${TENANT_SETTING}`;

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

/**
 * A checked-out client emits 'error' when its connection drops (a network
 * blip, a Neon compute restart). With no listener, Node treats that as an
 * unhandled event and exits the process — which is how the console died
 * overnight once. Listen while the client is ours, remember that it broke,
 * and destroy it on release instead of handing it back to the pool.
 */
const broken = new WeakSet<object>();
function guard(client: ScopedPoolClient): () => void {
  const onError = (err: Error) => {
    broken.add(client);
    console.warn('[db] connection error on a checked-out client:', err.message);
  };
  client.on?.('error', onError);
  return () => client.removeListener?.('error', onError);
}

async function perStatement(pool: ScopedPool, tenantId: string | null, text: string, params?: unknown[]) {
  const client = await pool.connect();
  const unguard = guard(client);
  try {
    await client.query(scopePreamble(tenantId));
    const result = await client.query(text, params);
    await client.query('COMMIT');
    unguard();
    if (broken.has(client)) client.release(true);
    else client.release();
    return { rows: result.rows as Record<string, unknown>[] };
  } catch (err) {
    try {
      if (!broken.has(client)) await client.query('ROLLBACK');
      unguard();
      if (broken.has(client)) client.release(true);
      else client.release();
    } catch {
      // The connection itself is broken; destroy it rather than return it to the pool.
      unguard();
      client.release(true);
    }
    throw err;
  }
}

/** Statements in flight on each pinned client — a busy pin makes a concurrent statement spill over. */
const inFlight = new WeakMap<PinnedConnection, number>();

/** The context's pinned client, checking one out and setting the session on first use. */
function pinnedClient(pool: ScopedPool, store: TenantStore): Promise<ScopedPoolClient> {
  if (store.pin) return store.pin.client;
  let unguard: (() => void) | null = null;
  const client = (async () => {
    const c = await pool.connect();
    unguard = guard(c);
    try {
      await c.query(sessionPreamble(store.tenantId));
    } catch (err) {
      unguard();
      c.release(true);
      throw err;
    }
    return c;
  })();
  const pin = {
    client,
    async release() {
      let c: ScopedPoolClient;
      try {
        c = await client;
      } catch {
        return; // never got a session; that checkout was already destroyed
      }
      if (broken.has(c)) {
        unguard?.();
        c.release(true);
        return;
      }
      try {
        await c.query(SESSION_RESET);
        unguard?.();
        c.release();
      } catch (err) {
        console.warn('[db] session reset failed, destroying the connection:', (err as Error).message);
        unguard?.();
        c.release(true);
      }
    },
  };
  store.pin = pin;
  // A failed checkout must not wedge the context: forget the pin so the next statement retries.
  client.catch(() => {
    if (store.pin === pin) store.pin = null;
  });
  return client;
}

export function scopedQuery(pool: ScopedPool, opts: ScopedQueryOptions = { pinning: true }): Query {
  return async (text, params) => {
    const store = currentTenantStore();
    if (!store) {
      warnUnscoped(text);
      return perStatement(pool, null, text, params);
    }
    if (!opts.pinning || store.mode !== 'pinned' || store.ended)
      return perStatement(pool, store.tenantId, text, params);
    // A statement issued while the pinned client is busy (a `Promise.all`
    // fan-out) would only queue behind it, so it spills over to the
    // per-statement path on another checkout and the fan-out stays parallel.
    if (store.pin && (inFlight.get(store.pin) ?? 0) > 0) return perStatement(pool, store.tenantId, text, params);
    const clientPromise = pinnedClient(pool, store);
    const pin = store.pin as PinnedConnection;
    inFlight.set(pin, (inFlight.get(pin) ?? 0) + 1);
    try {
      const client = await clientPromise;
      const result = await client.query(text, params);
      return { rows: result.rows as Record<string, unknown>[] };
    } finally {
      inFlight.set(pin, (inFlight.get(pin) ?? 1) - 1);
    }
  };
}
