import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetUnscopedWarnings,
  scopePreamble,
  scopedQuery,
  SESSION_RESET,
  sessionPreamble,
  type ScopedPool,
  type ScopedPoolClient,
} from './scoped-query';
import {
  currentTenantId,
  currentTenantStore,
  DEFAULT_TENANT_ID,
  endTenantStore,
  isValidTenantId,
  markLongLived,
  runInTenantStore as runInStore,
  runWithTenant,
  runWithTenantRequest,
} from './tenant-context';
import { startPerTenant } from './tenant-loops';

/**
 * The scoped query is a thin wrapper over pool clients; a recording fake is
 * enough to prove both modes' statement shapes, the pin/release discipline
 * and that the tenant comes from the async context. RLS itself is proven on
 * real Postgres in server/tenancy.integration.test.ts.
 */

interface Recorded {
  client: number;
  sql: string;
  params?: unknown[];
}

function fakePool(opts: { failOn?: RegExp; brokenRollback?: boolean; brokenReset?: boolean; failConnect?: boolean } = {}) {
  const log: Recorded[] = [];
  const released: { client: number; destroy: boolean | Error | undefined }[] = [];
  let checkouts = 0;
  const pool: ScopedPool = {
    connect() {
      if (opts.failConnect) return Promise.reject(new Error('pool exhausted'));
      const id = ++checkouts;
      const client: ScopedPoolClient = {
        query(sql, params) {
          log.push({ client: id, sql, params });
          if (opts.failOn?.test(sql)) return Promise.reject(new Error(`boom: ${sql}`));
          if (opts.brokenRollback && sql === 'ROLLBACK') return Promise.reject(new Error('connection lost'));
          if (opts.brokenReset && sql === SESSION_RESET) return Promise.reject(new Error('connection lost'));
          return Promise.resolve({ rows: [{ sql }] });
        },
        release(destroy) {
          released.push({ client: id, destroy });
        },
      };
      return Promise.resolve(client);
    },
  };
  return { pool, log, released, checkouts: () => checkouts, sqls: () => log.map((r) => r.sql) };
}

/** A stand-in for the response: only the end-of-request events matter. */
const fakeRes = () => new EventEmitter() as EventEmitter & { on(event: 'finish' | 'close', listener: () => void): unknown };

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetUnscopedWarnings());

describe('tenant context', () => {
  it('is null outside runWithTenant and set inside, across awaits and timers', async () => {
    expect(currentTenantId()).toBeNull();
    const seen = await runWithTenant('t_a', async () => {
      await new Promise((r) => setTimeout(r, 1));
      const inTimer = await new Promise<string | null>((resolve) => setTimeout(() => resolve(currentTenantId()), 1));
      return [currentTenantId(), inTimer];
    });
    expect(seen).toEqual(['t_a', 't_a']);
    expect(currentTenantId()).toBeNull();
  });

  it('keeps concurrent contexts apart', async () => {
    const a = runWithTenant('t_a', async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentTenantId();
    });
    const b = runWithTenant('t_b', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentTenantId();
    });
    expect(await Promise.all([a, b])).toEqual(['t_a', 't_b']);
  });

  it('accepts identifier-shaped ids only', () => {
    expect(isValidTenantId(DEFAULT_TENANT_ID)).toBe(true);
    expect(isValidTenantId('org_AbC-123')).toBe(true);
    expect(isValidTenantId('')).toBe(false);
    expect(isValidTenantId("t'; DROP TABLE app.tickets; --")).toBe(false);
    expect(() => runWithTenant('bad id', () => 1)).toThrow(/invalid tenant id/);
  });

  it('pins for a promise-returning fn and leaves a synchronous starter in statement mode', async () => {
    let store = runWithTenant('t_a', () => currentTenantStore());
    expect(store?.mode).toBe('statement');
    store = await runWithTenant('t_a', () => Promise.resolve(currentTenantStore()));
    expect(store?.mode).toBe('pinned');
    expect(store?.ended).toBe(true);
  });
});

