#!/usr/bin/env node
// DAT-252: multi-identity scoping probe — run on each machine during the
// beta drill (docs/beta-provisioning.md). Reads the identity-scoped agent
// queue as the signed-in workspace identity and verifies a routed ticket's
// visibility matches what this machine SHOULD see.
//
//   # tester A (the routed ticket must be visible):
//   TICKET=DAT-260 EXPECT=visible node scripts/verify-identity-scoping.mjs
//   # everyone else (must be hidden; also prove the claim is refused):
//   TICKET=DAT-260 EXPECT=hidden CLAIM_PROBE=1 node scripts/verify-identity-scoping.mjs
//
// The CLAIM_PROBE is only honored with EXPECT=hidden — on the visible side a
// probe claim would genuinely claim the task. On the hidden side it is safe by
// construction: the claim endpoint applies the same assigneeScope predicate
// (server/routes/agent-work.ts), so the expected outcome is a 404 refusal, and
// a success would itself be the scoping bug this drill exists to catch.
//
// Also prints the pool (unassigned) queue for the everyone-sees-pool half of
// the drill. Exits 0 when observed visibility matches EXPECT, 1 otherwise.
//
// Env (same conventions as devbox-runner/runner.mjs):
//   APP_URL, DATABRICKS_HOST, DATABRICKS_TOKEN, DATABRICKS_CLI
//   TICKET      ticket key of the routed drill ticket (required)
//   EXPECT      visible | hidden (required)
//   CLAIM_PROBE "1" = with EXPECT=hidden, attempt the claim and require refusal
//   AGENT       agent name for the claim probe (default: scoping-probe-<host>)
import { execFileSync } from 'child_process';
import os from 'os';

const APP = (process.env.APP_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const TICKET = process.env.TICKET;
const EXPECT = process.env.EXPECT;
const CLAIM_PROBE = process.env.CLAIM_PROBE === '1';
const AGENT = process.env.AGENT ?? `scoping-probe-${os.hostname()}`;

if (!TICKET || !['visible', 'hidden'].includes(EXPECT ?? '')) {
  console.error('Usage: TICKET=DAT-XXX EXPECT=visible|hidden [CLAIM_PROBE=1] node scripts/verify-identity-scoping.mjs');
  process.exit(2);
}

function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  return JSON.parse(out).access_token;
}

async function call(method, apiPath, body) {
  const resp = await fetch(`${APP}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, body: await resp.json().catch(() => ({})) };
}

const me = (await call('GET', '/api/me')).body;
console.log(`Scoping probe on ${os.hostname()} as ${me.email} (role ${me.role}) — ticket ${TICKET}, expecting ${EXPECT}\n`);

const work = (await call('GET', '/api/agent/work')).body;
const queued = Array.isArray(work.queued) ? work.queued : [];
const routed = queued.filter((t) => t.assignee);
const pool = queued.filter((t) => !t.assignee);
const target = queued.find((t) => t.ticket_key === TICKET);

console.log(`Queue as seen by this identity: ${queued.length} task(s) — ${pool.length} pool, ${routed.length} routed to me`);
for (const t of queued) console.log(`  - ${t.ticket_key} ${t.assignee ? `(ROUTED TO YOU: ${t.assignee})` : '(pool)'}`);

let ok;
if (EXPECT === 'visible') {
  ok = Boolean(target);
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${TICKET} ${ok ? 'is visible to' : 'is NOT visible to'} ${me.email}${ok ? '' : ' — routing or roster email is wrong'}`);
} else {
  ok = !target;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${TICKET} ${ok ? 'is correctly hidden from' : 'IS VISIBLE to'} ${me.email}${ok ? '' : ' — SCOPING BREACH, stop the drill and flag it'}`);
  if (ok && CLAIM_PROBE) {
    const claim = await call('POST', '/api/agent/work/claim', { agent: AGENT, ticket: TICKET });
    const refused = claim.status !== 200;
    console.log(`${refused ? 'PASS' : 'FAIL'}: claim probe → HTTP ${claim.status}${refused ? ' (refused, as it must be)' : ' — CLAIM SUCCEEDED ACROSS IDENTITIES, scoping breach'}`);
    ok = ok && refused;
  }
}
process.exit(ok ? 0 : 1);
