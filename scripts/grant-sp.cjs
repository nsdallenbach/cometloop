// Grants the deployed app's service principal access to the `app` schema.
// The schema is owned by the developer role (created during local dev), so the
// SP needs explicit grants. Run from the project root:
//
//   TOKEN=$(databricks postgres generate-database-credential \
//     projects/engagement-console/branches/production/endpoints/primary -o json | jq -r .token)
//   PGPASSWORD=$TOKEN node scripts/grant-sp.cjs
//
const { Client } = require('pg');

const SP = process.env.SP_CLIENT_ID || '8ab241a9-5b84-4f73-bbb8-ea81ba224dda';
const HOST = process.env.PGHOST || 'ep-quiet-leaf-d13g0clu.database.us-west-2.cloud.databricks.com';
const USER = process.env.PGUSER || 'nigel.silva@datavail.com';

const GRANTS = [
  // CREATE is required because the server runs CREATE TABLE IF NOT EXISTS at boot.
  `GRANT USAGE, CREATE ON SCHEMA app TO "${SP}"`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO "${SP}"`,
  `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO "${SP}"`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${SP}"`,
  `ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO "${SP}"`,
];

(async () => {
  const client = new Client({
    host: HOST,
    port: 5432,
    database: 'databricks_postgres',
    user: USER,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  for (const sql of GRANTS) {
    await client.query(sql);
    console.log('ok:', sql);
  }
  await client.end();
})().catch((e) => {
  console.error('grant failed:', e.message);
  process.exit(1);
});
