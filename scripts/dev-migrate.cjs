// All dev-role database maintenance in one idempotent script. The app's
// service principal cannot ALTER tables owned by the developer role (the
// tables created during early local dev), so those migrations — plus the
// SP's grants — run here, as the developer, against Lakebase directly.
//
//   TOKEN=$(databricks postgres generate-database-credential \
//     projects/engagement-console/branches/production/endpoints/primary -o json | jq -r .token)
//   PGPASSWORD=$TOKEN node scripts/dev-migrate.cjs
//
// (PowerShell: $env:PGPASSWORD = (databricks postgres generate-database-credential ... | ConvertFrom-Json).token)
//
// Every statement is idempotent (IF NOT EXISTS / GRANT / best-effort), so
// rerunning is always safe. To add a migration for a dev-owned table, append
// to MIGRATIONS — new SP-owned tables belong in the boot-time *_SCHEMA_SQL
// arrays instead (see docs/development-standards.md).
const { Client } = require('pg');

const SP = process.env.SP_CLIENT_ID || '2e02c1a1-68bc-4110-b40f-96dd67ca85f8';
const HOST = process.env.PGHOST || 'ep-quiet-leaf-d13g0clu.database.us-west-2.cloud.databricks.com';
const USER = process.env.PGUSER || 'nigel.silva@datavail.com';

/** { sql, bestEffort? } — best-effort failures warn instead of aborting. */
const MIGRATIONS = [
  // --- app SP grants (CREATE for boot DDL; ALL because FKs need REFERENCES) ---
  { sql: `GRANT USAGE, CREATE ON SCHEMA app TO "${SP}"` },
  { sql: `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA app TO "${SP}"` },
  { sql: `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO "${SP}"` },
  { sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT ALL PRIVILEGES ON TABLES TO "${SP}"` },
  { sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO "${SP}"` },
  // --- AppKit's persistent cache schema (its migrations run as the SP) ---
  { sql: `GRANT USAGE, CREATE ON SCHEMA appkit TO "${SP}"` },
  { sql: `ALTER TABLE IF EXISTS appkit.appkit_cache_entries OWNER TO "${SP}"`, bestEffort: true },
  { sql: `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA appkit TO "${SP}"`, bestEffort: true },
  { sql: `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA appkit TO "${SP}"`, bestEffort: true },
  { sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA appkit GRANT ALL PRIVILEGES ON TABLES TO "${SP}"` },
  { sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA appkit GRANT USAGE, SELECT ON SEQUENCES TO "${SP}"` },
  // --- dev-owned table columns (the SP's boot ALTERs are rejected on these) ---
  { sql: `ALTER TABLE app.repo_connections ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'pat'` },
  { sql: `ALTER TABLE app.repo_connections ADD COLUMN IF NOT EXISTS installation_id BIGINT` },
  { sql: `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS merge_sha TEXT` },
  { sql: `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_state TEXT` },
  { sql: `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_url TEXT` },
  { sql: `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_started_at TIMESTAMPTZ` },
];

(async () => {
  const client = new Client({
    host: HOST,
    port: 5432,
    database: process.env.PGDATABASE || 'databricks_postgres',
    user: USER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let failures = 0;
  for (const m of MIGRATIONS) {
    try {
      await client.query(m.sql);
      console.log('ok:', m.sql.slice(0, 90).replace(/\s+/g, ' '));
    } catch (e) {
      if (m.bestEffort) {
        console.warn('skip (best-effort):', m.sql.slice(0, 60).replace(/\s+/g, ' '), '-', e.message);
      } else {
        failures++;
        console.error('FAILED:', m.sql.slice(0, 60).replace(/\s+/g, ' '), '-', e.message);
      }
    }
  }
  await client.end();
  if (failures > 0) process.exit(1);
  console.log('dev migrations complete');
})().catch((e) => {
  console.error('migration run failed:', e.message);
  process.exit(1);
});
