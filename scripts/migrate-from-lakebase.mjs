#!/usr/bin/env node
// One-off copy of the Execution Console engagement out of the Datavail
// Lakebase database into Cometloop's Neon database, renamed on the way:
//
//   engagement id  execution-console  →  cometloop
//   client / name  DATAVAIL / Execution Console  →  COMETLOOP / CometLoop
//
// Everything that hangs off the engagement comes across (tickets, comments,
// links, estimates, events, agent runs, tool calls, usage, feed, notifications,
// standards, workflows). Team members come only when the engagement references
// them. Credentials never do: repo_connections.token is nulled and the
// connection is marked disconnected so it is re-linked to the new repo by hand.
//
// Usage (from the repo root, target from .env.local):
//   node scripts/migrate-from-lakebase.mjs --source-env ../engagement-console/.env [--rekey CL] [--dry-run]
//
// The source password is minted with the Databricks CLI (the same call the old
// deploy used), so `databricks auth login` must have been done on this machine.
// The target must be EMPTY for the tables being copied; the script refuses
// otherwise so it can never double-load.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pg from 'pg';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const DRY = args.includes('--dry-run');
const REKEY = opt('--rekey', null); // e.g. "CL" turns DAT-12 into CL-12 everywhere
const SOURCE_ENV = opt('--source-env', '../engagement-console/.env');
const LAKEBASE_ENDPOINT = 'projects/engagement-console/branches/production/endpoints/primary';

const OLD_ID = 'execution-console';
const NEW_ID = 'cometloop';
const ENGAGEMENT_PATCH = { client: 'COMETLOOP', name: 'CometLoop' };

/** Tables that exist only on one side or must not be copied. */
const SKIP = new Set(['canvas_zones']);

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

