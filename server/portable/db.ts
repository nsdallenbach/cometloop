import { Pool, type PoolConfig } from 'pg';

/**
 * Plain-Postgres connection for the portable runtime (platform-architecture
 * phase 0). `DATABASE_URL` replaces the Lakebase plugin: no workspace OAuth
 * token, no hourly refresh, one owner role — so the boot-time `*_SCHEMA_SQL`
 * statements never hit "must be owner of table".
 *
 * SSL is on unless the URL says `sslmode=disable` (docker-compose's local
 * Postgres); Neon requires it. `sslmode=no-verify` keeps encryption but skips
 * certificate verification for self-signed proxies. The parameter is removed
 * from the URL before it reaches `pg`, because `pg` lets a connection-string
 * `sslmode` override an explicit `ssl` option and the two disagree on what
 * `require` means.
 */

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface PortablePoolConfig {
  connectionString: string;
  ssl: PoolConfig['ssl'];
  /** Redacted `host/database` for the boot log line. */
  label: string;
}

export function portablePoolConfig(databaseUrl: string): PortablePoolConfig {
  const url = new URL(databaseUrl);
  const sslmode = (url.searchParams.get('sslmode') ?? '').toLowerCase();
  url.searchParams.delete('sslmode');
  let ssl: PoolConfig['ssl'];
  if (sslmode === 'disable') ssl = false;
  else if (sslmode === 'no-verify') ssl = { rejectUnauthorized: false };
  else ssl = { rejectUnauthorized: true };
  return {
    connectionString: url.toString(),
    ssl,
    label: `${url.hostname}${url.pathname || '/'}`,
  };
}

export interface PortableDb {
  pool: Pool;
  query: Query;
  label: string;
  close(): Promise<void>;
}

export function createPortableDb(databaseUrl: string): PortableDb {
  const cfg = portablePoolConfig(databaseUrl);
  const pool = new Pool({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  pool.on('error', (err) => console.warn('[db] idle client error:', err.message));
  const query: Query = async (text, params) => {
    const result = await pool.query(text, params);
    return { rows: result.rows as Record<string, unknown>[] };
  };
  return { pool, query, label: cfg.label, close: () => pool.end() };
}
