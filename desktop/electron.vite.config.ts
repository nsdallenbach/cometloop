import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Build channel (DAT-290): `COMETLOOP_CHANNEL=staging` bakes a tester build
// that preselects the Staging environment, installs beside the production
// app (own appId / productName / userData) and never self-updates from the
// production release feed. Unset → 'production'.
const channel = process.env.COMETLOOP_CHANNEL === 'staging' ? 'staging' : 'production';
const define = { __COMETLOOP_CHANNEL__: JSON.stringify(channel) };

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