async function sourceClient() {
  const env = readEnv(path.resolve(SOURCE_ENV));
  const token = JSON.parse(execSync(`databricks postgres generate-database-credential ${LAKEBASE_ENDPOINT} -o json`, { encoding: 'utf8' })).token;
  const user = JSON.parse(execSync('databricks current-user me -o json', { encoding: 'utf8' })).userName;
  const c = new pg.Client({ host: env.PGHOST, port: Number(env.PGPORT) || 5432, database: env.PGDATABASE, user, password: token, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

async function targetClient() {
  const env = readEnv(path.resolve('.env.local'));
  if (!env.DATABASE_URL) throw new Error('.env.local has no DATABASE_URL');
  const c = new pg.Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

/** Column names per table for one side. */
async function columns(c) {
  const { rows } = await c.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'app' ORDER BY table_name, ordinal_position`,
  );
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.table_name)) out.set(r.table_name, []);
    out.get(r.table_name).push({ name: r.column_name, type: r.data_type });
  }
  return out;
}

/** Tables ordered so that every referenced table loads before its referrer. */
async function loadOrder(c, tables) {
  const { rows } = await c.query(`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'app' AND tc.constraint_type = 'FOREIGN KEY'`);
  const parents = new Map(tables.map((t) => [t, new Set()]));
  for (const r of rows) if (parents.has(r.child) && parents.has(r.parent) && r.child !== r.parent) parents.get(r.child).add(r.parent);
  const done = [];
  const seen = new Set();
  const visit = (t, stack = new Set()) => {
    if (seen.has(t)) return;
    if (stack.has(t)) throw new Error(`FK cycle through ${t}`);
    stack.add(t);
    for (const p of parents.get(t)) visit(p, stack);
    seen.add(t);
    done.push(t);
  };
  for (const t of tables) visit(t);
  return done;
}

/** Serial columns to re-seat after loading rows with explicit ids. */
async function serialColumns(c) {
  const { rows } = await c.query(
    `SELECT table_name, column_name, pg_get_serial_sequence('app.' || table_name, column_name) AS seq
     FROM information_schema.columns WHERE table_schema = 'app' AND column_default LIKE 'nextval%'`,
  );
  return rows.filter((r) => r.seq);
}

const rekey = (v) => (REKEY && typeof v === 'string' ? v.replace(/\bDAT-(\d+)\b/g, `${REKEY}-$1`) : v);

/** Per-row rewrite: engagement id, rename, ticket keys, dropped credentials. */
function transform(table, row) {
  const out = { ...row };
  if ('engagement_id' in out && out.engagement_id === OLD_ID) out.engagement_id = NEW_ID;
  if (table === 'engagements' && out.id === OLD_ID) Object.assign(out, { id: NEW_ID }, ENGAGEMENT_PATCH);
  if (table === 'repo_connections') Object.assign(out, { token: '', status: 'disconnected', last_error: 'Re-link after the move to nsdallenbach/cometloop' });
  if (REKEY) {
    for (const k of ['key', 'ticket_key', 'linked_key', 'target_ticket', 'result_ticket', 'ticket']) if (k in out) out[k] = rekey(out[k]);
    for (const k of ['title', 'description', 'body', 'text', 'message', 'reason', 'branch_name', 'branch', 'instructions', 'result', 'detail']) if (k in out) out[k] = rekey(out[k]);
  }
  return out;
}

/** Rows to copy for a table: everything, except reference tables are trimmed to what the engagement uses. */
async function sourceRows(src, table) {
  if (table === 'team_members') {
    return (
      await src.query(
        `SELECT * FROM app.team_members WHERE id IN (SELECT member_id FROM app.engagement_members WHERE engagement_id = $1)
          OR LOWER(email) IN (SELECT LOWER(email) FROM app.engagement_leads WHERE engagement_id = $1)`,
        [OLD_ID],
      )
    ).rows;
  }
  return (await src.query(`SELECT * FROM app.${table}`)).rows;
}

async function main() {
  const src = await sourceClient();
  const dst = await targetClient();
  try {
    const [srcCols, dstCols] = await Promise.all([columns(src), columns(dst)]);
    const tables = [...srcCols.keys()].filter((t) => dstCols.has(t) && !SKIP.has(t));
    const missing = [...srcCols.keys()].filter((t) => !dstCols.has(t) && !SKIP.has(t));
    if (missing.length) console.log(`not in target, skipped: ${missing.join(', ')}`);
    const order = await loadOrder(dst, tables);

    // Refuse to load onto data.
    for (const t of order) {
      const n = Number((await dst.query(`SELECT count(*) AS n FROM app.${t}`)).rows[0].n);
      if (n > 0) throw new Error(`target app.${t} already has ${n} rows — this script only loads into empty tables`);
    }

    const engagements = (await src.query('SELECT id FROM app.engagements')).rows.map((r) => r.id);
    if (engagements.length !== 1 || engagements[0] !== OLD_ID) throw new Error(`expected exactly one source engagement (${OLD_ID}), found ${engagements.join(', ')}`);

    await dst.query('BEGIN');
    let total = 0;
    for (const t of order) {
      const rows = await sourceRows(src, t);
      const shared = srcCols.get(t).map((c) => c.name).filter((n) => dstCols.get(t).some((c) => c.name === n));
      const dropped = srcCols.get(t).map((c) => c.name).filter((n) => !shared.includes(n));
      let n = 0;
      for (const raw of rows) {
        const row = transform(t, raw);
        const values = shared.map((c) => {
          const v = row[c];
          const type = dstCols.get(t).find((x) => x.name === c).type;
          return v !== null && typeof v === 'object' && !(v instanceof Date) && (type === 'jsonb' || type === 'json') ? JSON.stringify(v) : v;
        });
        if (!DRY) {
          await dst.query(`INSERT INTO app.${t} (${shared.map((c) => `"${c}"`).join(',')}) VALUES (${shared.map((_, i) => `$${i + 1}`).join(',')})`, values);
        }
        n++;
      }
      total += n;
      console.log(`${t.padEnd(24)} ${String(n).padStart(6)} rows${dropped.length ? `   (source-only columns dropped: ${dropped.join(', ')})` : ''}`);
    }
    if (!DRY) {
      for (const s of await serialColumns(dst)) {
        await dst.query(`SELECT setval($1, COALESCE((SELECT MAX("${s.column_name}") FROM app.${s.table_name}), 0) + 1, false)`, [s.seq]);
      }
      await dst.query('COMMIT');
    } else {
      await dst.query('ROLLBACK');
    }
    console.log(`\n${DRY ? 'dry run — nothing written' : 'committed'}: ${total} rows across ${order.length} tables; engagement ${OLD_ID} → ${NEW_ID} (${ENGAGEMENT_PATCH.name})${REKEY ? `; ticket keys DAT-* → ${REKEY}-*` : ''}`);
  } catch (err) {
    await dst.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await src.end();
    await dst.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
