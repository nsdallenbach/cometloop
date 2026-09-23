import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which tenant the current async context is working for (platform-architecture
 * phase 2). The sign-in gate wraps every `/api/*` handler in `runWithTenant`,
 * and the background loops start one instance per tenant inside it, so any
 * query issued from those contexts — including fire-and-forget promises and
 * timers they spawn — inherits the tenant through the AsyncLocalStorage.
 *
 * `server/db/scoped-query.ts` reads this to set `app.tenant_id` on the
 * connection before each query; the row-level-security policies then do the
 * actual filtering in Postgres. Nothing in a route module has to know.
 */

/**
 * The tenant every pre-tenancy row belongs to. Tenant ids are Better Auth
 * organization ids once that client exists; until then they are opaque text
 * with this one hard-coded value for the existing customer.
 */
export const DEFAULT_TENANT_ID = 't_cometloop';

/** Postgres setting the RLS policies read: `current_setting('app.tenant_id', true)`. */
export const TENANT_SETTING = 'app.tenant_id';

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Tenant ids are inlined into a `set_config` call on the connection, so the
 * shape is deliberately narrow: identifier characters only, never free text.
 */
export function isValidTenantId(id: string): boolean {
  return TENANT_ID_RE.test(id);
}

interface TenantStore {
  tenantId: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

/** Run `fn` with every query it (transitively) issues scoped to `tenantId`. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  if (!isValidTenantId(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
  return storage.run({ tenantId }, fn);
}

/** The tenant of the current async context, or null outside any `runWithTenant`. */
export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}
