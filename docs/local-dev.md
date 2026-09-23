# Local development without Databricks

The console runs in two shapes from the same code (`server/server.ts`
decides at boot):

| `DATABASE_URL` | Runtime | Postgres | Files | Model |
|---|---|---|---|---|
| set | **portable** (`server/main.ts`): plain Express + `pg` | whatever the URL points at (Neon, docker-compose, any Postgres) | local disk under `FILES_DIR` | none yet — every model call takes its deterministic fallback (`docs/llm-fallbacks.md`) |
| unset | **Databricks App**: AppKit plugins as before | Lakebase via the workspace OAuth token | UC volumes | the workspace serving endpoint |

This is phase 0 of `docs/platform-architecture.md`. The Databricks path is
untouched; nothing here changes the deployed app.

## Run against Neon with `.env.local`

`.env.local` is git-ignored and holds the Neon `DATABASE_URL` (the pooled
`?sslmode=require` URL from the Neon console). Then:

```bash
npm install
npm run dev:local        # tsx watch + Vite HMR on http://localhost:8000
```

`dev:local` is `npm run dev` reading `.env.local` instead of `.env`. Boot logs
which features are off — one line each for the model provider, the workspace
endpoint list and the GitHub App — and `initSchema` creates every `app.*`
table on the empty branch with no "must be owner of table" warnings, because
one role owns everything on Neon.

To run the built artefacts the way the container does:

```bash
npm run build
NODE_ENV=production node --env-file=.env.local dist/server.js   # or dist/main.js
```

Smoke: `GET /healthz` → `{ ok: true, db: { ok: true } }`; `GET /api/engagements`
→ `[]`; `GET /` → the React app; `POST /api/engagements` creates one (you are
`admin` without the Apps proxy in front).

## Run with docker compose

Docker Desktop must be running.

```bash
docker compose up --build            # Postgres 17 (named volume) + the api on :8000
EEC_SEED_DEMO=1 docker compose up    # same, seeding the demo portfolio into an empty DB
docker compose run --rm worker       # the worker command (a stub until phase 4)
```

The compose Postgres is reachable from the host on `localhost:5433`
(`cometloop` / `cometloop`, db `cometloop`) for `psql`. Uploaded files live in
the `files` volume.

The image (`Dockerfile`) is multi-stage on `node:22-alpine`: build stage runs
`npm ci && npm run build`, the runtime stage carries production
`node_modules`, `dist/` and `client/dist/` only, runs as the `node` user, and
has a `HEALTHCHECK` on `/healthz`. Default command `node dist/main.js` (api);
`node dist/worker.js` is the worker.

## Environment variables

| Variable | Portable runtime | Notes |
|---|---|---|
| `DATABASE_URL` | **required** — selects the runtime | SSL on unless the URL says `sslmode=disable` (compose) or `sslmode=no-verify`. The `sslmode` parameter is stripped before `pg` sees the URL. |
| `DATABASE_URL_UNPOOLED` | strongly recommended on Neon | The direct endpoint (`DATABASE_URL` with `-pooler` removed from the host). With it each request pins one connection and sets the tenant session once; without it every statement scopes itself in its own transaction (three round trips each — the server warns). A `DATABASE_URL` that is already direct needs nothing extra. |
| `PORT` | default `8000` | `DATABRICKS_APP_PORT` is honoured as a fallback. `HOST` defaults to `0.0.0.0`. |
| `FILES_DIR` | default `data/files` (`/data/files` in the image) | One subdirectory per volume alias (`files/`, `telemetry/`). |
| `PG_POOL_MAX` | default `20` | Pool size. A request holds one connection for its duration in pinned mode; the runner long-poll opts out, so the default covers a busy board. |
| `EEC_SEED_DEMO` | `1` seeds the demo portfolio into an empty database | Never seeds a non-empty one. |
| `DEMO_MOCK_RUNNER` | `1` starts the in-process mock runner | Demo only. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` | optional | Without them repo sync, PR linking and git-credential vending are off (logged once). |
| `VITE_DEV` | `0` disables Vite middleware in development | Then `client/dist` is served if built, else API only. |
| `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` | optional | The serving-endpoint list on the Agents page, endpoint-agent state, and the SP the `databricks` provider kind calls with; absent → static catalog, logged once. |
| `DATABRICKS_SERVING_ENDPOINT_NAME` | optional | With the SP pair and no `ANTHROPIC_API_KEY`, a workspace with no provider gets this endpoint auto-registered as its model provider. |
| `ANTHROPIC_API_KEY` | optional | A workspace with no provider gets an Anthropic provider registered on first use, every role mapped (planning/review → `claude-sonnet-5`, estimate/draft → `claude-haiku-4-5-20251001`). One variable = a working install. |
| `AZURE_KEY_VAULT_URL` | optional | Provider credential names not found in the environment are read from this vault (`DefaultAzureCredential`). |
| `AI_GATEWAY_URL` | optional | Route provider calls through Cloudflare AI Gateway (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`). |
| `DATABRICKS_VOLUME_*`, `LAKEBASE_ENDPOINT`, `PG*` | ignored | Databricks-path only. |

Identity: without the Apps OAuth proxy every request is `local-dev` with the
`admin` role (`server/routes/roles.ts`) — phase 1 replaces this.