describe('preambles', () => {
  it('per statement: begins, switches role and sets the tenant for the transaction only', () => {
    expect(scopePreamble('t_cometloop')).toBe("BEGIN; SET LOCAL ROLE cometloop_app; SELECT set_config('app.tenant_id', 't_cometloop', true)");
    expect(scopePreamble(null)).toBe('BEGIN; SET LOCAL ROLE cometloop_app');
    expect(() => scopePreamble("t'x")).toThrow(/invalid tenant id/);
  });

  it('pinned: sets role and tenant at session level, and the reset undoes both', () => {
    expect(sessionPreamble('t_cometloop')).toBe("SET ROLE cometloop_app; SELECT set_config('app.tenant_id', 't_cometloop', false)");
    expect(() => sessionPreamble("t'x")).toThrow(/invalid tenant id/);
    expect(SESSION_RESET).toBe('RESET ROLE; RESET app.tenant_id');
  });
});

describe('scopedQuery — pinned mode', () => {
  it('checks out one client per context, sets the session once, then sends statements straight through', async () => {
    const { pool, log, released, checkouts } = fakePool();
    const q = scopedQuery(pool);
    const rows = await runWithTenant('t_a', async () => {
      const first = await q('SELECT * FROM app.tickets WHERE key = $1', ['CL-1']);
      await q('SELECT 2');
      await q('SELECT 3');
      return first.rows;
    });
    expect(rows).toEqual([{ sql: 'SELECT * FROM app.tickets WHERE key = $1' }]);
    expect(checkouts()).toBe(1);
    expect(log.map((r) => [r.client, r.sql])).toEqual([
      [1, sessionPreamble('t_a')],
      [1, 'SELECT * FROM app.tickets WHERE key = $1'],
      [1, 'SELECT 2'],
      [1, 'SELECT 3'],
      [1, SESSION_RESET],
    ]);
    // Released once, clean, after the reset.
    expect(released).toEqual([{ client: 1, destroy: undefined }]);
  });

  it('spills a concurrent fan-out over to per-statement checkouts instead of queueing on the pin', async () => {
    const { pool, log, released, checkouts } = fakePool();
    const q = scopedQuery(pool);
    await runWithTenant('t_a', async () => {
      await q('SELECT 0'); // pins client 1
      // Three independent reads at once: the first takes the pinned client, the others their own.
      await Promise.all([q('SELECT 1'), q('SELECT 2'), q('SELECT 3')]);
      await q('SELECT 4'); // back on the pin once it is idle again
    });
    expect(checkouts()).toBe(3);
    const byClient = (id: number) => log.filter((r) => r.client === id).map((r) => r.sql);
    expect(byClient(1)).toEqual([sessionPreamble('t_a'), 'SELECT 0', 'SELECT 1', 'SELECT 4', SESSION_RESET]);
    expect(byClient(2)).toEqual([scopePreamble('t_a'), 'SELECT 2', 'COMMIT']);
    expect(byClient(3)).toEqual([scopePreamble('t_a'), 'SELECT 3', 'COMMIT']);
    expect(released.map((r) => r.destroy)).toEqual([undefined, undefined, undefined]);
  });

  it('a failing statement does not poison the request: the next one runs on the same client', async () => {
    const { pool, sqls, released } = fakePool({ failOn: /^INSERT/ });
    const q = scopedQuery(pool);
    const after = await runWithTenant('t_a', async () => {
      await expect(q('INSERT INTO app.tickets (key) VALUES ($1)', ['dup'])).rejects.toThrow(/boom/);
      return q('SELECT 1');
    });
    expect(after.rows).toEqual([{ sql: 'SELECT 1' }]);
    expect(sqls()).toEqual([sessionPreamble('t_a'), 'INSERT INTO app.tickets (key) VALUES ($1)', 'SELECT 1', SESSION_RESET]);
    expect(sqls()).not.toContain('ROLLBACK');
    expect(released).toEqual([{ client: 1, destroy: undefined }]);
  });

  it('destroys the client instead of returning it when the session reset fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { pool, released } = fakePool({ brokenReset: true });
      const q = scopedQuery(pool);
      await runWithTenant('t_a', () => q('SELECT 1'));
      expect(released).toEqual([{ client: 1, destroy: true }]);
      expect(warn.mock.calls[0][0]).toContain('destroying the connection');
    } finally {
      warn.mockRestore();
    }
  });

  it('destroys a checkout whose session preamble fails, and lets the next statement retry', async () => {
    const { pool, released, checkouts } = fakePool({ failOn: /^SET ROLE/ });
    const q = scopedQuery(pool);
    await runWithTenant('t_a', async () => {
      await expect(q('SELECT 1')).rejects.toThrow(/boom/);
      await expect(q('SELECT 2')).rejects.toThrow(/boom/);
    });
    expect(checkouts()).toBe(2);
    expect(released).toEqual([
      { client: 1, destroy: true },
      { client: 2, destroy: true },
    ]);
  });

  it('runs requests inside a context that ends with the response, and later statements fall back to per-statement', async () => {
    const { pool, log, released, checkouts } = fakePool();
    const q = scopedQuery(pool);
    const res = fakeRes();
    const seen: { store: ReturnType<typeof currentTenantStore> } = { store: null };
    let handler!: Promise<void>;
    runWithTenantRequest('t_a', res, () => {
      seen.store = currentTenantStore();
      handler = (async () => {
        await q('SELECT 1');
        await q('SELECT 2');
      })();
    });
    await handler;
    const store = seen.store!;
    expect(store.tenantId).toBe('t_a');
    expect(checkouts()).toBe(1);
    expect(released).toEqual([]);
    res.emit('finish');
    res.emit('close'); // idempotent
    await tick();
    expect(log.map((r) => r.sql)).toEqual([sessionPreamble('t_a'), 'SELECT 1', 'SELECT 2', SESSION_RESET]);
    expect(released).toEqual([{ client: 1, destroy: undefined }]);
    // A fire-and-forget query after the response went out: no new pin, no leak.
    await new Promise<void>((resolve, reject) => {
      const { run } = { run: () => q('SELECT 3').then(() => resolve(), reject) };
      // Re-enter the (ended) store the way an async continuation of the handler would.
      void runInStore(store, run);
    });
    expect(log.slice(-3).map((r) => r.sql)).toEqual([scopePreamble('t_a'), 'SELECT 3', 'COMMIT']);
    expect(released).toHaveLength(2);
    expect(checkouts()).toBe(2);
  });

  it('a long-lived handler releases its pin and scopes each statement on its own', async () => {
    const { pool, log, released, checkouts } = fakePool();
    const q = scopedQuery(pool);
    await runWithTenant('t_a', async () => {
      await q('SELECT 1'); // pinned so far
      markLongLived();
      await tick();
      await q('SELECT 2');
      await q('SELECT 3');
    });
    expect(log.map((r) => [r.client, r.sql])).toEqual([
      [1, sessionPreamble('t_a')],
      [1, 'SELECT 1'],
      [1, SESSION_RESET],
      [2, scopePreamble('t_a')],
      [2, 'SELECT 2'],
      [2, 'COMMIT'],
      [3, scopePreamble('t_a')],
      [3, 'SELECT 3'],
      [3, 'COMMIT'],
    ]);
    expect(released.map((r) => r.destroy)).toEqual([undefined, undefined, undefined]);
    expect(checkouts()).toBe(3);
  });

  it('never pins when the pool cannot (transaction-mode pooler): every statement scopes itself', async () => {
    const { pool, sqls, checkouts } = fakePool();
    const q = scopedQuery(pool, { pinning: false });
    await runWithTenant('t_a', async () => {
      await q('SELECT 1');
      await q('SELECT 2');
    });
    expect(checkouts()).toBe(2);
    expect(sqls()).toEqual([scopePreamble('t_a'), 'SELECT 1', 'COMMIT', scopePreamble('t_a'), 'SELECT 2', 'COMMIT']);
  });

  it('ending a store is idempotent and safe with nothing pinned', async () => {
    const store = runWithTenant('t_a', () => currentTenantStore())!;
    await endTenantStore(store);
    await endTenantStore(store);
    expect(store.ended).toBe(true);
    expect(store.pin).toBeNull();
  });
});

