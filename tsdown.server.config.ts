import path from 'node:path';
import { defineConfig } from 'tsdown';

export default defineConfig({
  // server.ts: the process entrypoint (Databricks App, or the portable runtime
  // when DATABASE_URL is set). main.ts / worker.ts: the container image's api
  // and worker commands (docs/platform-architecture.md, section 7).
  entry: ['server/server.ts', 'server/main.ts', 'server/worker.ts'],
  unbundle: true,
  // Bare specifiers and anything under node_modules stay external. Resolved
  // ids can be absolute paths; on Windows those start with a drive letter, so
  // the bare "^[^./]" test alone externalized every local module and emitted
  // an unrunnable dist (imports of ./routes/api.ts with no such file).
  external: (id) => (/^[^./]/.test(id) && !path.isAbsolute(id)) || /[\\/]node_modules[\\/]/.test(id),
  tsconfig: 'tsconfig.server.json',
  outExtensions: () => ({
    js: '.js',
  }),
});
