import { runWithTenant } from './tenant-context';

/**
 * Start a set of background loops once per tenant (platform-architecture
 * phase 2). The route modules' `start*Polling` functions each create a
 * `setInterval` that closes over `q`; a timer created inside `runWithTenant`
 * inherits the tenant through the AsyncLocalStorage, so every tick of that
 * interval — and every query it issues — is scoped to the tenant it was
 * started for. Nothing in the modules changes. Loops run in `statement`
 * mode: a tick has no request end to release a pinned connection on, and
 * latency is not what a background sweep is about.
 *
 * The directory is re-read on a slow cadence so a tenant created after boot
 * gets its loops without a restart; a tenant never gets a second set.
 * Deleted tenants keep their (now empty-sighted) loops until the next
 * restart — cheap, and phase 4 replaces all of this with a queue anyway.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const TENANT_SCAN_INTERVAL_MS = 60_000;

export interface PerTenantHandle {
  /** Tenants whose loops are running. */
  readonly started: ReadonlySet<string>;
  /** Read the directory now and start loops for any new tenant. */
  scan(): Promise<void>;
  stop(): void;
}

export function startPerTenant(
  adminQuery: Query,
  start: (tenantId: string) => void,
  intervalMs = TENANT_SCAN_INTERVAL_MS,
): PerTenantHandle {
  const started = new Set<string>();
  const scan = async (): Promise<void> => {
    let ids: string[];
    try {
      const { rows } = await adminQuery('SELECT id FROM app.tenants ORDER BY created_at, id');
      ids = rows.flatMap((r) => (typeof r.id === 'string' ? [r.id] : []));
    } catch (err) {
      console.warn('[tenants] directory scan failed:', (err as Error).message);
      return;
    }
    for (const id of ids) {
      if (started.has(id)) continue;
      started.add(id);
      try {
        runWithTenant(id, () => start(id), { mode: 'statement' });
      } catch (err) {
        console.warn(`[tenants] loops for ${id} failed to start:`, (err as Error).message);
      }
    }
  };
  void scan();
  const timer = setInterval(() => void scan(), intervalMs);
  timer.unref?.();
  return { started, scan, stop: () => clearInterval(timer) };
}
