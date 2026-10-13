import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Build channel (DAT-290): `COMETLOOP_CHANNEL=staging` bakes a tester build
// that preselects the Staging environment, installs beside the production
// app (own appId / productName / userData) and never self-updates from the
// production release feed. Unset → 'production'.
const channel = process.env.COMETLOOP_CHANNEL === 'staging' ? 'staging' : 'production';
// Where a production build signs in. Our release builds set these from the
// repo's variables (desktop-release.yml); a build from a clean checkout points
// at the public console and signs in there (consoleAuth 'none'). Set
// COMETLOOP_DATABRICKS_HOST when the production console is a Databricks App:
// the desktop then authenticates with a workspace OAuth token instead.
const productionConsoleUrl = process.env.COMETLOOP_PRODUCTION_CONSOLE_URL || 'https://app.cometloop.ai';
const stagingConsoleUrl = process.env.COMETLOOP_STAGING_CONSOLE_URL || 'https://staging.cometloop.ai';
const databricksHost = process.env.COMETLOOP_DATABRICKS_HOST || '';
const define = {
  __COMETLOOP_CHANNEL__: JSON.stringify(channel),
  __COMETLOOP_PRODUCTION_CONSOLE_URL__: JSON.stringify(productionConsoleUrl),
  __COMETLOOP_STAGING_CONSOLE_URL__: JSON.stringify(stagingConsoleUrl),
  __COMETLOOP_DATABRICKS_HOST__: JSON.stringify(databricksHost),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    define,
    server: {
      // shared/ design tokens live outside the renderer root
      fs: { allow: ['..', '../..'] },
    },
  },
});
