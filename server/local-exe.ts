import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setPgliteAssets } from './portable/pglite-db';

/**
 * Entrypoint of the single-file executable (`scripts/build-local-exe.mjs`,
 * released as `cometloop-local-<os>` on GitHub). Double-click → the whole
 * console runs on this computer and the browser opens on it.
 *
 * - Data: a per-user folder (`%LOCALAPPDATA%\Cometloop`, `~/Library/Application
 *   Support/Cometloop`, `~/.local/share/cometloop`), or `COMETLOOP_DATA_DIR`.
 *   `db/` is embedded Postgres, `files/` uploads, `runtime/<build>/client`
 *   the web UI unpacked from the executable on first run of each build.
 * - Second launch while one is running: just opens the browser.
 * - Flags: `--port <n>` (default 8000), `--seed` (demo portfolio into an
 *   empty database), `--no-open`.
 *
 * Same server as `npm run local`: the portable runtime on `pglite:`.
 */

const BUILD_ID = process.env.COMETLOOP_BUILD_ID ?? 'dev';
const LOG = '[cometloop]';
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function dataRoot(): string {
  if (process.env.COMETLOOP_DATA_DIR) return path.resolve(process.env.COMETLOOP_DATA_DIR);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Cometloop');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cometloop');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'cometloop');
}

interface Sea {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
  getAssetKeys?(): string[];
}

function loadSea(): Sea | null {
  try {
    const sea = createRequire(process.execPath)('node:sea') as Sea;
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

/** The web UI and PGlite's runtime files, from the executable or from the repo. */
async function prepareAssets(root: string): Promise<string> {
  const sea = loadSea();
  if (!sea) {
    // `tsx server/local-exe.ts` from a checkout: everything is on disk already.
    return path.resolve('client/dist');
  }
  const manifest = JSON.parse(Buffer.from(sea.getAsset('manifest.json')).toString('utf8')) as { client: string[] };
  const clientDir = path.join(root, 'runtime', BUILD_ID, 'client');
  if (!fs.existsSync(path.join(clientDir, '.complete'))) {
    console.log(`${LOG} Unpacking the console (first run of this build)…`);
    for (const rel of manifest.client) {
      const dest = path.join(clientDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(sea.getAsset(`client/${rel}`)));
    }
    fs.writeFileSync(path.join(clientDir, '.complete'), BUILD_ID);
    // Older builds' UI is dead weight.
    for (const old of fs.readdirSync(path.join(root, 'runtime'))) {
      if (old !== BUILD_ID) fs.rmSync(path.join(root, 'runtime', old), { recursive: true, force: true });
    }
  }
  setPgliteAssets({
    pgliteWasmModule: await wasm.compile(sea.getAsset('pglite/pglite.wasm')),
    initdbWasmModule: await wasm.compile(sea.getAsset('pglite/initdb.wasm')),
    fsBundle: new Blob([sea.getAsset('pglite/pglite.data')]),
  });
  return clientDir;
}

// The server tsconfig types WebAssembly as a namespace only; the runtime has the global.
const wasm = (globalThis as unknown as { WebAssembly: { compile(bytes: ArrayBuffer): Promise<WebAssembly.Module> } }).WebAssembly;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { ok?: boolean };
    return Boolean(body.ok);
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  if (flag('--no-open')) return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No desktop (a server, WSL without a browser): the URL is printed anyway.
  }
}

async function run(): Promise<void> {
  const root = dataRoot();
  fs.mkdirSync(path.join(root, 'files'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });

  let port = Number(option('--port') ?? process.env.PORT ?? 8000);
  if (await alreadyRunning(port)) {
    console.log(`${LOG} Already running → http://localhost:${port}`);
    openBrowser(`http://localhost:${port}`);
    return;
  }
  while (!(await portFree(port))) port++;

  const clientDir = await prepareAssets(root);
  const user = os.userInfo().username || 'me';
  Object.assign(process.env, {
    NODE_ENV: 'production',
    DATABASE_URL: `pglite:${path.join(root, 'db')}`,
    FILES_DIR: path.join(root, 'files'),
    CLIENT_DIST: clientDir,
    PORT: String(port),
    // Loopback only: no sign-in provider runs locally, so whoever reaches
    // the port is the dev identity (admin). It must never face a network.
    HOST: '127.0.0.1',
    DEV_IDENTITY_EMAIL: process.env.COMETLOOP_USER_EMAIL || `${user}@localhost`,
    DEV_IDENTITY_NAME: process.env.COMETLOOP_USER_NAME || user,
    ...(flag('--seed') ? { EEC_SEED_DEMO: '1' } : {}),
  });
  for (const k of Object.keys(process.env)) if (k === 'DATABASE_URL_UNPOOLED' || k.startsWith('NEON_AUTH_')) delete process.env[k];

  console.log(`${LOG} Cometloop ${BUILD_ID} — data in ${root}`);
  const { startPortableServer } = await import('./main');
  await startPortableServer();
  const url = `http://localhost:${port}`;
  console.log(`${LOG} Ready → ${url}   (close this window to stop)`);
  openBrowser(url);
}

run().catch((err) => {
  console.error(`${LOG} failed to start:`, err);
  // Keep a double-clicked console window open long enough to read the error.
  setTimeout(() => process.exit(1), process.stdin.isTTY ? 60_000 : 0);
});
