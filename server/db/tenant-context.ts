import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which tenant the current async context is working for (platform-architecture
 * phase 2). The sign-in gate wraps every `/api/*` handler in
 * `runWithTenantRequest`, and the background loops start one instance per
 * tenant inside `runWithTenant`, so any query issued from those contexts —
 * including fire-and-forget promises and timers they spawn — inherits the
 * tenant through the AsyncLocalStorage.
 *
 * `server/db/scoped-query.ts` reads this to set `app.tenant_id` on the
 * connection; the row-level-security policies then do the actual filtering
 * in Postgres. Nothing in a route module has to know.
 *
 * The store also carries the request's **pinned connection**: in `pinned`
 * mode the scoped query checks one pool client out on the first statement,
 * sets the role and tenant on it once at session level, and every later
 * statement in the same context goes straight to that client — one round
 * trip each instead of three. The context owner ends the store
 * (`endTenantStore`, wired to the response's finish/close by
 * `runWithTenantRequest`, or to the promise settling in `runWithTenant`),
 * which resets the session and returns the client to the pool. A context in
 * `statement` mode — the background loops, and handlers that call
 * `markLongLived()` — never pins: each statement takes its own short
 * transaction, so a ~55 s long-poll does not sit on a pool client.
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

/** The slice of `pg.PoolClient` the scoped query pins on a store — narrow so tests can fake it. */
export interface ScopedPoolClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(destroy?: boolean | Error): void;
}

export type TenantMode = 'pinned' | 'statement';

/** A connection the scoped query pinned to this context; set by scoped-query.ts, released here. */
export interface PinnedConnection {
  client: Promise<ScopedPoolClient>;
  /** Reset the session and return the client to the pool (or destroy it if that fails). */
  release(): Promise<void>;
}

export interface TenantStore {
  readonly tenantId: string;
  mode: TenantMode;
  /** True once the owner ended the context; later statements take the per-statement path and never pin. */
  ended: boolean;
  pin: PinnedConnection | null;
}

const storage = new AsyncLocalStorage<TenantStore>();

export function createTenantStore(tenantId: string, mode: TenantMode = 'pinned'): TenantStore {
  if (!isValidTenantId(tenantId)) throw new Error(`invalid tenant id: ${JSON.stringify(tenantId)}`);
  return { tenantId, mode, ended: false, pin: null };
}

/** Run `fn` inside an existing store (the primitive the helpers below build on). */
export function runInTenantStore<T>(store: TenantStore, fn: () => T): T {
  return storage.run(store, fn);
}

/** Release the pinned connection, if any, without ending the context. */
export async function releasePinnedConnection(store: TenantStore): Promise<void> {
  const pin = store.pin;
  if (!pin) return;
  store.pin = null;
  await pin.release();
}

/**
 * The context is over: release its connection and make sure nothing that
 * still runs in it (a fire-and-forget refinement after the response went
 * out) can pin another. Idempotent.
 */
export function endTenantStore(store: TenantStore): Promise<void> {
  store.ended = true;
  return releasePinnedConnection(store);
}

/**
 * Run `fn` with every query it (transitively) issues scoped to `tenantId`.
 * A promise-returning `fn` gets a pinned connection for its duration and the
 * context ends when it settles. A synchronous `fn` — one that only *starts*
 * work, like the loop starters — is left in `statement` mode, since nobody
 * is around afterwards to release a pin.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T, opts: { mode?: TenantMode } = {}): T {
  const store = createTenantStore(tenantId, opts.mode ?? 'pinned');
  const result = storage.run(store, fn);
  if (isThenable(result)) {
    return result.finally(() => endTenantStore(store)) as T;
  }
  if (opts.mode === undefined) store.mode = 'statement';
  return result;
}

/** What `runWithTenantRequest` needs from the response: the end-of-request events. */
export interface RequestEnd {
  on(event: 'finish' | 'close', listener: () => void): unknown;
}

/**
 * Run the rest of an Express chain inside a pinned tenant context that ends
 * when the response finishes or the socket closes, whichever comes first.
 */
export function runWithTenantRequest(tenantId: string, res: RequestEnd, next: () => void): TenantStore {
  const store = createTenantStore(tenantId, 'pinned');
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    void endTenantStore(store).catch((err: unknown) =>
      console.warn('[db] releasing the request connection failed:', (err as Error).message),
    );
  };
  res.on('finish', end);
  res.on('close', end);
  storage.run(store, next);
  return store;
}

/**
 * Call at the top of a handler that holds its request open for a long time
 * (the runner long-poll): the context switches to per-statement scoping and
 * any connection already pinned goes back to the pool now, so the handler
 * never sits on a pool client while it waits.
 */
export function markLongLived(): void {
  const store = storage.getStore();
  if (!store) return;
  store.mode = 'statement';
  void releasePinnedConnection(store).catch((err: unknown) =>
    console.warn('[db] releasing a long-lived handler connection failed:', (err as Error).message),
  );
}

/** The store of the current async context, or null outside any tenant context. */
export function currentTenantStore(): TenantStore | null {
  return storage.getStore() ?? null;
}

/** The tenant of the current async context, or null outside any `runWithTenant`. */
export function currentTenantId(): string | null {
  return storage.getStore()?.tenantId ?? null;
}

function isThenable(v: unknown): v is Promise<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}
