---
name: parity-check
description: Pre-PR checklist for this repo — classify a change against the web console / desktop client split, name the docs that must move with it, and run the right validation for every package it touches. Use before opening any PR, and whenever a change touches shared/, desktop/, an API route the desktop calls, or a client idiom the desktop mirrors.
---

# Parity check — web console ↔ desktop client

One product ships as two shells (`client/`+`server/` and `desktop/`), joined
by `shared/`. This skill is the pre-PR pass that keeps them in step. Run it
on the diff you are about to push (`git diff origin/main --stat`).

## 1. Classify the change

Answer each; every "yes" adds work to the PR.

| Question | If yes |
|---|---|
| Touches `shared/api-client/`, `shared/harnesses/`, `shared/design/`, or a server route the desktop calls? (grep `/api/` in `shared/api-client/index.ts` for the list) | Update the desktop consumer in the same PR; run `cd desktop && npm run typecheck`. |
| Changes the agent work package, claim/heartbeat/complete contract, or deploy events? | Update `desktop/src/main/runner.ts` / `deploys.ts` and `devbox-runner/runner.mjs`; update `docs/devbox-integration.md`. |
| Changes a client idiom the desktop re-implements natively — tokens, fonts, markdown rendering, toasts, theme, card/row visual language? | *Shared by design*: implement on both, or file a `parity-gap` ticket; update the row in `docs/feature-parity-tracker.md` (status + date). Process: `docs/cross-platform-parity.md`. |
| Adds or changes a desktop surface (nav entry, view, config key, install/update behavior)? | `desktop/README.md`; `docs/beta-runbook.md` if testers follow it; bump `desktop/package.json` version only when cutting a release. |
| Changes a working agreement? | `docs/development-standards.md`, and after merge `node scripts/sync-standards.mjs` so the Standards tab matches. |
| Adds a server module, table, or flow? | `docs/architecture.md` module list / diagrams. |

Board, drawer, planning, palette, notifications and every other `client/`
screen are parity **by construction** (the desktop embeds the deployed web
app) — nothing to do beyond the web change. Agents, Identity, Terminal and
the deploy executor are desktop-exclusive by design.

## 2. Validate every package you touched

```bash
npm run typecheck && npm run lint && npm run build     # web console (what CI runs)
cd desktop && npm run typecheck && npm run build       # desktop (CI typechecks it on main)
node --check mcp/server.mjs                            # standalone JS, if touched
node --check devbox-runner/runner.mjs
npm run test:unit                                      # vitest, when server/client logic moved
```

`npm run typecheck` at the root already covers `shared/` for the server
project; the desktop typecheck covers `shared/` for the renderer/main side.

## 3. PR hygiene

- Branch or title carries the ticket key (`DAT-123-slug`).
- Fill the parity section of `.github/PULL_REQUEST_TEMPLATE.md` honestly —
  "no shared change" is a valid answer, an unticked section is not.
- Tracker or gap ticket rides in the same PR as the change.
- Do not merge your own PR; humans merge.
