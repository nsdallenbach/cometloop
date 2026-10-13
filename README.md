<p align="center">
  <img src="client/public/favicon.svg" width="96" alt="Cometloop">
</p>

<h1 align="center">Cometloop</h1>

<p align="center"><strong>The delivery board where AI coding agents ship the tickets and people decide what merges.</strong></p>

<p align="center">
Cometloop is an open source delivery execution console. Tickets go in; a planning agent fills them in; coding agents running on your developers' machines pick them up, open pull requests and see them through review and deploy. The board closes the loop from ticket to branch to PR to deploy to Done, and "Done" is only reached by a merged, deployed change.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/nsdallenbach/cometloop/actions/workflows/ci.yml"><img src="https://github.com/nsdallenbach/cometloop/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/nsdallenbach/cometloop/releases"><img src="https://img.shields.io/github/v/release/nsdallenbach/cometloop?label=desktop" alt="Desktop release"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node 22+">
</p>

<p align="center">
  <a href="https://cometloop.ai">Website</a> ·
  <a href="https://cometloop.ai/docs">Docs</a> ·
  <a href="https://github.com/nsdallenbach/cometloop/releases">Desktop releases</a>
</p>

## What is Cometloop

- A delivery board where AI coding agents plan, build and ship tickets. Humans set the direction, review the pull requests and decide what merges.
- Agents run on developers' own machines through the desktop app, with Claude Code and Codex today and Gemini CLI, Copilot and Cursor tiles on the way; the headless runner also drives any prompt-taking CLI.
- An MCP server exposes the board, tickets, context files and the agent queue, so any MCP client can read the board and drive its own work.
- One product in two shells: the web console (Express + React) and an Electron desktop client that embeds it and adds the surfaces that must run locally (runners, identity, deploys, a terminal).
- Runs as a Databricks App, as a container on AWS or any other host, or on plain Postgres with Docker.

## Quickstart

Three ways to get a console running. Each needs Node.js 22+; the first also needs Docker, the second a Databricks workspace.

### Run locally with Docker

Plain Postgres, no Databricks. Databricks features are off and, without a model key, model calls take their deterministic fallbacks ([docs/llm-fallbacks.md](docs/llm-fallbacks.md)).

```bash
git clone https://github.com/nsdallenbach/cometloop.git && cd cometloop
export DEV_IDENTITY_EMAIL=you@example.com   # local sign-in: you, with the admin role (never on a deployed instance)
export ANTHROPIC_API_KEY=sk-ant-...         # optional: a real model instead of the fallbacks
docker compose up --build                   # Postgres 17 + the console on http://localhost:8000
```

`docker-compose.yml` passes those two variables through to the `api` service (a `.env` next to it works too), together with the optional `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` for repo sync and PR linking. `EEC_SEED_DEMO=1 docker compose up` seeds the demo portfolio into an empty database. Without Docker, put `DATABASE_URL` (Neon or any Postgres) and `DEV_IDENTITY_EMAIL` in `.env.local` and run `npm run dev:local`; [docs/local-dev.md](docs/local-dev.md) lists every variable.

### Deploy as a Databricks App

`databricks.yml` declares the app, a Unity Catalog schema with two managed volumes (`sow_docs`, `agent_telemetry`), a Lakebase Postgres resource, a serving endpoint and a secret (`delivery-console/github-app-private-key`). It does not pin a workspace host: the CLI profile you log in with (or `DATABRICKS_HOST`) decides where it deploys.

```bash
databricks auth login --host https://<your-workspace>   # or export DATABRICKS_HOST
npm install
databricks bundle validate
databricks bundle deploy
databricks bundle run app
```

Set the bundle variables for your workspace with `--var="name=value"` on `deploy` or `BUNDLE_VAR_<name>` in the environment, unless your target already defines them:

| Variable | Value |
|---|---|
| `files_path`, `files_id` | the `sow_docs` volume path (`/Volumes/<catalog>/<schema>/sow_docs`) and its securable name (`<catalog>.<schema>.sow_docs`) |
| `postgres_project` | `databricks postgres list-projects` → `.name` |
| `postgres_branch` | `databricks postgres list-branches <project>` → `.name` |
| `postgres_database` | `databricks postgres list-databases <branch>` → `.name` |
| `serving_endpoint_name` | a model serving endpoint the app may query |

The secret scope and key must exist before `deploy` (a placeholder is fine; without a real GitHub App key the repo-sync features are off). `app.yaml` maps each resource to the environment variables the server reads. Each `bundle run app` restarts the app, about a minute of 502s.

### Deploy the container on AWS

The root `Dockerfile` builds one image (`node dist/main.js`, port 8000, non-root, `HEALTHCHECK` on `/healthz`) that runs on any container host with a Postgres URL. Amazon ECS Express Mode is the simplest fit on AWS; any other container service works the same way.

```bash
docker build -t cometloop .
aws ecr create-repository --repository-name cometloop
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <account-id>.dkr.ecr.<region>.amazonaws.com
docker tag cometloop:latest <account-id>.dkr.ecr.<region>.amazonaws.com/cometloop:latest
docker push <account-id>.dkr.ecr.<region>.amazonaws.com/cometloop:latest
```

Run the image with container port `8000`, health check path `/healthz`, and:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | required; Neon or any Postgres, `?sslmode=require` |
| `DATABASE_URL_UNPOOLED` | the direct (non-pooler) endpoint when `DATABASE_URL` is a Neon pooled URL |
| `ANTHROPIC_API_KEY` | the model key; a fresh install registers an Anthropic provider with every role mapped |
| `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` | the console's own sign-in (Better Auth / Neon Auth); until a sign-in is configured the API answers 401 to every browser |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | optional, repo sync and PR linking |
| `AZURE_KEY_VAULT_URL`, `AI_GATEWAY_URL` | optional, credential lookup from Key Vault and routing through Cloudflare AI Gateway |

