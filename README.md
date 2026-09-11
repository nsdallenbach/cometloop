# Delivery Console

Datavail's delivery execution console: portfolio, board, roadmap, planning
agent, agent runners and the delivery automation that closes the loop from
ticket → branch → PR → deploy → Done. One product in two shells:

- **Web console** (`client/` + `server/`) — a [Databricks App](https://www.databricks.com/devhub/docs/appkit/v0/)
  built on AppKit (Express + React/Vite) behind the workspace OAuth proxy.
  Deployed by CI on every merge to `main`.
- **Desktop client** (`desktop/`) — an Electron app that embeds the deployed
  web console and adds the surfaces that must run on a developer's own
  machine: coding-agent runners, identity, local deploys, a terminal, token
  metrics. Released by tag; installed builds self-update.

Start with [docs/architecture.md](docs/architecture.md) for how it fits
together and [docs/development-standards.md](docs/development-standards.md)
for the working agreement before changing anything.

## Repository map

```
client/           React SPA (Vite) — board, drawer, roadmap, analytics, agents map, standards
server/           Express API — one route module per domain under server/routes/, wired in api.ts
shared/           Imported by both shells: api-client/ (typed console client), design/ (tokens), harnesses/ (agent adapters)
desktop/          Electron client — own package.json, typecheck and release pipeline
mcp/              MCP server exposing the console API to Claude Code / agent runs (stdio)
devbox-runner/    Headless reference runner for devbox VMs (wait → claim → harness → complete)
scripts/          Ops scripts: dev-role migrations, Standards-tab sync, beta seeding, validators
tests/            Vitest unit tests for client libs + the Playwright smoke test
docs/             Architecture, standards, runner contract, runbooks, incidents, prompts
.github/          deploy.yml (CI gate + bundle deploy), desktop-release.yml (tag → installers)
databricks.yml    Bundle: app, UC volumes, Lakebase + serving-endpoint resources
app.yaml          App runtime: start command and resource-injected env
```

## Prerequisites

- Node.js v22+ and npm
- Databricks CLI (v1+) authenticated against the workspace: `databricks auth login --host <workspace>`
- **Can Use** on the deployed app and access to the `sandbox.engagement_console` schema (local dev shares the workspace resources — there is no separate dev Lakebase branch)

## Local development — web console

```bash
npm install
cp .env.example .env     # then fill it in, see below
npm run dev              # http://localhost:8000 — API + Vite HMR in one process
```

`.env` points the local process at the same workspace resources the deployed
app uses. Every value is derivable:

| Variable | Where it comes from |
|---|---|
| `DATABRICKS_HOST` | your workspace URL (the `targets.default.workspace.host` in `databricks.yml`) |
| `DATABRICKS_VOLUME_FILES`, `DATABRICKS_VOLUME_TELEMETRY` | the two volume paths in `databricks.yml` (`/Volumes/sandbox/engagement_console/{sow_docs,agent_telemetry}`) |
| `DATABRICKS_SERVING_ENDPOINT_NAME` | `serving_endpoint_name` in `databricks.yml` |
| `LAKEBASE_ENDPOINT` | `projects/engagement-console/branches/production/endpoints/primary` |
| `PGHOST` | `databricks postgres get-endpoint <LAKEBASE_ENDPOINT> -o json` → `.status.hosts.host` |
| `PGDATABASE` | `databricks_postgres` (`databricks postgres list-databases projects/engagement-console/branches/production`) |
| `PGPORT`, `PGSSLMODE` | `5432`, `require` |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | optional — the App id is in `app.yaml`, the PEM in secret scope `delivery-console`. Without them repo sync, PR linking and git-credential vending are off locally; everything else works. |

Authentication is the CLI's: AppKit mints workspace and Lakebase credentials
from your `DEFAULT` profile. Without the Apps proxy in front, the local
process treats you as **admin** (`server/routes/roles.ts`).

Boot logs one expected line: `schema statement failed … must be owner of
table` — developer-owned tables cannot take the app's boot `ALTER`s
(migrations for those live in `scripts/dev-migrate.cjs`; see the standards).

## Local development — desktop client

```bash
cd desktop
npm install
APP_URL=http://localhost:8000 npm run dev    # or omit APP_URL to point at the deployed console
```

`desktop/README.md` covers sign-in, config.json, the Agents / Deploys /
Identity surfaces, and the release + auto-update pipeline.

## Validation

What CI runs on every push to `main` — run it from a clean state before
pushing:

```bash
npm run typecheck && npm run lint && npm run build      # web console
cd desktop && npm run typecheck                          # desktop (also a CI job)
```

Plus, as needed:

```bash
npm run test:unit          # vitest (server/routes/*.test.ts, tests/*.test.ts)
npm run test:smoke         # Playwright smoke against a local dev server
npm run format             # prettier --check
node --check mcp/server.mjs devbox-runner/runner.mjs    # standalone JS packages
```

Run `/parity-check` in Claude Code before opening a PR — it classifies the
change against the web/desktop split and names the docs to update
([docs/cross-platform-parity.md](docs/cross-platform-parity.md)).

## Build and deploy

```bash
npm run build              # dist/server.js + client/dist/
npm start                  # serve the production build locally
```

Deploys are CI-driven: `.github/workflows/deploy.yml` runs the gate, then
`databricks bundle deploy`, the dev-role migrations, and `databricks bundle
run app`. A manual deploy is the same two bundle commands with an
authenticated CLI. Each deploy restarts the app (~1 minute of 502s).

Desktop releases: bump `desktop/package.json` version, push a `v<version>`
tag; `.github/workflows/desktop-release.yml` builds the Windows installer +
portable exe, macOS dmg and Linux AppImage onto a GitHub Release, which
installed builds pick up automatically.

## Agent runners

Tickets are handed to coding agents from the board: queue a card for the
shared pool, or assign it to one developer so their desktop client's runner
picks it up. Runners long-poll `GET /api/agent/work/wait`, claim atomically,
receive the work package (ticket, comments, rendered prompt, repo
coordinates, context files), post progress and complete with `done` or
`failed`. Humans merge.

- [docs/devbox-integration.md](docs/devbox-integration.md) — the HTTP contract: authentication, endpoints, a minimal runner loop
- [devbox-runner/README.md](devbox-runner/README.md) — the headless reference runner and the harness adapters (Claude Code, Codex, generic, Omnigent)
- [desktop/README.md](desktop/README.md) — the embedded desktop runner, agent instances, identity and local deploys
- [mcp/README.md](mcp/README.md) — the MCP server agents use to read the board and drive their own lifecycle
- [docs/omnigent-runner-architecture.md](docs/omnigent-runner-architecture.md) — running a hosted agent as a runner

## Documentation index

| Doc | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System overview, runtime components, server modules, the agent platform, delivery automation |
| [docs/development-standards.md](docs/development-standards.md) | The working agreement (also mirrored into the app's Standards tab) |
| [docs/cross-platform-parity.md](docs/cross-platform-parity.md) · [docs/feature-parity-tracker.md](docs/feature-parity-tracker.md) | Keeping web and desktop in step: parity classes, PR flow, tracker |
| [docs/delivery-tool-plan.md](docs/delivery-tool-plan.md) · [docs/local-client-architecture.md](docs/local-client-architecture.md) | Why runners moved to developers' machines, and the desktop build plan with status |
| [docs/beta-runbook.md](docs/beta-runbook.md) | Beta tester runbook: install, scripted scenarios, feedback intake |
| [docs/agent-coordination.md](docs/agent-coordination.md) · [docs/coordination-drills.md](docs/coordination-drills.md) | Inter-agent protocol over Postgres and the drills that verified it |
| [docs/llm-fallbacks.md](docs/llm-fallbacks.md) · [docs/llm-hours-estimation.md](docs/llm-hours-estimation.md) | Per-flow model fallbacks; how hour estimates are produced |
| [docs/github-app-setup.md](docs/github-app-setup.md) · [docs/mcp-databricks-registration.md](docs/mcp-databricks-registration.md) | GitHub App provisioning; registering the console's MCP endpoint with model serving |
| [docs/incidents/](docs/incidents) · [docs/prompts/](docs/prompts) | Incident write-ups; the PR reviewer prompts |
