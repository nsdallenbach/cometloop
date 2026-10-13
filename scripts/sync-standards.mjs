#!/usr/bin/env node
// Push the repo's working-agreement docs into an engagement's Standards tab so
// the tab is a mirror of `main`, never a hand-edited fork. The Execution
// Console tab carries docs/development-standards.md followed by
// docs/beta-runbook.md (the beta convention from DAT-253); other engagements
// can pass their own file list.
//
//   node scripts/sync-standards.mjs                 # execution-console, default docs
//   node scripts/sync-standards.mjs --dry-run       # show what would change, write nothing
//   ENGAGEMENT=my-eng node scripts/sync-standards.mjs docs/a.md docs/b.md
//
// Auth mirrors mcp/server.mjs: DATABRICKS_TOKEN if set, else a workspace OAuth
// token minted by the Databricks CLI (`databricks auth login` first).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_URL = (process.env.APP_URL ?? '').replace(
  /\/$/,
  ''
);
const HOST = process.env.DATABRICKS_HOST ?? '';
if (!APP_URL || !HOST) {
  console.error('Set APP_URL (the console, e.g. https://<app>.databricksapps.com) and DATABRICKS_HOST (the workspace, for `databricks auth token`).');
  process.exit(1);
}
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';
const ENGAGEMENT = process.env.ENGAGEMENT ?? 'execution-console';
const DEFAULT_DOCS = ['docs/development-standards.md', 'docs/beta-runbook.md'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const docs = args.filter((a) => !a.startsWith('--'));
const files = docs.length ? docs : DEFAULT_DOCS;

function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  return JSON.parse(out).access_token;
}

async function api(method, route, body) {
  const resp = await fetch(`${APP_URL}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`${method} ${route} → ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

const content = files
  .map((f) => readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n').trimEnd())
  .join('\n\n');

const route = `/api/engagements/${encodeURIComponent(ENGAGEMENT)}/standards`;
const live = await api('GET', route);
const liveContent = (live.content ?? '').replace(/\r\n/g, '\n').trimEnd();

if (liveContent === content) {
  console.log(`${ENGAGEMENT}: Standards tab already matches ${files.join(' + ')} (${content.length} chars).`);
  process.exit(0);
}

const liveLines = liveContent.split('\n').length;
const nextLines = content.split('\n').length;
console.log(
  `${ENGAGEMENT}: Standards tab differs — live ${liveLines} lines (last saved by ${live.updated_by || 'unknown'} at ${live.updated_at || '?'}), repo ${nextLines} lines from ${files.join(' + ')}.`
);

if (dryRun) {
  console.log('Dry run: nothing written.');
  process.exit(0);
}

const saved = await api('PUT', route, { content });
console.log(
  `Updated ${ENGAGEMENT} Standards tab (${content.length} chars) as ${saved.updated_by} at ${saved.updated_at}.`
);
