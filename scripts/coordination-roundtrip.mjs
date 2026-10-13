#!/usr/bin/env node
// Live two-agent coordination round-trip against the deployed console — and
// therefore against real Lakebase Postgres (DAT-149 acceptance scenario).
//
//   node scripts/coordination-roundtrip.mjs
//
// Simulates two agents on different branches: both announce branch activity,
// roundtrip-a asks roundtrip-b a question (SLA: wait), b polls its inbox from
// a cursor, answers, and a receives the reply. Prints each step and exits
// non-zero if any step fails. Rows are left in place — the channel is
// append-only by design, so the run remains auditable afterwards.
//
// Env (same conventions as devbox-runner/runner.mjs):
//   APP_URL           console base URL
//   DATABRICKS_HOST   workspace URL (for CLI token minting)
//   DATABRICKS_TOKEN  pre-minted OAuth token (skips the CLI)
//   DATABRICKS_CLI    databricks binary path (default: "databricks")
import { execFileSync } from 'child_process';

const APP = (process.env.APP_URL ?? '').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? '';
if (!APP || !HOST) {
  console.error('Set APP_URL (the console, e.g. https://<app>.databricksapps.com) and DATABRICKS_HOST (the workspace, for `databricks auth token`).');
  process.exit(1);
}
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const RUN = `rt-${Date.now().toString(36)}`; // unique per run so reruns don't collide
const A = { id: `roundtrip-a-${RUN}`, branch: `DAT-149-demo-a-${RUN}` };
const B = { id: `roundtrip-b-${RUN}`, branch: `DAT-149-demo-b-${RUN}` };

function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  return JSON.parse(out).access_token;
}

const tok = token();
async function call(method, path, body) {
  const resp = await fetch(`${APP}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status}: ${raw.slice(0, 300)}`);
  return raw ? JSON.parse(raw) : null;
}

function assert(cond, label) {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

console.log(`Round-trip ${RUN} against ${APP}\n`);

console.log('1. Both agents announce branch activity');
await call('POST', '/api/agent/coordination/branches', { branch: A.branch, agent: A.id, description: 'Round-trip demo: agent A' });
await call('POST', '/api/agent/coordination/branches', { branch: B.branch, agent: B.id, description: 'Round-trip demo: agent B' });
const { branches } = await call('GET', '/api/agent/coordination/branches');
assert(branches.some((b) => b.branch_name === A.branch), `${A.branch} visible as active`);
assert(branches.some((b) => b.branch_name === B.branch), `${B.branch} visible as active`);

console.log('2. Agent B takes a cursor before the exchange');
const before = await call('GET', `/api/agent/coordination/messages?agent=${encodeURIComponent(B.id)}`);
const cursorB = before.next_since_id;

console.log('3. Agent A asks agent B for info (SLA: wait)');
const ask = await call('POST', '/api/agent/coordination/messages', {
  sender: A.id,
  recipient: B.id,
  type: 'request_for_info',
  body: 'Round-trip check: does your branch touch app.tickets?',
  branch: A.branch,
  sla: 'wait',
});
assert(Number(ask.id) > 0, `message persisted in Lakebase with id ${ask.id} at ${ask.created_at}`);

console.log('4. Agent B polls since its cursor and sees the request');
const inbox = await call('GET', `/api/agent/coordination/messages?agent=${encodeURIComponent(B.id)}&since_id=${cursorB}`);
const req = inbox.messages.find((m) => m.sender_agent_id === A.id);
assert(req, 'request delivered to B');
assert(req.sla === 'wait', 'SLA carried through');

console.log('5. Agent B responds to agent A');
await call('POST', '/api/agent/coordination/messages', {
  sender: B.id,
  recipient: A.id,
  type: 'response',
  body: 'No — my branch only adds a new table.',
  branch: B.branch,
});

console.log('6. Agent A polls and receives the answer — round trip complete');
const replies = await call('GET', `/api/agent/coordination/messages?agent=${encodeURIComponent(A.id)}&since_id=${ask.id}`);
const answer = replies.messages.find((m) => m.sender_agent_id === B.id && m.message_type === 'response');
assert(answer, 'response delivered to A');

console.log('7. Both agents complete; branches close out');
await call('POST', '/api/agent/coordination/branches', { branch: A.branch, agent: A.id, status: 'completed' });
await call('POST', '/api/agent/coordination/branches', { branch: B.branch, agent: B.id, status: 'completed' });
const after = await call('GET', '/api/agent/coordination/branches');
assert(!after.branches.some((b) => [A.branch, B.branch].includes(b.branch_name)), 'demo branches no longer listed active');

console.log('\nRound trip verified — messages remain in app.coordination_messages for audit.');
