# Development standards — Delivery Console

The working agreements for humans and agents building this product. Every rule
here was earned in practice; when you break one, you are usually about to
relearn why it exists. The same document is loaded into the app's Standards
tab for the Execution Console engagement, and is intended to become part of
the context handed to agent runners.

## Architecture at a glance

- **App**: Databricks App (AppKit, Node/Express + React/Vite), one process
  serving `/api/*` and the static client, behind the workspace OAuth proxy.
- **Data**: Lakebase Postgres (`app.*` schema, migrations at boot), UC volume
  for files (`context/`, `standards/` per engagement), and the workspace's
  configured model providers (Admin → Model providers; `server/llm/`) for
  all LLM calls — the Databricks serving endpoint is one provider kind.
- **Git**: GitHub (`datavail-solutions/engagement-console`), GitHub App for
  repo auth (installation tokens, no PATs at rest), CI deploy on merge.
- **Agents**: work queue in Postgres; runners long-poll, claim atomically,
  drive a coding agent through a harness adapter (`shared/harnesses/`), and
  report back over HTTP or the MCP server (`mcp/`). Work is either pooled or
  routed to one developer's machine.
- **Desktop client** (`desktop/`): Electron shell on each developer's machine
  — embeds the deployed web console, hosts the routed runner, identity
  (Databricks OAuth + gh/az/ADO), local deploys that report events home, a
  terminal, token metrics. Released by tag with silent auto-update. Shares
  `shared/` (typed API client, design tokens, harness adapters) with the web
  console: an API or `shared/` change is a two-shell change.
- **Agents are managed on the desktop, never from the web.** Runner agents
  belong to developers: their project scope, model, MCP servers and skills
  are configured in the desktop Agents page and reported to the console,
  which only mirrors them (the API refuses web edits on desktop-managed
  agents). The web's Agents page is the read-only full view for leads and
  PMs plus lead governance — endpoint agents, security scopes, load
  balancing, registry publishing. Build agent features desktop-first.

## Git and delivery flow

- **One ticket, one branch, one PR.** Branch names and/or PR titles MUST
  contain the ticket key (`DAT-123-short-slug`) — that is what auto-links the
  work and drives ticket automation (PR opened → Review, merged → Deploying
  while the pipeline runs → Done).
- **Nobody merges their own agent PRs.** Agents (and Claude sessions acting
  as agents) open PRs and stop. Merging is the human review gate.
- **Merged is not deployed.** Every merge to `main` runs the CI gate
  (typecheck → lint → build, plus the desktop typecheck) and only then
  deploys — to **staging** (`staging.cometloop.ai`, Amazon ECS, Neon branch
  `staging`). **Production is a promotion**: someone runs the Deploy
  workflow with `environment = production` after staging has been
  exercised; nothing reaches production on merge alone. A red Actions run
  means the merge shipped nothing — check the Actions tab or the ticket's
  deploy badge before believing a feature is live. Hosting and the runbook
  live in the private `nsdallenbach/cometloop-infra` repo (`aws/README.md`
  there); this repo only dispatches to its Deploy workflow.
- **Done means deployed.** The board refuses a move into Done until the
  ticket's linked PR is merged and its deploy pipeline has succeeded (DAT-213)
  — by hand, over the API, or through MCP. The rule is not retroactive and
  never applies to tickets already in Done. Work that ships nothing deployable
  (docs, spikes, meetings) carries the `no-deploy` tag to opt out, and
  engagements with no repo connected are outside the rule entirely.
- **Deploys blink.** Each deploy restarts the app (~1 minute of 502s). Batch
  merges between agent runs rather than mid-run, and never diagnose a 502 as
  a code bug until the Actions run has settled.
- **Delete branches after merge.** Stale branches pile up fast with agent
  work; the PR preserves history.
