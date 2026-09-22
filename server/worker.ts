/**
 * Worker entrypoint placeholder (docs/platform-architecture.md, phase 4).
 *
 * The background loops — repo polling, review-SLA escalation, stale nudges,
 * fleet watch, the planning-review sweep — still run as `setInterval`s inside
 * the api process (`routes/api.ts`, end of `setupApiRoutes`). Phase 4 moves
 * them behind pg-boss and this file becomes the consumer. Until then the
 * image's second command exists so the compose file and the container-app
 * definitions can name it; it logs and exits cleanly.
 */
console.log('[worker] no background jobs are split out yet — the api process runs them (platform-architecture phase 4)');
process.exit(0);