Uploaded files land on local disk under `FILES_DIR` (`/data/files` in the image); mount a volume there if they must survive a redeploy. Serve it over HTTPS. Never set `DEV_IDENTITY_EMAIL` on a deployed instance.

## How it works

1. **Write a ticket.** A title is enough; SOW or SOP documents can be uploaded as context for a whole engagement.
2. **The planning agent fills it in.** It drafts the description and acceptance criteria, estimates hours, and reworks the ticket when a comment asks for changes.
3. **Hand it to an agent.** Drag the card to the agent lane for the shared pool, or assign it to one developer so their desktop runner takes it.
4. **The agent builds it.** The runner on the developer's machine claims the ticket, gets the work package (ticket, comments, rendered prompt, repo coordinates, context files), works on a branch named after the ticket key and opens a pull request. Progress and token usage stream back to the card.
5. **Review.** The PR moves the ticket to Review. The review gate runs a model review and publishes a verdict; a merge conflict is sent straight back to the agent, anything else waits for a human. A lead approves from the drawer, or rejects with a reason that sends the ticket back to Backlog and into the next run's prompt.
6. **Done means deployed.** Merging moves the ticket to Deploying, where it waits for CI on the merge commit. Green moves it to Done; red keeps it in Deploying with a warning. The board refuses a move into Done without a merged, deployed PR.

[docs/architecture.md](docs/architecture.md) covers the runtime, the agent platform and the delivery automation in full.

## Repository map

```
client/           React SPA (Vite): board, drawer, roadmap, analytics, agents map, standards
server/           Express API: one route module per domain under server/routes/
shared/           Imported by both shells: api-client/, design/ tokens, harnesses/ adapters
desktop/          Electron client: own package.json, typecheck and release pipeline
mcp/              MCP server exposing the console API over stdio
devbox-runner/    Headless reference runner (wait, claim, harness, complete)
scripts/          Ops scripts: dev-role migrations, Standards-tab sync, seeding, validators
tests/            Vitest unit tests and the Playwright smoke test
docs/             Architecture, standards, runner contract, runbooks, incidents, prompts
databricks.yml    Bundle: app, UC volumes, Lakebase and serving-endpoint resources
app.yaml          Databricks App runtime: start command and resource-injected env
Dockerfile        Portable runtime image; docker-compose.yml runs it with Postgres 17
```

## Development

```bash
npm install
cp .env.example .env         # Databricks path; or DATABASE_URL + DEV_IDENTITY_EMAIL in .env.local
npm run dev                  # http://localhost:8000, API + Vite HMR in one process (npm run dev:local for .env.local)
cd desktop && APP_URL=http://localhost:8000 npm run dev    # desktop against the local server
```

What CI runs on every push and PR; run it from a clean state before pushing:

```bash
npm run typecheck && npm run lint && npm run build      # web console
cd desktop && npm run typecheck && npm run build        # desktop client
```

Plus `npm run test:unit`, `npm run test:smoke` and `npm run format` as needed. The working agreement (git flow, validation, migration ownership, server, client and LLM conventions) is [docs/development-standards.md](docs/development-standards.md); keeping the two shells in step is [docs/cross-platform-parity.md](docs/cross-platform-parity.md). Desktop releases are cut by pushing a `v<version>` tag, which builds the Windows, macOS and Linux installers onto a GitHub Release that installed builds pick up automatically.

## Docs

| Doc | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System overview, runtime components, server modules, the agent platform, delivery automation |
| [docs/local-dev.md](docs/local-dev.md) | Running on plain Postgres: `DATABASE_URL`, docker compose, which env vars matter |
| [docs/development-standards.md](docs/development-standards.md) | The working agreement (also mirrored into the app's Standards tab) |
| [docs/devbox-integration.md](docs/devbox-integration.md) | The runner HTTP contract: authentication, endpoints, a minimal runner loop |
| [devbox-runner/README.md](devbox-runner/README.md) · [mcp/README.md](mcp/README.md) · [desktop/README.md](desktop/README.md) | The headless runner and harness adapters; the MCP server; the desktop client |
| [docs/cross-platform-parity.md](docs/cross-platform-parity.md) · [docs/feature-parity-tracker.md](docs/feature-parity-tracker.md) | Keeping web and desktop in step |
| [docs/agent-coordination.md](docs/agent-coordination.md) · [docs/omnigent-runner-architecture.md](docs/omnigent-runner-architecture.md) | Inter-agent protocol over Postgres; running a hosted agent as a runner |
| [docs/llm-fallbacks.md](docs/llm-fallbacks.md) · [docs/llm-hours-estimation.md](docs/llm-hours-estimation.md) | Per-flow model fallbacks; how hour estimates are produced |
| [docs/github-app-setup.md](docs/github-app-setup.md) · [docs/beta-runbook.md](docs/beta-runbook.md) | GitHub App provisioning; the beta tester runbook |
| [docs/incidents/](docs/incidents) · [docs/prompts/](docs/prompts) | Incident write-ups; the PR reviewer prompts |

## Contributing

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the validation commands, the PR flow against `main`, and the Developer Certificate of Origin sign-off (`git commit -s`) every commit needs.

## License

Cometloop is licensed under the GNU Affero General Public License v3.0; see [LICENSE](LICENSE). Commercial licensing is available on request.