- **Shared UI/UX changes carry their parity status.** Any PR touching
  `shared/design/`, `desktop/src/renderer/`, or a client idiom the desktop
  mirrors (tokens, markdown rendering, toasts, theme, fonts) ticks the parity
  item in the PR template: either both platforms are covered and the
  [parity tracker](./feature-parity-tracker.md) row is updated in the same PR,
  or a `parity-gap` ticket is filed for the lagging platform. Process and
  ownership: [cross-platform-parity.md](./cross-platform-parity.md).
- **Parallel sessions use worktrees.** Multiple Claude sessions share this
  checkout. Never commit on, stage over, or switch another session's branch —
  make a fresh worktree from `origin/main` for independent work, and stage
  files explicitly (no `git add -A` in a shared tree).

## Validation before push

Run what CI runs, from a clean state — targeted lint has burned us twice:

```bash
npm run typecheck && npm run lint && npm run build   # web console
cd desktop && npm run typecheck                       # desktop client (its own package; CI runs this too)
```

For anything risky, validate in a fresh worktree with `npm ci` first —
that is CI-identical. Standalone JS subpackages (`mcp/`, `devbox-runner/`,
`scripts/`) are excluded from the TS lint project on purpose; check them with
`node --check`. The desktop typecheck is what catches a `shared/api-client`
or route change the desktop consumes — run it whenever you touch `shared/`
or a route the desktop calls, not only when you edit `desktop/`. In Claude
Code, `/parity-check` walks this and the parity docs.

The Standards tab mirrors this file plus `docs/beta-runbook.md`; after a
merge that changes either, run `node scripts/sync-standards.mjs` (dry-run
with `--dry-run`) rather than editing the tab by hand.

## Database and migrations

- Schema lives in `*_SCHEMA_SQL` arrays executed at boot. Statements run
  independently and log failures without aborting — never reintroduce
  all-or-nothing ordering.
- **Ownership rule**: the app's service principal owns tables it created
  (e.g. `agent_tasks`) and can `ALTER` them at boot. Tables created during
  early dev are owned by the developer role — boot `ALTER`s on those FAIL.
  For those, put new columns in the `CREATE TABLE IF NOT EXISTS` (fresh
  installs) AND add an entry to `scripts/dev-migrate.cjs` (existing DB) — one
  idempotent script holds every dev-role migration, including the app SP's
  grants (full table privileges, because FK creation needs `REFERENCES`).

## Server code

- One route module per domain (`agent-work`, `repos`, `github-app`,
  `context-files`, `standards`), wired in `api.ts`. New domains get new
  modules; `api.ts` should shrink over time, not grow.
- Validate every body with zod; reply errors as `{ error: string }` with a
  meaningful status; lead-only actions go through `requireLead`.
- Postgres rows arrive as `Record<string, unknown>` — coerce with a typed
  helper (`typeof v === 'string' ? v : ''`), never bare `String(v)` on
  unknowns (`no-base-to-string` will reject it in CI, after it works locally).
- Human-visible side effects (ticket moves, agent events) write `feed_items`.

## LLM calls

- Everything goes through `invokeModel('<role>', request, ctx)` and the
  workspace's configured provider (`server/llm/`, platform-architecture §6).
  No other model paths, no vendor SDK calls, no API keys in code or in the
  database — a provider row names its credential, the value lives in the
  environment or Key Vault.
- Prompts live in the server code, versioned with the app — prompt changes
  are deploys, not fleet updates. The claim work package carries the rendered
  runner prompt for the same reason.
- Contract with the model: ask for ONLY a JSON object, parse defensively
  (regex the first `{...}`, type-check every field), and **always have a
  deterministic fallback** — a model failure may degrade a feature but must
  never fail the user's action.
- Preserve human words: refinement flows keep the original request verbatim
  under `## Original request`.
- Any prompt whose output becomes a ticket comment renders the shared style
  rules from `server/routes/comment-style.ts` — `commentStyleSection()` when
  the model's output *is* the comment, `commentStyleBrief()` when the comment
  is one field of a JSON contract. Do not restate the rules inline; they drift.
