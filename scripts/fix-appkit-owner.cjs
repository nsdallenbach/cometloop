// One-off: hand the appkit cache table (owned by the old app SP) to the new
// SP, escalating through databricks_superuser since our user isn't the owner.
const { Client } = require('pg');

const SP = process.env.SP_CLIENT_ID || '2e02c1a1-68bc-4110-b40f-96dd67ca85f8';
const HOST = process.env.PGHOST || 'ep-quiet-leaf-d13g0clu.database.us-west-2.cloud.databricks.com';
const USER = process.env.PGUSER || 'nigel.silva@datavail.com';

const SQL = [
  `SET ROLE databricks_superuser`,
  `ALTER TABLE IF EXISTS appkit.appkit_cache_entries OWNER TO "${SP}"`,
  `RESET ROLE`,
  `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA appkit TO "${SP}"`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA appkit TO "${SP}"`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA appkit GRANT ALL PRIVILEGES ON TABLES TO "${SP}"`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA appkit GRANT USAGE, SELECT ON SEQUENCES TO "${SP}"`,
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
  console.error('failed:', e.message);
  process.exit(1);
});
