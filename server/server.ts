import { setupApiRoutes } from './routes/api';

/**
 * Process entrypoint. Two runtimes share every route module:
 *
 * - `DATABASE_URL` set → the portable runtime (`main.ts`): plain Express +
 *   `pg`, no Databricks token or OAuth step, AppKit never loaded.
 * - otherwise → the Databricks App as before: AppKit's `createApp` with the
 *   files / lakebase / server / serving plugins.
 */
async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    const { startPortableServer } = await import('./main');
    await startPortableServer();
    return;
  }

  const { createApp, files, lakebase, server, serving } = await import('@databricks/appkit');
  await createApp({
    plugins: [
      files({
        volumes: {
          // SOW uploads are performed server-side; allow writes on this volume.
          files: { policy: files.policy.allowAll(), maxUploadSize: 50_000_000 },
          // Agent tool-call logs, archived server-side per run. Optional so the
          // app still boots on deployments without the agent_telemetry volume.
          ...(process.env.DATABRICKS_VOLUME_TELEMETRY
            ? { telemetry: { policy: files.policy.allowAll(), maxUploadSize: 50_000_000 } }
            : {}),
        },
      }),
      lakebase(),
      server(),
      serving(),
    ],
    async onPluginsReady(appkit) {
      await setupApiRoutes({
        lakebase: appkit.lakebase,
        server: appkit.server,
        files: appkit.files,
        serving: appkit.serving,
      });
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
