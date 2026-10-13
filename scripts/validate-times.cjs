// Read-only data-quality audit for the time data velocity metrics depend on
// (DAT-194). Reports, never mutates. Run like dev-migrate:
//
//   TOKEN=$(databricks postgres generate-database-credential \
//     projects/engagement-console/branches/production/endpoints/primary -o json | jq -r .token)
//   PGPASSWORD=$TOKEN node scripts/validate-times.cjs
const { Client } = require('pg');

const HOST = process.env.PGHOST || '';
const USER = process.env.PGUSER || '';
if (!HOST || !USER) {
  console.error('Set PGHOST and PGUSER to the Lakebase endpoint and developer role.');
  process.exit(1);
}

const CHECKS = [
  {
    name: 'Done tickets missing done_at',
    sql: `SELECT key FROM app.tickets WHERE status = 'done' AND done_at IS NULL ORDER BY key`,
  },
  {
    name: "Done tickets with no 'done' event in the trail",
    sql: `SELECT t.key FROM app.tickets t WHERE t.status = 'done'
          AND NOT EXISTS (SELECT 1 FROM app.ticket_events e WHERE e.ticket_key = t.key AND e.to_status = 'done')
          ORDER BY t.key`,
  },
  {
    name: 'Tickets whose status disagrees with their latest event (trail drift)',
    sql: `SELECT t.key, t.status AS board, e.to_status AS trail FROM app.tickets t
          JOIN LATERAL (SELECT to_status FROM app.ticket_events ev WHERE ev.ticket_key = t.key ORDER BY created_at DESC, id DESC LIMIT 1) e ON true
          WHERE t.status <> e.to_status ORDER BY t.key`,
  },
  {
    name: 'Terminal claimed runs with no tool calls AND no heartbeat (wall-clock-only actuals)',
    sql: `SELECT at.id, at.ticket_key, round(EXTRACT(EPOCH FROM (at.updated_at - at.claimed_at))/3600.0, 1) AS wallclock_h
          FROM app.agent_tasks at
          WHERE at.claimed_at IS NOT NULL AND at.state IN ('done','failed','cancelled')
            AND at.last_heartbeat IS NULL
            AND NOT EXISTS (SELECT 1 FROM app.agent_tool_calls c WHERE c.task_id = at.id)
          ORDER BY wallclock_h DESC`,
  },
  {
    name: 'Wall-clock vs activity-window discrepancy > 0.5h (inflated actuals)',
    sql: `SELECT at.ticket_key, at.id AS task,
            round(EXTRACT(EPOCH FROM (at.updated_at - at.claimed_at))/3600.0, 1) AS wallclock_h,
            round(EXTRACT(EPOCH FROM (
              COALESCE((SELECT MAX(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id),
                       LEAST(COALESCE(at.last_heartbeat, at.updated_at), at.updated_at))
              - COALESCE((SELECT MIN(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id), at.claimed_at)
            ))/3600.0, 1) AS activity_h
          FROM app.agent_tasks at
          WHERE at.claimed_at IS NOT NULL AND at.state IN ('done','failed','cancelled')
            AND EXTRACT(EPOCH FROM (at.updated_at - at.claimed_at))/3600.0
              - EXTRACT(EPOCH FROM (
                  COALESCE((SELECT MAX(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id),
                           LEAST(COALESCE(at.last_heartbeat, at.updated_at), at.updated_at))
                  - COALESCE((SELECT MIN(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id), at.claimed_at)
                ))/3600.0 > 0.5
          ORDER BY 3 DESC`,
  },
  {
    name: 'Stored tickets.actual_hours vs recomputed activity hours (> 0.2h apart)',
    sql: `WITH activity AS (
            SELECT at.ticket_key, SUM(GREATEST(0, EXTRACT(EPOCH FROM (
              COALESCE((SELECT MAX(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id),
                       LEAST(COALESCE(at.last_heartbeat, at.updated_at), at.updated_at))
              - COALESCE((SELECT MIN(c.called_at) FROM app.agent_tool_calls c WHERE c.task_id = at.id), at.claimed_at)
            ))))/3600.0 AS hours
            FROM app.agent_tasks at
            WHERE at.claimed_at IS NOT NULL AND at.state IN ('done','failed','cancelled')
            GROUP BY at.ticket_key)
          SELECT t.key, t.actual_hours AS stored, round(GREATEST(0.1, a.hours)::numeric, 1) AS recomputed
          FROM app.tickets t JOIN activity a ON a.ticket_key = t.key
          WHERE t.actual_hours IS NOT NULL AND abs(t.actual_hours - GREATEST(0.1, a.hours)) > 0.2
          ORDER BY abs(t.actual_hours - a.hours) DESC`,
  },
  {
    name: 'Done tickets with done_at but no review event ever (skipped the human gate in the trail)',
    sql: `SELECT t.key FROM app.tickets t WHERE t.status = 'done'
          AND NOT EXISTS (SELECT 1 FROM app.ticket_events e WHERE e.ticket_key = t.key AND e.to_status = 'review')
          ORDER BY t.key`,
  },
];

async function main() {
  const client = new Client({
    host: HOST,
    port: 5432,
    database: 'databricks_postgres',
    user: USER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  let issues = 0;
  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql);
    console.log(`\n== ${check.name}: ${rows.length}`);
    for (const row of rows.slice(0, 12)) console.log('   ', JSON.stringify(row));
    if (rows.length > 12) console.log(`    … and ${rows.length - 12} more`);
    issues += rows.length;
  }
  console.log(`\nTotal findings: ${issues}`);
  await client.end();
}

main().catch((err) => {
  console.error('validation failed:', err.message);
  process.exit(1);
});
