// Build-time constants injected by electron.vite.config.ts `define` — the
// same values reach the main process and the renderer.

/** Which build this is: 'production' (default) or 'staging' (tester builds). */
declare const __COMETLOOP_CHANNEL__: 'production' | 'staging';
