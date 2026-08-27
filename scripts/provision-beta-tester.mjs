#!/usr/bin/env node
// DAT-252: provision one beta tester end to end — roster, engagement,
// Databricks app permission and role group. Idempotent; run it again freely.
//
//   node scripts/provision-beta-tester.mjs --email sean.law@datavail.com --name "Sean Law"
//
// What it ensures (see docs/beta-provisioning.md for the why):
//   1. app.team_members row with the workspace email (creates the row, or
//      completes the email on an existing row matched by name)
//   2. membership of the engagement (default execution-console)
//   3. CAN_USE on the delivery-console Databricks App
//   4. membership of the eec-developers workspace group
//
// Requires: an admin identity (the script refuses otherwise) and the
// Databricks CLI authenticated against the workspace.
//
// Env (same conventions as devbox-runner/runner.mjs):
//   APP_URL           console base URL
//   DATABRICKS_HOST   workspace URL (for CLI token minting)
//   DATABRICKS_TOKEN  pre-minted OAuth token (skips the CLI)
//   DATABRICKS_CLI    databricks binary path (default: "databricks")
//   APP_NAME          Databricks App name (default: "delivery-console")
import { execFileSync } from 'child_process';

const APP = (process.env.APP_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const APP_NAME = process.env.APP_NAME ?? 'delivery-console';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EMAIL = (arg('email') ?? '').toLowerCase();
const NAME = arg('name');
const ROLE = (arg('role') ?? 'DEVELOPER').toUpperCase();
const ENGAGEMENT = arg('engagement', 'execution-console');

if (!EMAIL || !EMAIL.includes('@') || !NAME) {
  console.error('Usage: node scripts/provision-beta-tester.mjs --email <workspace email> --name "Full Name" [--role DEVELOPER] [--engagement execution-console]');
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
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${method} ${apiPath} → ${resp.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function cli(args) {
  return JSON.parse(execFileSync(CLI, [...args, '--output', 'json'], { encoding: 'utf8' }));
}

const done = (msg) => console.log(`  ✓ ${msg}`);

// ---- 0. caller must be an admin ----
const me = await call('GET', '/api/me');
if (me.role !== 'admin') {
  console.error(`Signed in as ${me.email} (role ${me.role}) — provisioning needs an admin.`);
  process.exit(1);
}
console.log(`Provisioning ${NAME} <${EMAIL}> onto ${ENGAGEMENT} (as ${me.email})`);

// ---- 1. roster row with email ----
const admin = await call('GET', '/api/admin');
let member =
  admin.members.find((m) => (m.email ?? '').toLowerCase() === EMAIL) ??
  admin.members.find((m) => !m.email && m.name.trim().toLowerCase() === NAME.trim().toLowerCase());
if (!member) {
  member = await call('POST', '/api/team-members', { name: NAME, email: EMAIL, role: ROLE });
  done(`created app.team_members row id ${member.id}`);
} else if ((member.email ?? '').toLowerCase() !== EMAIL) {
  member = await call('PUT', `/api/team-members/${member.id}/email`, { email: EMAIL });
  done(`set workspace email on existing roster row id ${member.id} (was missing — routing now works)`);
} else {
  done(`roster row id ${member.id} already has the email`);
}

// ---- 2. engagement membership ----
const assigned = admin.assignments.filter((a) => a.engagement_id === ENGAGEMENT).map((a) => a.member_id);
if (assigned.includes(member.id)) {
  done(`already a member of ${ENGAGEMENT}`);
} else {
  await call('PUT', `/api/engagements/${encodeURIComponent(ENGAGEMENT)}/members`, { memberIds: [...assigned, member.id] });
  done(`joined ${ENGAGEMENT} (team of ${assigned.length + 1})`);
}

// ---- 3. workspace user + app permission ----
const users = cli(['users', 'list', '--filter', `userName eq '${EMAIL}'`]);
if (!Array.isArray(users) || users.length === 0 || !users[0].active) {
  console.error(`  ✗ ${EMAIL} is not an active workspace user — invite them to the workspace first, then rerun.`);
  process.exit(1);
}
done('active workspace user');
cli(['apps', 'update-permissions', APP_NAME, '--json', JSON.stringify({ access_control_list: [{ user_name: EMAIL, permission_level: 'CAN_USE' }] })]);
done(`CAN_USE on the ${APP_NAME} app`);

// ---- 4. eec-developers group ----
const groups = cli(['groups', 'list', '--filter', "displayName eq 'eec-developers'"]);
const group = Array.isArray(groups) ? groups[0] : null;
if (!group) {
  console.error('  ✗ eec-developers group not found in the workspace — create it or fix roles.ts expectations.');
  process.exit(1);
}
const inGroup = (users[0].groups ?? []).some((g) => (g.display ?? '').toLowerCase() === 'eec-developers');
if (inGroup) {
  done('already in eec-developers');
} else {
  cli([
    'groups', 'patch', String(group.id), '--json',
    JSON.stringify({
      Operations: [{ op: 'add', path: 'members', value: [{ value: String(users[0].id) }] }],
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    }),
  ]);
  done('added to eec-developers');
}
const isAdminGroup = (users[0].groups ?? []).some((g) => ['admins', 'eec-admins'].includes((g.display ?? '').toLowerCase()));
if (isAdminGroup) {
  console.log(`  ! note: ${EMAIL} is in a workspace admin group, so the console will resolve their role as admin, not developer (see docs/beta-provisioning.md).`);
}

console.log(`\nDone. ${NAME} can sign in at ${APP} — verify their machine with scripts/verify-beta-machine.mjs.`);
