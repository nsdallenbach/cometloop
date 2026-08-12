#!/usr/bin/env node
// DAT-171: end-to-end validation of the agent commenting and flag paths over
// the console's plain HTTP interface — the same surface devbox runners use.
//
//   TASK_ID=130 AGENT=local-runner node scripts/validate-agent-comms.mjs
//
// Exercises, against the deployed console (and therefore live Lakebase):
//   1. report_agent_progress  POST   /api/agent/work/:id/progress
//   2. flag_agent_work        POST   /api/agent/work/:id/flag
//   3. clear_agent_flag       DELETE /api/agent/work/:id/flag
//   4. cross-ticket comment   POST   /api/tickets/:key/comments (a ticket the
//      agent does not own), persistence verified by reading it back
//   5. inter-agent messaging  /api/agent/coordination/messages — broadcast
//      fan-out (verified via an anonymous read, which sees broadcasts only),
//      targeted-message persistence + SLA + human-review mirror comment, and
//      the permission guards as negative tests (spoofed sender and foreign
//      inbox reads must 403). A live receipt round trip between two claimed
//      agents needs two active tasks — see docs/coordination-drills.md.
// Every step verifies the write landed (task row and/or ticket comment) and
// records latency. Prints a PASS/FAIL table and exits non-zero on any failure.
// STEPS=progress,flag,clear,cross-comment,messaging (env) limits the run.
//
// The MCP legs of the same paths are the delivery-console MCP server
// (mcp/server.mjs), which calls these exact endpoints — a devbox Claude Code
// session exercises those tools directly; this script is the HTTP half.
//
// Requires an active claimed/working task (TASK_ID) owned by AGENT — progress
// and flag endpoints 404 on inactive tasks and 409 for the wrong agent.
//
// Env (same conventions as devbox-runner/runner.mjs):
//   APP_URL           console base URL
//   DATABRICKS_HOST   workspace URL (for CLI token minting)
//   DATABRICKS_TOKEN  pre-minted OAuth token (skips the CLI)
//   DATABRICKS_CLI    databricks binary path (default: "databricks")
//   TASK_ID           active agent task id to exercise (required)
//   AGENT             runner name that owns the task (default: local-runner)
//   TICKET            ticket the task belongs to (default: DAT-171)
//   TARGET_TICKET     ticket the agent does NOT own, for the cross-ticket
//                     comment check (default: DAT-182)
import { execFileSync } from 'child_process';

const APP = (process.env.APP_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const TASK_ID = Number(process.env.TASK_ID);
const AGENT = process.env.AGENT ?? 'local-runner';
const TICKET = process.env.TICKET ?? 'DAT-171';
const TARGET = process.env.TARGET_TICKET ?? 'DAT-182';
const RUN = `dat171-${Date.now().toString(36)}`; // unique marker so reruns don't collide

if (!Number.isInteger(TASK_ID)) {
  console.error('TASK_ID env var (active agent task id) is required');
  process.exit(2);
}

function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  return JSON.parse(out).access_token;
}

const tok = token();
/** Authed JSON call; returns { status, ms, body }. Throws only on network death. */
async function call(method, path, body) {
  const t0 = performance.now();
  const resp = await fetch(`${APP}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const ms = Math.round(performance.now() - t0);
  const raw = await resp.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = { raw: raw.slice(0, 200) };
  }
  return { status: resp.status, ms, body: parsed };
}

const ONLY = (process.env.STEPS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const results = [];
async function step(name, fn) {
  if (ONLY.length > 0 && !ONLY.some((s) => name.startsWith(s))) return;
  process.stdout.write(`\n== ${name}\n`);
  try {
    const evidence = await fn();
    results.push({ name, pass: true, evidence });
    console.log(`  PASS`);
  } catch (err) {
    results.push({ name, pass: false, evidence: String(err.message ?? err) });
    console.log(`  FAIL: ${String(err.message ?? err)}`);
  }
}
function assert(cond, label) {
  if (!cond) throw new Error(label);
  console.log(`  ✓ ${label}`);
}
const comments = async (key) => (await call('GET', `/api/tickets/${key}/comments`)).body;
const task = async () => (await call('GET', `/api/agent/work/${TASK_ID}`)).body.task;

console.log(`DAT-171 validation run ${RUN} against ${APP}`);
console.log(`task ${TASK_ID}, agent ${AGENT}, ticket ${TICKET}, cross-ticket target ${TARGET}`);

await step('report_agent_progress (HTTP)', async () => {
  const note = `[${RUN}] HTTP validation: report_agent_progress via POST /api/agent/work/${TASK_ID}/progress — this note should appear as a ${TICKET} comment authored by ${AGENT} and as the task's live board note.`;
  const r = await call('POST', `/api/agent/work/${TASK_ID}/progress`, { agent: AGENT, note });
  assert(r.status === 200 && r.body?.ok === true, `POST progress → ${r.status} ${JSON.stringify(r.body)} in ${r.ms}ms`);
  const t = await task();
  assert(t.last_note === note, 'task.last_note updated to the posted note');
  const c = (await comments(TICKET)).find((x) => x.body === note);
  assert(c && c.author === AGENT, `note persisted as ${TICKET} comment id ${c?.id} by ${c?.author}`);
  return { request: { agent: AGENT, note: `${note.slice(0, 80)}…` }, response: r.body, latency_ms: r.ms, comment_id: c.id };
});

