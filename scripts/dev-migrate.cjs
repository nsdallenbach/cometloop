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
  // DAT-212: workspace identity used by project membership / inherited runner access.
  { sql: `ALTER TABLE app.team_members ADD COLUMN IF NOT EXISTS email TEXT` },
  { sql: `CREATE UNIQUE INDEX IF NOT EXISTS team_members_email_unique ON app.team_members (LOWER(email)) WHERE email IS NOT NULL` },
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
  // DAT-194: actual_hours measured wall clock (claim → task close), which
  // counted wedged-runner idle and review wait. Recompute every recorded
  // actual from the activity window — tool-call stream bounds when present,
  // else claim → last heartbeat — matching agentHoursFromRuns. Idempotent:
  // only rows that differ from the recomputed value are touched.
  {
    sql: `WITH activity AS (
      SELECT at.ticket_key, SUM(GREATEST(0, EXTRACT(EPOCH FROM (
        COALESCE((SELECT MAX(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id),
                 LEAST(COALESCE(at.last_heartbeat, at.updated_at), at.updated_at))
        - COALESCE((SELECT MIN(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id), at.claimed_at)
      ))))/3600.0 AS hours
      FROM app.agent_tasks at
      WHERE at.claimed_at IS NOT NULL AND at.state IN ('done','failed','cancelled')
      GROUP BY at.ticket_key)
    UPDATE app.tickets t SET actual_hours = LEAST(999, GREATEST(0.1, round(a.hours::numeric, 1)))
    FROM activity a
    WHERE t.key = a.ticket_key AND t.actual_hours IS NOT NULL
      AND abs(t.actual_hours - LEAST(999, GREATEST(0.1, round(a.hours::numeric, 1)))) > 0.05`,
  },
  // Keep the calibration table's latest actuals in agreement with the tickets.
  {
    sql: `UPDATE app.ticket_estimates e SET actual_hours = t.actual_hours, actual_source = 'dat-194-activity-recompute'
    FROM app.tickets t
    WHERE e.ticket_key = t.key AND e.actual_hours IS NOT NULL AND t.actual_hours IS NOT NULL
      AND e.id = (SELECT id FROM app.ticket_estimates e2 WHERE e2.ticket_key = t.key AND e2.actual_hours IS NOT NULL ORDER BY id DESC LIMIT 1)
      AND abs(e.actual_hours - t.actual_hours) > 0.05`,
  },
  // --- DAT-194 (part 2): backdate pre-trail history from the feed log. ---
  // Tickets done before the event trail existed got done_at stamped at the
  // done_at migration's run time and a single synthetic 'done' event at the
  // engagement's creation — flattening every lead time. The feed recorded the
  // real moments all along ("Created ticket KEY — …", "… KEY moved to Done.").
  // (1) done_at ← the latest feed item announcing the ticket moved to Done,
  // when it disagrees by more than an hour.
  {
    sql: `UPDATE app.tickets t SET done_at = f.at
    FROM (SELECT t2.key, MAX(fi.created_at) AS at
          FROM app.tickets t2 JOIN app.feed_items fi
            ON fi.engagement_id = t2.engagement_id AND fi.text LIKE '%' || t2.key || ' moved to Done%'
          GROUP BY t2.key) f
    WHERE t.key = f.key AND t.status = 'done'
      AND abs(EXTRACT(EPOCH FROM (t.done_at - f.at))) > 3600`,
  },
  // (2) Synthetic creation events (from_status IS NULL) ← the feed's
  // "Created ticket" moment, when one exists and disagrees by > 1 minute.
  {
    sql: `UPDATE app.ticket_events e SET created_at = f.at
    FROM (SELECT t2.key, MIN(fi.created_at) AS at
          FROM app.tickets t2 JOIN app.feed_items fi
            ON fi.engagement_id = t2.engagement_id AND fi.text LIKE 'Created ticket ' || t2.key || ' %'
          GROUP BY t2.key) f
    WHERE e.ticket_key = f.key AND e.from_status IS NULL
      AND abs(EXTRACT(EPOCH FROM (e.created_at - f.at))) > 60`,
  },
  // (3) Pre-trail done tickets whose ONLY event is the synthetic 'done'
  // snapshot: give them a real done event at done_at, then repurpose the
  // synthetic row as the creation event. Order matters; both are idempotent
  // (the count/status guards stop matching after the first run).
  {
    sql: `INSERT INTO app.ticket_events (ticket_key, engagement_id, from_status, to_status, created_at)
    SELECT t.key, t.engagement_id, 'review', 'done', t.done_at
    FROM app.tickets t
    WHERE t.status = 'done' AND t.done_at IS NOT NULL
      AND (SELECT COUNT(*) FROM app.ticket_events e WHERE e.ticket_key = t.key) = 1
      AND EXISTS (SELECT 1 FROM app.ticket_events e WHERE e.ticket_key = t.key AND e.from_status IS NULL AND e.to_status = 'done')`,
  },
  {
    sql: `UPDATE app.ticket_events e SET to_status = 'backlog'
    FROM app.tickets t
    WHERE e.ticket_key = t.key AND e.from_status IS NULL AND e.to_status = 'done' AND t.status = 'done'
      AND (SELECT COUNT(*) FROM app.ticket_events e2 WHERE e2.ticket_key = t.key) = 2`,
  },
  // (4) The done event's timestamp follows any done_at correction from (1).
  {
    sql: `UPDATE app.ticket_events e SET created_at = t.done_at
    FROM app.tickets t
    WHERE e.ticket_key = t.key AND e.to_status = 'done' AND t.status = 'done' AND t.done_at IS NOT NULL
      AND e.id = (SELECT MAX(e2.id) FROM app.ticket_events e2 WHERE e2.ticket_key = t.key AND e2.to_status = 'done')
      AND abs(EXTRACT(EPOCH FROM (e.created_at - t.done_at))) > 3600`,
  },
  // When the ticket body/description was last edited (DAT-174); null = never edited.
  { sql: `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ` },
  // --- DAT-195: both time estimates become mandatory. Rows missing either
  // are tagged for lead review (the content-based backfill endpoint from
  // DAT-197 can then re-estimate them), backfilled deterministically —
  // est_hours from an hour-suffixed est label when one exists, else 1h;
  // human_est_hours at the DAT-175 4× ratio — and the columns locked NOT
  // NULL. Tag guard keeps the append idempotent across reruns.
  {
    sql: `UPDATE app.tickets SET tags = tags || '["needs-estimate-review"]'::jsonb
    WHERE (est_hours IS NULL OR human_est_hours IS NULL)
      AND NOT tags @> '["needs-estimate-review"]'::jsonb`,
  },
  {
    sql: `UPDATE app.tickets
    SET est_hours = LEAST(400, GREATEST(0.1, (substring(est from '^([0-9]+\\.?[0-9]*)\\s*[hH]$'))::real))
    WHERE est_hours IS NULL AND est ~ '^[0-9]+\\.?[0-9]*\\s*[hH]$'`,
  },
  { sql: `UPDATE app.tickets SET est_hours = 1 WHERE est_hours IS NULL` },
  { sql: `UPDATE app.tickets SET human_est_hours = LEAST(999, round((est_hours * 4)::numeric, 1))
          WHERE human_est_hours IS NULL` },
  { sql: `ALTER TABLE app.tickets ALTER COLUMN est_hours SET NOT NULL` },
  { sql: `ALTER TABLE app.tickets ALTER COLUMN human_est_hours SET NOT NULL` },
  // Attachments metadata: FK onto dev-owned tickets, so the table is created
  // here as the dev role; dev default privileges auto-grant the app SP.
  // DAT-201 review-SLA escalation. `opened_at` starts the review clock (the
  // boot ALTER in REPO_SCHEMA_SQL is rejected on this dev-owned table, and the
  // PR upsert writes the column, so this must run before the next deploy).
  // Existing rows stay NULL and are filled with the provider's real creation
  // date on the next repo sync — a long-open unreviewed PR escalates once then.
  { sql: `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ` },
  // The escalation table FKs onto dev-owned repo_connections, so — like
  // ticket_attachments below — it is created here as the dev role; the boot
  // schema creates the identical table on a fresh install.
  { sql: `CREATE TABLE IF NOT EXISTS app.pr_review_escalations (
    id SERIAL PRIMARY KEY,
    connection_id INT NOT NULL REFERENCES app.repo_connections(id) ON DELETE CASCADE,
    pr_number INT NOT NULL,
    ticket_key TEXT NOT NULL,
    engagement_id TEXT NOT NULL,
    timer_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stage TEXT NOT NULL DEFAULT 'waiting',
    pinged_at TIMESTAMPTZ,
    flagged_at TIMESTAMPTZ,
    cleared_at TIMESTAMPTZ,
    cleared_reason TEXT,
    dismissed_at TIMESTAMPTZ,
    dismissed_by TEXT,
    dismiss_count INT NOT NULL DEFAULT 0,
    lead_email TEXT,
    UNIQUE (connection_id, pr_number)
  )` },
  { sql: `CREATE INDEX IF NOT EXISTS pr_review_escalations_ticket ON app.pr_review_escalations (ticket_key)` },
  { sql: `CREATE INDEX IF NOT EXISTS pr_review_escalations_stage ON app.pr_review_escalations (stage)` },
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
