#!/usr/bin/env node
// Build the single-file local executable: the console, its web UI and an
// embedded Postgres in one binary that runs with nothing installed.
//
//   node scripts/build-local-exe.mjs          # → release-local/cometloop-local-<os>-<arch>[.exe]
//
// Needs Node 25.5+ (`node --build-sea`); the binary embeds the Node that
// builds it. Steps: build client/dist → esbuild server/local-exe.ts into one
// CommonJS file → collect client/dist and PGlite's wasm/data as SEA assets →
// `node --build-sea` → ad-hoc codesign on macOS.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release-local');
const work = path.join(out, 'work');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  console.error(`Node ${process.versions.node}: building the executable needs Node 25.5+ (node --build-sea).`);
  process.exit(1);
}

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const sha = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
})();
const buildId = process.env.COMETLOOP_BUILD_ID || `${version}-${sha}`;
const arch = process.arch;
const osName = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] ?? process.platform;
const exeName = `cometloop-local-${osName}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

if (!process.argv.includes('--skip-client')) {
  console.log('[exe] Building the web UI…');
  execFileSync(npm, ['run', 'build:client'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

console.log('[exe] Bundling the server…');
const bundle = path.join(work, 'cometloop.cjs');
await build({
  entryPoints: [path.join(root, 'server/local-exe.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  tsconfig: path.join(root, 'tsconfig.server.json'),
  // Never reached on this runtime: Vite (dev only), AppKit (Databricks
  // runtime only), pg's optional native binding.
  external: ['vite', '@databricks/appkit', 'pg-native'],
  define: {
    'process.env.COMETLOOP_BUILD_ID': JSON.stringify(buildId),
    // main.ts reads these; in one bundled file they mean nothing. An empty
    // filename also keeps main.ts's "invoked directly" check false.
    'import.meta.dirname': '""',
    'import.meta.filename': '""',
    // Bundled libraries (PGlite) call createRequire(import.meta.url): give
    // them the executable's own path as a real file URL.
    'import.meta.url': '__cometloop_meta_url',
  },
  banner: { js: "const __cometloop_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'warning',
});

console.log('[exe] Collecting assets…');
const clientDist = path.join(root, 'client', 'dist');
const client = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else client.push(path.relative(clientDist, p).split(path.sep).join('/'));
  }
};
walk(clientDist);
const pgliteDist = path.join(root, 'node_modules', '@electric-sql', 'pglite', 'dist');
const manifestPath = path.join(work, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify({ buildId, client }));
const assets = {
  'manifest.json': manifestPath,
  'pglite/pglite.wasm': path.join(pgliteDist, 'pglite.wasm'),
  'pglite/initdb.wasm': path.join(pgliteDist, 'initdb.wasm'),
  'pglite/pglite.data': path.join(pgliteDist, 'pglite.data'),
  ...Object.fromEntries(client.map((rel) => [`client/${rel}`, path.join(clientDist, rel)])),
};

const exe = path.join(out, exeName);
fs.rmSync(exe, { force: true });
const seaConfig = path.join(work, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: exe, disableExperimentalSEAWarning: true, useCodeCache: false, assets }, null, 2),
);

console.log(`[exe] Building ${exeName}…`);
execFileSync(process.execPath, ['--build-sea', seaConfig], { cwd: work, stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' });
if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);

const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`[exe] ${path.relative(root, exe)} (${mb} MB, build ${buildId})`);
