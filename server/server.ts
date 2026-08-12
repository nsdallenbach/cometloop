import { createApp, files, lakebase, server, serving } from '@databricks/appkit';
import { setupApiRoutes } from './routes/api';

createApp({
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
}).catch(console.error);
