#!/usr/bin/env node
// DAT-252: per-tester machine prereq check. The tester runs this on their own
// laptop and pastes the output as provisioning evidence.
//
//   node scripts/verify-beta-machine.mjs
//
// Verifies, in order: git on PATH, Claude Code installed (+ a best-effort
// sign-in heuristic), Codex (optional, informational), Databricks CLI auth
// against the workspace, console reachability as the signed-in identity, and
// that this identity is on the engagement roster with a matching email (email
// is what routes work — DAT-227). Exits non-zero on any FAIL.
//
// Env (same conventions as devbox-runner/runner.mjs):
//   APP_URL           console base URL
//   DATABRICKS_HOST   workspace URL (for CLI token minting)
//   DATABRICKS_TOKEN  pre-minted OAuth token (skips the CLI)
//   DATABRICKS_CLI    databricks binary path (default: "databricks")
//   ENGAGEMENT        roster to check against (default: execution-console)
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

const APP = (process.env.APP_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const ENGAGEMENT = process.env.ENGAGEMENT ?? 'execution-console';

const results = [];
const record = (status, check, detail) => {
  results.push({ status, check, detail });
  console.log(`  ${status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·'} [${status}] ${check}${detail ? ` — ${detail}` : ''}`);
};

function version(bin, args = ['--version']) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000 }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

console.log(`Beta machine check — host ${os.hostname()}, ${os.platform()}\n`);

// 1. git
const git = version('git');
record(git ? 'PASS' : 'FAIL', 'git on PATH', git ?? 'not found — install git and re-run');

// 2. Claude Code + sign-in heuristic
const claude = version('claude');
record(claude ? 'PASS' : 'FAIL', 'Claude Code installed', claude ?? 'not found — install Claude Code (their own Anthropic seat)');
if (claude) {
  const hints = [path.join(os.homedir(), '.claude', '.credentials.json'), path.join(os.homedir(), '.claude.json')];
  const signedIn = hints.some((p) => existsSync(p));
  record(signedIn ? 'PASS' : 'INFO', 'Claude Code sign-in (heuristic)', signedIn ? 'credentials present' : 'no local credentials found — launch `claude` once and sign in');
}

// 3. Codex (optional this beta)
const codex = version('codex');
record('INFO', 'Codex CLI (optional)', codex ?? 'not installed — fine for this beta');

// 4. Databricks CLI + workspace auth
const dbx = version(CLI);
record(dbx ? 'PASS' : 'FAIL', 'Databricks CLI installed', dbx ?? 'not found');
let tok = process.env.DATABRICKS_TOKEN ?? null;
if (dbx && !tok) {
  try {
    tok = JSON.parse(execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8', timeout: 60_000 })).access_token;
  } catch (err) {
    record('FAIL', 'workspace OAuth token', `could not mint a token for ${HOST} — run \`databricks auth login --host ${HOST}\` (${String(err).slice(0, 120)})`);
  }
}
if (tok) record('PASS', 'workspace OAuth token', `minted for ${HOST}`);

// 5 + 6. console identity and roster
if (tok) {
  try {
    const headers = { Authorization: `Bearer ${tok}` };
    const me = await (await fetch(`${APP}/api/me`, { headers })).json();
    if (!me.email) throw new Error('no identity in /api/me response');
    record('PASS', 'console reachable as signed-in identity', `${me.email} (role ${me.role})`);
    const onEngagement = me.role === 'admin' || (me.memberOf ?? []).includes(ENGAGEMENT) || (me.leadOf ?? []).includes(ENGAGEMENT);
    record(onEngagement ? 'PASS' : 'FAIL', `access to ${ENGAGEMENT}`, onEngagement ? undefined : 'not a member — ask the lead to run provision-beta-tester.mjs');
    const detail = await (await fetch(`${APP}/api/engagements/${encodeURIComponent(ENGAGEMENT)}/detail`, { headers })).json();
    const rosterRow = (detail.team ?? []).find((t) => (t.email ?? '').toLowerCase() === me.email.toLowerCase());
    record(
      rosterRow ? 'PASS' : 'FAIL',
      'roster row with this email (routing)',
      rosterRow ? `${rosterRow.name} <${rosterRow.email}>` : `no app.team_members row carries ${me.email} — routed tickets will never reach this identity`,
    );
  } catch (err) {
    record('FAIL', 'console API', String(err).slice(0, 200));
  }
}

const failed = results.filter((r) => r.status === 'FAIL');
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`} — ${results.length} run`);
process.exit(failed.length === 0 ? 0 : 1);
