# Delivery Console — desktop client

Phase 1 scaffold of the local client
([docs/local-client-architecture.md](../docs/local-client-architecture.md)):
an Electron shell with the console's design tokens, a zod-validated config, a
Databricks credential manager with **native browser OAuth** (authorization
code + PKCE, refresh token encrypted via `safeStorage`, silent renewal,
≤10 min access-token cache, 401 → refresh-once), and a typed IPC bridge. The
My Tickets view proves the loop: it lists engagements from the console API
authenticated as *you*.

## Run it

```bash
cd desktop
npm install
npm run dev          # electron-vite dev with HMR
```

Prereqs: Node 20+ and network access to the console. First launch: click
**Sign in to Databricks** — your browser opens the workspace sign-in, the app
catches the redirect, and you stay signed in across restarts. (No Databricks
CLI needed; if one is installed and logged in it is used silently as a
fallback.)

Config lives at `%APPDATA%/delivery-console-desktop/config.json` (written on
first run) and can be overridden per-run with env vars: `APP_URL`,
`DATABRICKS_HOST`, `DATABRICKS_PROFILE`, `DATABRICKS_CLI`, `AGENT_NAME`.
`DATABRICKS_TOKEN` skips the CLI entirely (dev mode; never persisted).

## Checks

```bash
npm run typecheck    # this package is excluded from the root TS/lint projects
npm run build        # electron-vite production build
npm run dist:win     # NSIS installer + portable exe into release/
```

## Agents (DAT-245)

The **Agents** page manages the coding agents on this machine: per agent
type (Claude Code, Codex) it shows install status/version, an instance
count (0–4) and an auto-start toggle — all persisted in config.json.
Instances run concurrently, each with its own fleet identity
(`<agentName>-<kind>-<n>`), claim loop, live feed and Start/Stop/Kill,
tabbed in the UI. Default config auto-starts 1× Claude Code with the app
so the queue never stalls. Launching a new build kills the previous app
instance (PID-file replace; DAT-234 orphan recovery covers a run caught
in the crossfire).

## The embedded runner

**My Tickets** polls the queue as you (server-scoped: shared pool + tasks
routed to you). **▶ Run** on a queued ticket claims it on this machine;
**Runs** shows the live feed (harness output, tool calls, lifecycle) with
Start/Stop runner (long-poll loop, like a devbox) and Kill run. Harness
processes are spawned hidden (`windowsHide`, piped stdio) — no console
windows. The lifecycle is the devbox runner's: claim → workdir under
`~/agent-work` → vended git credential → harness (`claude` or `codex`, set
`harness` in config.json or `HARNESS` env) → heartbeats → `RESULT.md` →
complete. Not ported yet, deliberately: project provisioning (base
image/library installs) and service-mode harnesses.

## Layout

```
src/main/       config.ts (zod schema) · credentials.ts (token manager) · index.ts (window + IPC)
src/preload/    contextBridge surface (typed in renderer env.d.ts)
src/renderer/   React shell: title bar, nav, views (inline styles + shared/design tokens)
```

Security posture: contextIsolation on, nodeIntegration off, renderer never
sees tokens or the network — everything crosses the typed IPC boundary in
`src/preload/index.ts`. Harness processes (later phases) spawn with piped
stdio and `windowsHide` — no console windows, output renders in-app.
