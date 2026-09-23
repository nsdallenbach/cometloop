import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { setupApiRoutes } from './routes/api';
import { createPortableDb } from './portable/db';
import { localFiles } from './portable/files';
import { unconfiguredServing } from './portable/serving';
import { githubAppConfigured } from './routes/github-app';

/**
 * Portable api entrypoint (docs/platform-architecture.md, phase 0): the
 * control plane on plain Express + `pg`, no Databricks in the process.
 *
 * Selected by `server.ts` whenever `DATABASE_URL` is set; `node dist/main.js`
 * runs it directly (the Dockerfile's default command). It satisfies the
 * `AppKitServices` interface that `setupApiRoutes` takes:
 *
 * - `lakebase.query` → a `pg.Pool` on `DATABASE_URL` (SSL unless disabled),
 *                      tenant-scoped per query under row-level security
 *                      (phase 2, `server/db/`); `adminQuery` is the owner.
 * - `server.extend`  → the Express app, with AppKit's global JSON parser
 *                      mirrored so the UTF-8 recovery middleware splices in.
 * - `files(alias)`   → a directory per alias under `FILES_DIR`.
 * - `serving`        → a stub until phase 3's provider registry; every model
 *                      call takes its deterministic fallback.
 *
 * Every Databricks-only feature is off with one log line: workspace endpoint
 * listing (`DATABRICKS_HOST`), the planning-agent endpoint row
 * (`DATABRICKS_SERVING_ENDPOINT_NAME`), telemetry archiving
 * (`DATABRICKS_VOLUME_TELEMETRY`), and the GitHub App (`GITHUB_APP_*`).
 */

const LOG = '[main]';

function clientDist(): string | null {
  // dist/main.js runs from the repo root in both the container and `npm start`;
  // tsx runs server/main.ts from the same cwd.
  const candidates = [path.resolve(process.cwd(), 'client/dist'), path.resolve(import.meta.dirname, '../client/dist')];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * Frontend, the way AppKit's server plugin does it: Vite middleware with HMR
 * in development (`npm run dev`), the built `client/dist` otherwise. API and
 * health routes are registered first, so they win over the SPA fallback.
 */
async function serveClient(app: express.Application): Promise<void> {
  if (process.env.NODE_ENV === 'development' && process.env.VITE_DEV !== '0') {
    try {
      const { createServer } = await import('vite');
      const vite = await createServer({
        configFile: path.resolve(process.cwd(), 'client/vite.config.ts'),
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
      console.log(`${LOG} Serving client through Vite (HMR)`);
      return;
    } catch (err) {
      console.warn(`${LOG} Vite dev server unavailable, falling back to client/dist:`, (err as Error).message);
    }
  }
  const staticDir = clientDist();
  if (!staticDir) {
    console.warn(`${LOG} client/dist not found — API only (run \`npm run build:client\`)`);
    return;
  }
  app.use(express.static(staticDir, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/healthz')) return next();
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  console.log(`${LOG} Serving client from ${staticDir}`);
}

export async function startPortableServer(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the portable runtime');

  const db = createPortableDb(databaseUrl);
  console.log(`${LOG} Postgres via DATABASE_URL (${db.label}); Databricks token flow skipped`);

  const filesDir = path.resolve(process.env.FILES_DIR ?? 'data/files');
  console.log(`${LOG} Files on local disk under ${filesDir}`);

  const servingEndpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  console.log(
    servingEndpoint
      ? `${LOG} DATABRICKS_SERVING_ENDPOINT_NAME=${servingEndpoint} is ignored outside Databricks until the provider registry lands — model calls use their deterministic fallbacks`
      : `${LOG} No model provider configured — model calls use their deterministic fallbacks`
  );
  if (!process.env.DATABRICKS_HOST) {
    console.log(`${LOG} DATABRICKS_HOST not set — workspace endpoint listing off; /api/agents/models serves the static catalog`);
  }
  if (!githubAppConfigured()) {
    console.log(`${LOG} GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not set — repo sync, PR linking and git-credential vending are off`);
  }

  const app = express();
  app.disable('x-powered-by');
  // Mirror AppKit's server plugin: one JSON parser for json content types,
  // 1mb, named `jsonParser` so installUtf8BodyRecovery can splice ahead of it.
  app.use(
    express.json({
      limit: '1mb',
      type: (req) => (req.headers['content-type'] ?? '').includes('json'),
    })
  );

  await setupApiRoutes({
    // query is tenant-scoped (RLS as cometloop_app); adminQuery is the owner
    // connection the boot migration and the tenant directory need.
    lakebase: { query: db.query, adminQuery: db.adminQuery, tenantIsolation: true },
    server: { extend: (fn) => fn(app) },
    files: (alias) => localFiles(path.join(filesDir, alias)),
    serving: unconfiguredServing(
      servingEndpoint ? 'model serving is not reachable outside Databricks yet' : 'no provider set'
    ),
  });

  await serveClient(app);

  const port = Number(process.env.PORT) || Number(process.env.DATABRICKS_APP_PORT) || 8000;
  const host = process.env.HOST ?? '0.0.0.0';
  const server = app.listen(port, host, () => {
    console.log(`${LOG} Listening on http://${host}:${port}`);
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${LOG} ${signal} received — shutting down`);
    server.close(() => {
      db.close()
        .catch((err) => console.warn(`${LOG} pool close failed:`, (err as Error).message))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// `node dist/main.js` / `tsx server/main.ts`: run directly. When imported by
// server.ts the caller decides.
const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const invokedDirectly = process.argv[1] !== undefined && norm(process.argv[1]) === norm(import.meta.filename);
if (invokedDirectly) {
  startPortableServer().catch((err) => {
    console.error(`${LOG} failed to start:`, err);
    process.exit(1);
  });
}
