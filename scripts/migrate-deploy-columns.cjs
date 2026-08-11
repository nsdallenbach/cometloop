// Dev-role migration for the deploy-gating columns on app.repo_prs — the
// app SP can't ALTER this dev-owned table at boot (see migrate-github-app).
const { Client } = require('pg');

const HOST = process.env.PGHOST || 'ep-quiet-leaf-d13g0clu.database.us-west-2.cloud.databricks.com';
const USER = process.env.PGUSER || 'nigel.silva@datavail.com';

const SQL = [
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS merge_sha TEXT`,
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_state TEXT`,
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_url TEXT`,
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_started_at TIMESTAMPTZ`,
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
  for (const sql of SQL) {
    await client.query(sql);
    console.log('ok:', sql);
  }
  await client.end();
})().catch((e) => {
  console.error('migration failed:', e.message);
  process.exit(1);
});