describe('scopedQuery — per-statement mode', () => {
  const statement = <T>(tenant: string, fn: () => Promise<T>) => runWithTenant(tenant, fn, { mode: 'statement' });

  it('wraps each statement in its own transaction with the context tenant, and releases the client', async () => {
    const { pool, log, released, checkouts } = fakePool();
    const q = scopedQuery(pool);
    const { rows } = await statement('t_a', () => q('SELECT * FROM app.tickets WHERE key = $1', ['CL-1']));
    expect(rows).toEqual([{ sql: 'SELECT * FROM app.tickets WHERE key = $1' }]);
    expect(log.map((r) => [r.sql, r.params])).toEqual([
      [scopePreamble('t_a'), undefined],
      ['SELECT * FROM app.tickets WHERE key = $1', ['CL-1']],
      ['COMMIT', undefined],
    ]);
    expect(released).toEqual([{ client: 1, destroy: undefined }]);
    expect(checkouts()).toBe(1);
    // A second statement is a second transaction on a fresh checkout — nothing carries over.
    await statement('t_b', () => q('SELECT 1'));
    expect(log[3].sql).toBe(scopePreamble('t_b'));
    expect(checkouts()).toBe(2);
  });

  it('runs unscoped statements as the app role with no tenant (RLS fails closed) and warns once per shape', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { pool, log } = fakePool();
      const q = scopedQuery(pool);
      await q('SELECT 1');
      await q('SELECT 1');
      expect(log[0].sql).toBe('BEGIN; SET LOCAL ROLE cometloop_app');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('outside any tenant context');
    } finally {
      warn.mockRestore();
    }
  });

  it('rolls back and releases on a failing statement, rethrowing the error', async () => {
    const { pool, sqls, released } = fakePool({ failOn: /^UPDATE/ });
    const q = scopedQuery(pool);
    await expect(statement('t_a', () => q('UPDATE app.tickets SET status = $1', ['done']))).rejects.toThrow(/boom/);
    expect(sqls()).toEqual([scopePreamble('t_a'), 'UPDATE app.tickets SET status = $1', 'ROLLBACK']);
    expect(released).toEqual([{ client: 1, destroy: undefined }]);
  });

  it('destroys the client when even the rollback fails', async () => {
    const { pool, released } = fakePool({ failOn: /^SELECT 1/, brokenRollback: true });
    const q = scopedQuery(pool);
    await expect(statement('t_a', () => q('SELECT 1'))).rejects.toThrow(/boom/);
    expect(released).toEqual([{ client: 1, destroy: true }]);
  });
});