- Model calls go through `invokeModel()` (`server/routes/llm-health.ts`),
  never an adapter directly — that is what resolves the role to the
  workspace's provider, refuses a model that cannot meet the role's contract,
  retries transient errors, counts failures per flow, posts the ⚠ feed item
  when a call fails (DAT-180: a model outage must never be silent) and
  records the call's tokens. Say `json: true` when the prompt asks for JSON,
  and pass `ticketKey` when you have one so usage lands on the ticket.
  Fallback behavior per flow is documented in `docs/llm-fallbacks.md`;
  per-role health is `GET /api/llm/health`.

## Client code

- Inline styles with theme tokens (`var(--ok)`, `var(--warn)`, `var(--agent)`,
  `mono()` helper) — no CSS frameworks; shared classes live in `index.css`.
- All markdown renders through the `Markdown` component (marked + DOMPurify).
  Never `dangerouslySetInnerHTML` unsanitized content.
- Board cards animate via Motion layout springs with `layoutId`
  `card-<ticketKey>` inside the `LayoutGroup` — reuse that identity for any
  new card surface so cross-lane morphs keep working.
- Mutations are optimistic with rollback on API failure plus a toast.
- The board polls every 8s; remember the served bundle does NOT hot-reload
  after a deploy — a stale tab shows old UI until hard refresh.

## Agent runners

- Lifecycle: long-poll `/api/agent/work/wait` → atomic claim → work →
  complete `done` (→ Review) or `failed` (→ Backlog). Never leave a claim
  hanging — that is what the STALLED detector exists to catch. A claim that
  goes silent for 15 minutes is reclaimed by the fleet watch and requeued for
  someone else; treat a `404` from heartbeat or complete as "this run is no
  longer mine" and abandon it, which the bundled runner already does.
- **Identify yourself on the poll** (`/api/agent/work/wait?agent=<name>`).
  Runner liveness is that stamp: no poll inside the grace window means
  `offline`, not `idle`, and queued work with zero online runners raises
  FLEET DOWN on the board. A runner that polls anonymously looks dead while
  idle — and, worse, a dead fleet looks fine (DAT-224).
- **Be chatty**: progress note at claim, at plan, and before pushing;
  silent heartbeat at least every 2 minutes during long runs; raise a flag
  (`/flag`) when stuck instead of guessing or dying quietly.
- Environment is per project, not per runner: the Config tab's base image and
  preferred libraries ride along in the claim payload as `runnerConfig`, and
  the runner provisions from it before launching the agent. Entries are
  validated when a lead saves them, so a provisioning failure means the
  environment is broken (network, registry, missing wheel) — flag and fail the
  task rather than working in a half-built environment.
- **Be readable**: comment bodies render as markdown in the drawer, so notes,
  flags and completion summaries use short paragraphs, bullets once there are
  three or more items, and `code` for files and identifiers. The rules are a
  single source of truth in `server/routes/comment-style.ts` and are rendered
  into every prompt that writes a comment — add new comment-writing flows
  there rather than restating the style inline.
- Auth: mint workspace tokens via the CLI, cache no longer than 10 minutes,
  and treat any 401 as "refresh and retry once" — long-lived daemons that
  cache tokens without a 401 path will eventually replay a dead token forever.
- Git access comes from the console's vended installation tokens (~1h TTL) —
  runners never store git credentials.
- Write `RESULT.md` (what happened + PR URL) before exiting; it becomes the
  completion summary on the ticket.
- The local emulation runner lives in its own worktree (`~/delivery-runner`),
  pinned to `main`, so session branch-switching never changes runner behavior.

## Secrets

- No long-lived tokens at rest: GitHub access via the GitHub App private key
  (Databricks secret scope `delivery-console`), everything else minted
  short-lived. The one exception is the CI deploy PAT in GitHub repo secrets
  (90-day, rotate on expiry).
- Never echo tokens into logs, transcripts, or PR bodies; pass them via env
  or files that get deleted.
