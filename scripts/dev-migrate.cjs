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
  // --- feature-PR columns on dev-owned tables (merge train, Aug 2026) ---
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS roadmap_item TEXT` },
  { sql: `ALTER TABLE app.engagements ADD COLUMN IF NOT EXISTS roadmap_settings JSONB` },
  // est_hours settled as REAL (PR #24 wanted REAL, #34 NUMERIC) so node-pg
  // returns JS numbers to both features.
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS est_hours REAL` },
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS actual_hours REAL` },
  // Human-dev estimate next to the agent estimate (DAT-175). Existing tickets
  // are backfilled at 4× the agent estimate — the fallback ratio the
  // estimation code uses when the model returns no human figure; new tickets
  // get an independently reasoned value from the model.
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS human_est_hours REAL` },
  { sql: `UPDATE app.tickets SET human_est_hours = LEAST(999, round((est_hours * 4)::numeric, 1))
          WHERE human_est_hours IS NULL AND est_hours IS NOT NULL` },
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ` },
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'` },
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS branch TEXT` },
  // When the ticket body/description was last edited (DAT-174); null = never edited.
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ` },
  // Attachments metadata: FK onto dev-owned tickets, so the table is created
  // here as the dev role; dev default privileges auto-grant the app SP.
  { sql: `CREATE TABLE IF NOT EXISTS app.ticket_attachments (
    id TEXT PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    size BIGINT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    sha256 TEXT NOT NULL,
    uploader TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )` },
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