describe('startPerTenant', () => {
  it('starts one loop set per tenant inside that tenant context (statement mode), and picks up new tenants on a later scan', async () => {
    let tenants = [{ id: 't_a' }];
    const adminQuery = vi.fn(() => Promise.resolve({ rows: tenants }));
    const started: [string, string | null, string | undefined][] = [];
    const handle = startPerTenant(adminQuery, (id) => started.push([id, currentTenantId(), currentTenantStore()?.mode]), 60_000);
    await handle.scan();
    expect(started).toEqual([['t_a', 't_a', 'statement']]);
    tenants = [{ id: 't_a' }, { id: 't_b' }];
    await handle.scan();
    await handle.scan();
    expect(started).toEqual([
      ['t_a', 't_a', 'statement'],
      ['t_b', 't_b', 'statement'],
    ]);
    expect([...handle.started]).toEqual(['t_a', 't_b']);
    handle.stop();
  });

  it('survives a directory read failure and tries again next scan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adminQuery = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ rows: [{ id: 't_a' }] });
      const started: string[] = [];
      const handle = startPerTenant(adminQuery, (id) => started.push(id), 60_000);
      await handle.scan();
      await handle.scan();
      expect(started).toEqual(['t_a']);
      handle.stop();
    } finally {
      warn.mockRestore();
    }
  });
});
