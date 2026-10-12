// Build-time constants injected by electron.vite.config.ts `define` — the
// same values reach the main process and the renderer.

/** Which build this is: 'production' (default) or 'staging' (tester builds). */
declare const __COMETLOOP_CHANNEL__: 'production' | 'staging';
/** The production console URL (COMETLOOP_PRODUCTION_CONSOLE_URL at build time). */
declare const __COMETLOOP_PRODUCTION_CONSOLE_URL__: string;
/** The staging console URL (COMETLOOP_STAGING_CONSOLE_URL at build time). */
declare const __COMETLOOP_STAGING_CONSOLE_URL__: string;
/** Workspace host when the production console is a Databricks App; '' otherwise. */
declare const __COMETLOOP_DATABRICKS_HOST__: string;
/** The production console URL (COMETLOOP_PRODUCTION_CONSOLE_URL at build time). */
declare const __COMETLOOP_PRODUCTION_CONSOLE_URL__: string;
/** The staging console URL (COMETLOOP_STAGING_CONSOLE_URL at build time). */
declare const __COMETLOOP_STAGING_CONSOLE_URL__: string;
/** Workspace host when the production console is a Databricks App; '' otherwise. */
declare const __COMETLOOP_DATABRICKS_HOST__: string;
