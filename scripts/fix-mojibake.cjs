// DAT-198: detect and (where possible) repair mojibake in ticket text.
//
// The encoding bug (see docs/incidents/2026-08-12-ticket-mojibake.md) let
// clients that encode JSON bodies in Windows-1252 write corrupted text:
// bytes invalid in UTF-8 became U+FFFD (the on-board �), and characters the
// legacy codepage cannot express arrived pre-flattened to '?'. Both are
// lossy — the original characters are gone — so those rows can only be
// FLAGGED for human follow-up. Text corrupted the other way around (UTF-8
// bytes mis-read as Windows-1252, e.g. "â€™" where a ’ belongs) is lossless
// and CAN be repaired by reversing the mis-decode.
//
// Usage (read-only report by default):
//   TOKEN=$(databricks postgres generate-database-credential \
//     projects/engagement-console/branches/production/endpoints/primary -o json | jq -r .token)
//   PGPASSWORD=$TOKEN node scripts/fix-mojibake.cjs             # report only
//   PGPASSWORD=$TOKEN node scripts/fix-mojibake.cjs --repair    # apply reversible repairs
//   PGPASSWORD=$TOKEN node scripts/fix-mojibake.cjs --flag      # tag unrecoverable tickets 'encoding-corrupt'
//
// (PowerShell: $env:PGPASSWORD = (databricks postgres generate-database-credential ... | ConvertFrom-Json).token)
//
// Idempotent: repairs only change text that round-trips cleanly, the flag tag
// is added once, and rerunning after a full pass reports nothing.
const { Client } = require('pg');

const HOST = process.env.PGHOST || 'ep-quiet-leaf-d13g0clu.database.us-west-2.cloud.databricks.com';
const USER = process.env.PGUSER || 'nigel.silva@datavail.com';

const REPAIR = process.argv.includes('--repair');
const FLAG = process.argv.includes('--flag');
const FLAG_TAG = 'encoding-corrupt';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const windows1252 = new TextDecoder('windows-1252');

/** U+FFFD or lone surrogate halves — lossy damage, cannot be reconstructed. */
function hasUnrecoverableMojibake(text) {
  return /�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

const cp1252Reverse = new Map();
const continuationFaces = new Set();
for (let byte = 0; byte < 256; byte++) {
  const code = windows1252.decode(new Uint8Array([byte])).charCodeAt(0);
  cp1252Reverse.set(code, byte);
  if (byte >= 0x80 && byte <= 0xbf) continuationFaces.add(code);
}

/** Mirrors repairDoubleEncoding in server/routes/utf8-body.ts (kept in CJS for the standalone script). */
function repairDoubleEncoding(text) {
  let signature = false;
  for (let i = 0; i < text.length - 1 && !signature; i++) {
    const c = text.charCodeAt(i);
    signature = (c === 0xc2 || c === 0xc3 || c === 0xe2) && continuationFaces.has(text.charCodeAt(i + 1));
  }
  if (!signature) return null;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const byte = cp1252Reverse.get(text.charCodeAt(i));
    if (byte === undefined) return null;
    bytes[i] = byte;
  }
  try {
    const repaired = strictUtf8.decode(bytes);
    return repaired === text ? null : repaired;
  } catch {
    return null;
  }
}

/** First mojibake neighborhood of a string, for the report. */
function snippet(text) {
  const at = text.search(/�|[\uD800-\uDFFF]|[ÂÃâ]/);
  const start = Math.max(0, at - 30);
  return text.slice(start, start + 70).replace(/\s+/g, ' ');
}

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

  const findings = []; // { key, engagement_id, field, kind, before, after? }
  const inspect = (key, engagementId, field, text) => {
    if (typeof text !== 'string' || !text) return;
    const repaired = repairDoubleEncoding(text);
    if (repaired !== null) {
      findings.push({ key, engagementId, field, kind: 'repairable', before: text, after: repaired });
    } else if (hasUnrecoverableMojibake(text)) {
      findings.push({ key, engagementId, field, kind: 'unrecoverable', before: text });
    }
  };

  const tickets = (await client.query('SELECT key, engagement_id, title, description, ac, tags FROM app.tickets ORDER BY key')).rows;
  for (const t of tickets) {
    inspect(t.key, t.engagement_id, 'title', t.title);
    inspect(t.key, t.engagement_id, 'description', t.description);
    const ac = Array.isArray(t.ac) ? t.ac : [];
    ac.forEach((a, i) => inspect(t.key, t.engagement_id, `ac[${i}]`, a));
  }
  const comments = (await client.query('SELECT id, ticket_key, body FROM app.ticket_comments ORDER BY id')).rows;
  for (const c of comments) inspect(c.ticket_key, null, `comment#${c.id}`, c.body);

  if (findings.length === 0) {
    console.log('No mojibake found in ticket titles, descriptions, acceptance criteria or comments.');
    await client.end();
    return;
  }

  console.log(`Found ${findings.length} corrupted field(s) across ${new Set(findings.map((f) => f.key)).size} ticket(s):\n`);
  for (const f of findings) {
    console.log(`  ${f.key}  ${f.field.padEnd(14)}  ${f.kind.padEnd(13)}  …${snippet(f.before)}…`);
    if (f.after) console.log(`  ${''.padEnd(4)}  ${'fix'.padEnd(14)}  ${''.padEnd(13)}  …${snippet(f.after)}…`);
  }

  let repaired = 0;
  if (REPAIR) {
    for (const f of findings.filter((x) => x.kind === 'repairable')) {
      if (f.field === 'title') {
        await client.query('UPDATE app.tickets SET title = $2 WHERE key = $1', [f.key, f.after]);
      } else if (f.field === 'description') {
        await client.query('UPDATE app.tickets SET description = $2 WHERE key = $1', [f.key, f.after]);
      } else if (f.field.startsWith('ac[')) {
        const idx = Number(/\[(\d+)\]/.exec(f.field)[1]);
        await client.query(`UPDATE app.tickets SET ac = jsonb_set(ac, $2, to_jsonb($3::text)) WHERE key = $1`, [f.key, `{${idx}}`, f.after]);
      } else if (f.field.startsWith('comment#')) {
        await client.query('UPDATE app.ticket_comments SET body = $2 WHERE id = $1', [Number(f.field.slice(8)), f.after]);
      }
      repaired++;
    }
    console.log(`\nRepaired ${repaired} field(s).`);
  }

  if (FLAG) {
    const unrecoverableKeys = [...new Set(findings.filter((x) => x.kind === 'unrecoverable' && !x.field.startsWith('comment#')).map((x) => x.key))];
    let flagged = 0;
    for (const key of unrecoverableKeys) {
      const { rowCount } = await client.query(
        `UPDATE app.tickets SET tags = tags || to_jsonb($2::text) WHERE key = $1 AND NOT tags ? $2`,
        [key, FLAG_TAG],
      );
      flagged += rowCount ?? 0;
    }
    console.log(`\nTagged ${flagged} ticket(s) '${FLAG_TAG}' for manual follow-up (already-tagged tickets skipped).`);
  }

  if (!REPAIR && !FLAG) {
    console.log('\nRead-only report. Rerun with --repair to apply reversible fixes, --flag to tag unrecoverable tickets.');
  }
  await client.end();
})().catch((e) => {
  console.error('mojibake scan failed:', e.message);
  process.exit(1);
});
