#!/usr/bin/env node
// The local backend: the whole Cometloop console on this machine, no cloud.
//
//   npm run local            # install if needed, build if stale, serve :8000
//   npm run local -- --seed  # same, seeding the demo portfolio into an empty DB
//   npm run local -- --reset # delete the local database and files first
//
// Data lives in ./data/local (git-ignored): `db/` is an embedded Postgres 17
// (PGlite) with the same schema, RLS and migrations as the hosted console;
// `files/` holds uploads. Back it up by copying the folder while it's stopped.
//
// Only Node 22+ is required — no Postgres, Docker or Databricks. Model calls
// use their deterministic fallbacks unless ANTHROPIC_API_KEY is set (or a
// provider is configured under Admin → Model providers).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dataDir = path.resolve(process.env.COMETLOOP_DATA_DIR ?? path.join(root, 'data', 'local'));
const port = process.env.PORT ?? '8000';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Node ${process.versions.node} is too old — the local backend needs Node 22 or newer (https://nodejs.org).`);
  process.exit(1);
}

function sh(cmd, cmdArgs, cwd = root) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** Newest mtime under a directory (skips node_modules / dist). */
function newest(dir) {
  let max = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = path.join(dir, entry.name);
    max = Math.max(max, entry.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return max;
}

if (!fs.existsSync(path.join(root, 'node_modules', '@electric-sql', 'pglite'))) {
  console.log('[local] Installing dependencies (first run)…');
  sh(npm, ['ci', '--no-audit', '--no-fund']);
}
if (!fs.existsSync(path.join(root, 'mcp', 'node_modules'))) {
  sh(npm, ['ci', '--no-audit', '--no-fund'], path.join(root, 'mcp'));
}

const serverOut = path.join(root, 'dist', 'server.js');
const clientOut = path.join(root, 'client', 'dist', 'index.html');
const built = fs.existsSync(serverOut) && fs.existsSync(clientOut);
const stale =
  built &&
  Math.max(newest(path.join(root, 'server')), newest(path.join(root, 'client', 'src')), newest(path.join(root, 'shared'))) >
    Math.min(fs.statSync(serverOut).mtimeMs, fs.statSync(clientOut).mtimeMs);
if (!built || stale || args.has('--build')) {
  console.log(`[local] Building the console (${built ? 'sources changed' : 'first run'})…`);
  sh(npm, ['run', 'build']);
}

if (args.has('--reset')) {
  console.log(`[local] Deleting ${dataDir}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });

// Who you are on this machine. No sign-in provider runs locally, so the
// server's dev identity stands in (server/identity.ts devVerifier) — safe
// only because the port is bound to loopback below.
const gitEmail = spawnSync('git', ['config', 'user.email'], { cwd: root, encoding: 'utf8' }).stdout?.trim();
const email = process.env.COMETLOOP_USER_EMAIL || process.env.DEV_IDENTITY_EMAIL || gitEmail || 'me@localhost';
const gitName = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' }).stdout?.trim();

const env = {
  ...process.env,
  NODE_ENV: 'production',
  DATABASE_URL: `pglite:${path.join(dataDir, 'db')}`,
  FILES_DIR: path.join(dataDir, 'files'),
  PORT: port,
  // Loopback only: no proxy in front means whoever reaches the port is admin.
  HOST: '127.0.0.1',
  DEV_IDENTITY_EMAIL: email,
  DEV_IDENTITY_NAME: process.env.DEV_IDENTITY_NAME || gitName || email,
  ...(args.has('--seed') ? { EEC_SEED_DEMO: '1' } : {}),
};
for (const k of Object.keys(env)) if (k === 'DATABASE_URL_UNPOOLED' || k.startsWith('NEON_AUTH_')) delete env[k];

console.log(`[local] Data in ${dataDir}`);
console.log(`[local] Signed in as ${email} (set COMETLOOP_USER_EMAIL to change)`);
console.log(`[local] Console → http://localhost:${port}`);
console.log('[local] Claude Code: the repo .mcp.json "delivery-console" server talks to this backend with no extra setup.');
const child = spawn(process.execPath, [serverOut], { cwd: root, env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));
