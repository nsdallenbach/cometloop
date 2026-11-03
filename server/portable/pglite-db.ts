import fs from 'node:fs';
import path from 'node:path';
import type { PGlite as PGliteType } from '@electric-sql/pglite';
import { scopedQuery, type ScopedPool, type ScopedPoolClient } from '../db/scoped-query';
import type { PortableDb, Query } from './db';

/**
 * The local backend's database: real Postgres 17 compiled to WASM (PGlite),
 * persisted to a directory on disk. No server to install, no port, no
 * credentials — `npm ci` brings it in, and the schema, row-level security,
 * `cometloop_app` role and boot migrations are byte-for-byte the ones the
 * hosted console runs on Neon/Lakebase.
 *
 * Selected by `DATABASE_URL=pglite:<dir>` (`npm run local` sets
 * `pglite:./data/local/db`); `pglite:memory` keeps nothing.
 *
 * PGlite is one connection, so the `ScopedPool` here is a mutex: `connect()`
 * waits for the previous holder's `release()`. That makes each per-statement
 * transaction (`BEGIN; SET LOCAL ROLE …; <stmt>; COMMIT`) atomic with respect
 * to every other caller. Pinned mode is off — a session-level `SET ROLE`
 * would leak across callers sharing the one backend. `adminQuery` takes the
 * same lock, so a boot migration never interleaves with a scoped statement.
 *
 * Result types follow `pg`'s defaults so route code sees the same shapes on
 * every runtime: int8 and numeric come back as strings, timestamps as Date,
 * json/jsonb parsed.
 */

const INT8 = 20;
const NUMERIC = 1700;

export function pgliteDir(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('pglite:')) return null;
  const rest = databaseUrl.slice('pglite:'.length).replace(/^\/\//, '');
  return rest === '' || rest === 'memory' ? 'memory://' : path.resolve(rest);
}

export async function createPgliteDb(databaseUrl: string): Promise<PortableDb> {
  const dir = pgliteDir(databaseUrl);
  if (!dir) throw new Error(`not a pglite: URL: ${databaseUrl}`);
  if (dir !== 'memory://') fs.mkdirSync(dir, { recursive: true });

  const { PGlite } = await import('@electric-sql/pglite');
  const pg: PGliteType = await PGlite.create(dir === 'memory://' ? undefined : dir, {
    parsers: { [INT8]: (v: string) => v, [NUMERIC]: (v: string) => v },
  });

  // The lock: a promise chain; each holder resolves its link on release.
  let tail: Promise<void> = Promise.resolve();
  const acquire = async (): Promise<() => void> => {
    let unlock!: () => void;
    const mine = new Promise<void>((r) => (unlock = r));
    const prev = tail;
    tail = prev.then(() => mine);
    await prev;
    return unlock;
  };

  // pg's simple protocol runs a parameterless multi-statement string (the
  // scope preambles, the boot *_SCHEMA_SQL); PGlite splits that into exec().
  const run = async (text: string, params?: unknown[]) => {
    if (params && params.length > 0) return (await pg.query(text, params)).rows as Record<string, unknown>[];
    const results = await pg.exec(text);
    return (results[results.length - 1]?.rows ?? []) as Record<string, unknown>[];
  };

  const pool: ScopedPool = {
    async connect(): Promise<ScopedPoolClient> {
      const unlock = await acquire();
      let released = false;
      return {
        query: async (text, params) => ({ rows: await run(text, params) }),
        release() {
          if (released) return;
          released = true;
          unlock();
        },
      };
    },
  };

  const adminQuery: Query = async (text, params) => {
    const unlock = await acquire();
    try {
      return { rows: await run(text, params) };
    } finally {
      unlock();
    }
  };

  return {
    // `pool` is typed as pg.Pool for the network runtime; only main.ts's
    // pinned-mode log line reads it, and this runtime never pins.
    pool: pool as unknown as PortableDb['pool'],
    query: scopedQuery(pool, { pinning: false }),
    adminQuery,
    label: dir === 'memory://' ? 'pglite (in memory)' : `pglite ${dir}`,
    mode: 'statement',
    close: () => pg.close(),
  };
}
