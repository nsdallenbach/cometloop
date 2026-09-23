import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUnscopedWarnings, scopePreamble, scopedQuery, type ScopedPool, type ScopedPoolClient } from './scoped-query';
import { currentTenantId, DEFAULT_TENANT_ID, isValidTenantId, runWithTenant } from './tenant-context';
import { startPerTenant } from './tenant-loops';

/**
 * The scoped query is a thin wrapper over a pool client; a recording fake is
 * enough to prove the transaction shape, the release discipline and that the
 * tenant comes from the async context. RLS itself is proven on real Postgres
 * in server/tenancy.integration.test.ts.
 */

interface Recorded {
  sql: string;
  params?: unknown[];
}

function fakePool(opts: { failOn?: RegExp; brokenRollback?: boolean } = {}) {
  const log: Recorded[] = [];
  const released: (boolean | Error | undefined)[] = [];
  let checkouts = 0;
  const client: ScopedPoolClient = {
    query(sql, params) {
      log.push({ sql, params });
      if (opts.failOn?.test(sql)) return Promise.reject(new Error(`boom: ${sql}`));
      if (opts.brokenRollback && sql === 'ROLLBACK') return Promise.reject(new Error('connection lost'));
      return Promise.resolve({ rows: [{ sql }] });
    },
    release(destroy) {
      released.push(destroy);
    },
  };
  const pool: ScopedPool = {
    connect() {
      checkouts++;
      return Promise.resolve(client);
    },
  };
  return { pool, log, released, checkouts: () => checkouts };
}

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
});

describe('scopePreamble', () => {
  it('begins, switches to the app role and sets the tenant for the transaction only', () => {
    expect(scopePreamble('t_cometloop')).toBe("BEGIN; SET LOCAL ROLE cometloop_app; SELECT set_config('app.tenant_id', 't_cometloop', true)");
    expect(scopePreamble(null)).toBe('BEGIN; SET LOCAL ROLE cometloop_app');
    expect(() => scopePreamble("t'x")).toThrow(/invalid tenant id/);
  });
});

describe('scopedQuery', () => {
  it('wraps each statement in its own transaction with the context tenant, and releases the client', async () => {
    const { pool, log, released, checkouts } = fakePool();
    const q = scopedQuery(pool);
    const { rows } = await runWithTenant('t_a', () => q('SELECT * FROM app.tickets WHERE key = $1', ['CL-1']));
    expect(rows).toEqual([{ sql: 'SELECT * FROM app.tickets WHERE key = $1' }]);
    expect(log).toEqual([
      { sql: scopePreamble('t_a'), params: undefined },
      { sql: 'SELECT * FROM app.tickets WHERE key = $1', params: ['CL-1'] },
      { sql: 'COMMIT', params: undefined },
    ]);
    expect(released).toEqual([undefined]);
    expect(checkouts()).toBe(1);
    // A second statement is a second transaction on a fresh checkout — nothing carries over.
    await runWithTenant('t_b', () => q('SELECT 1'));
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
    const { pool, log, released } = fakePool({ failOn: /^UPDATE/ });
    const q = scopedQuery(pool);
    await expect(runWithTenant('t_a', () => q('UPDATE app.tickets SET status = $1', ['done']))).rejects.toThrow(/boom/);
    expect(log.map((r) => r.sql)).toEqual([scopePreamble('t_a'), 'UPDATE app.tickets SET status = $1', 'ROLLBACK']);
    expect(released).toEqual([undefined]);
  });

  it('destroys the client when even the rollback fails', async () => {
    const { pool, released } = fakePool({ failOn: /^SELECT 1/, brokenRollback: true });
    const q = scopedQuery(pool);
    await expect(runWithTenant('t_a', () => q('SELECT 1'))).rejects.toThrow(/boom/);
    expect(released).toEqual([true]);
  });
});

describe('startPerTenant', () => {
  it('starts one loop set per tenant inside that tenant context, and picks up new tenants on a later scan', async () => {
    let tenants = [{ id: 't_a' }];
    const adminQuery = vi.fn(() => Promise.resolve({ rows: tenants }));
    const started: [string, string | null][] = [];
    const handle = startPerTenant(adminQuery, (id) => started.push([id, currentTenantId()]), 60_000);
    await handle.scan();
    expect(started).toEqual([['t_a', 't_a']]);
    tenants = [{ id: 't_a' }, { id: 't_b' }];
    await handle.scan();
    await handle.scan();
    expect(started).toEqual([
      ['t_a', 't_a'],
      ['t_b', 't_b'],
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