await step('flag_agent_work (HTTP)', async () => {
  const reason = `[${RUN}] HTTP validation: flag_agent_work via POST /api/agent/work/${TASK_ID}/flag — synthetic warning, cleared moments later by the clear_agent_flag check.`;
  const r = await call('POST', `/api/agent/work/${TASK_ID}/flag`, { agent: AGENT, reason });
  assert(r.status === 200 && r.body?.ok === true, `POST flag → ${r.status} ${JSON.stringify(r.body)} in ${r.ms}ms`);
  const t = await task();
  assert(t.flag === reason, 'task.flag set to the posted reason (board shows attention treatment)');
  const c = (await comments(TICKET)).find((x) => x.body === `⚠ Flagged: ${reason}`);
  assert(c && c.author === AGENT, `flag mirrored as ${TICKET} comment id ${c?.id}`);
  return { request: { agent: AGENT, reason: `${reason.slice(0, 80)}…` }, response: r.body, latency_ms: r.ms, comment_id: c.id };
});

await step('clear_agent_flag (HTTP)', async () => {
  const r = await call('DELETE', `/api/agent/work/${TASK_ID}/flag`, { agent: AGENT });
  assert(r.status === 200 && r.body?.ok === true, `DELETE flag → ${r.status} ${JSON.stringify(r.body)} in ${r.ms}ms`);
  const t = await task();
  assert(t.flag === null, 'task.flag cleared (attention treatment removed)');
  const cs = (await comments(TICKET)).filter((x) => x.body === 'Flag cleared.' && x.author === AGENT);
  assert(cs.length > 0, `clearance mirrored as ${TICKET} comment id ${cs.at(-1)?.id}`);
  return { request: { agent: AGENT }, response: r.body, latency_ms: r.ms, comment_id: cs.at(-1).id };
});

await step(`cross-ticket comment on ${TARGET} (HTTP)`, async () => {
  const body = `[${RUN}] DAT-171 validation: agent ${AGENT} (owner of ${TICKET}, not of ${TARGET}) posting via POST /api/tickets/${TARGET}/comments to prove cross-ticket commenting works. Safe to ignore.`;
  const r = await call('POST', `/api/tickets/${TARGET}/comments`, { body });
  assert(r.status === 201 && r.body?.id, `POST comment → ${r.status}, persisted id ${r.body?.id} in ${r.ms}ms`);
  const found = (await comments(TARGET)).find((x) => String(x.id) === String(r.body.id));
  assert(found && found.body === body, 'comment read back from the ticket API (persistence verified)');
  return { response: { id: r.body.id, author: r.body.author, created_at: r.body.created_at }, latency_ms: r.ms };
});

await step('inter-agent messaging (HTTP)', async () => {
  const probe = `${RUN}-probe`;
  // Anonymous read (no agent param) sees broadcasts only — take a cursor.
  const cursor = (await call('GET', '/api/agent/coordination/messages')).body.next_since_id;
  const bcast = await call('POST', '/api/agent/coordination/messages', {
    sender: AGENT,
    type: 'status_update',
    body: `[${RUN}] DAT-171 validation broadcast — verifying the shared inter-agent channel fans out broadcasts.`,
    ticket: TICKET,
  });
  assert(bcast.status === 201, `broadcast posted → ${bcast.status} ${JSON.stringify(bcast.body)?.slice(0, 200)}, id ${bcast.body?.id} in ${bcast.ms}ms`);
  const feed = (await call('GET', `/api/agent/coordination/messages?since_id=${cursor}`)).body;
  assert(
    feed.messages.some((m) => String(m.id) === String(bcast.body.id)),
    'broadcast visible to other agents (anonymous read since cursor)',
  );
  const ask = await call('POST', '/api/agent/coordination/messages', {
    sender: AGENT,
    recipient: probe,
    type: 'request_for_info',
    body: `[${RUN}] DAT-171 validation targeted message — verifying targeted persistence, SLA and the ticket mirror. No reply expected (synthetic recipient).`,
    ticket: TICKET,
    sla: 'wait',
  });
  assert(ask.status === 201, `targeted request posted → ${ask.status} ${JSON.stringify(ask.body)?.slice(0, 200)}, id ${ask.body?.id} in ${ask.ms}ms`);
  assert(ask.body.recipient_agent_id === probe && ask.body.sla === 'wait', 'recipient and SLA persisted on the stored row');
  const mirror = (await comments(TICKET)).find((x) => x.body.includes(`@${probe}`) && x.body.includes(RUN));
  assert(mirror, `targeted message mirrored onto ${TICKET} as comment id ${mirror?.id} (human-review path)`);
  // Permission guards: a caller without an active claim under a name can
  // neither send as it nor read its inbox. Correct rejection = pass.
  const spoof = await call('POST', '/api/agent/coordination/messages', {
    sender: probe,
    type: 'status_update',
    body: `[${RUN}] this should be rejected`,
  });
  assert(spoof.status === 403, `spoofed sender rejected with 403 ("${spoof.body?.error}")`);
  const foreign = await call('GET', `/api/agent/coordination/messages?agent=${probe}`);
  assert(foreign.status === 403, `foreign inbox read rejected with 403 ("${foreign.body?.error}")`);
  return {
    broadcast_id: bcast.body.id,
    targeted_id: ask.body.id,
    mirror_comment_id: mirror.id,
    guards: { spoofed_sender: spoof.status, foreign_inbox: foreign.status },
    latency_ms: { broadcast: bcast.ms, targeted: ask.ms },
  };
});

console.log('\n== Summary');
for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(`\nEvidence JSON:\n${JSON.stringify({ run: RUN, app: APP, task_id: TASK_ID, agent: AGENT, results }, null, 2)}`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
