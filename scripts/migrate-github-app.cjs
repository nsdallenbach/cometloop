// One-off migration the app SP cannot run itself: repo_connections is owned
// by the dev role, so its ALTERs in REPO_SCHEMA_SQL fail at boot. Adds the
// GitHub App columns, then (best-effort) hands app-schema tables to the SP so
// future boot migrations stop needing this dance.
const { Client } = require('pg');

const SP = process.env.SP_CLIENT_ID || '2e02c1a1-68bc-4110-b40f-96dd67ca85f8';
const HOST = process.env.PGHOST || 'ep-quiet-leaf-d13g0clu.database.us-west-2.cloud.databricks.com';
const USER = process.env.PGUSER || 'nigel.silva@datavail.com';

const REQUIRED = [
  `ALTER TABLE app.repo_connections ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'pat'`,
  `ALTER TABLE app.repo_connections ADD COLUMN IF NOT EXISTS installation_id BIGINT`,
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
  for (const sql of REQUIRED) {
    await client.query(sql);
    console.log('ok:', sql);
  }
  // Best-effort ownership handover so the SP can run future ALTERs at boot.
  const { rows } = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'app'`);
  for (const r of rows) {
    try {
      await client.query(`ALTER TABLE app."${r.tablename}" OWNER TO "${SP}"`);
      console.log('owner ->', r.tablename);
    } catch (e) {
      console.warn('owner skip', r.tablename, '-', e.message);
    }
  }
  await client.end();
})().catch((e) => {
  console.error('migration failed:', e.message);
  process.exit(1);
});
