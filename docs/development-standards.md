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
  for files (`context/`, `standards/` per engagement), model serving endpoint
  (`databricks-claude-sonnet-5`) for all LLM calls.
- **Git**: GitHub (`datavail-solutions/engagement-console`), GitHub App for
  repo auth (installation tokens, no PATs at rest), CI deploy on merge.
- **Agents**: work queue in Postgres; runners (devbox VMs / local emulation
  via `devbox-runner/`) long-poll, claim atomically, run Claude Code, report
  back over HTTP or the MCP server (`mcp/`).

## Git and delivery flow

- **One ticket, one branch, one PR.** Branch names and/or PR titles MUST
  contain the ticket key (`DAT-123-short-slug`) — that is what auto-links the
  work and drives ticket automation (PR opened → Review, merged → deploy
  watch → Done).
- **Nobody merges their own agent PRs.** Agents (and Claude sessions acting
  as agents) open PRs and stop. Merging is the human review gate.
- **Merged is not deployed.** Every merge to `main` runs the CI gate
  (typecheck → lint → build) and only then deploys. A red Actions run means
  the merge shipped nothing — check the Actions tab or the ticket's deploy
  badge before believing a feature is live.
- **Deploys blink.** Each deploy restarts the app (~1 minute of 502s). Batch
  merges between agent runs rather than mid-run, and never diagnose a 502 as
  a code bug until the Actions run has settled.
- **Delete branches after merge.** Stale branches pile up fast with agent
  work; the PR preserves history.
- **Parallel sessions use worktrees.** Multiple Claude sessions share this
  checkout. Never commit on, stage over, or switch another session's branch —
  make a fresh worktree from `origin/main` for independent work, and stage
  files explicitly (no `git add -A` in a shared tree).

## Validation before push

Run what CI runs, from a clean state — targeted lint has burned us twice:

```bash
npm run typecheck && npm run lint && npm run build
```

For anything risky, validate in a fresh worktree with `npm ci` first —
that is CI-identical. Standalone JS subpackages (`mcp/`, `devbox-runner/`,
`scripts/`) are excluded from the TS lint project on purpose; check them with
`node --check`.

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

- Everything goes through `appkit.serving('default')` — the workspace model
  serving endpoint. No other model paths, no API keys in code.
- Prompts live in the server code, versioned with the app — prompt changes
  are deploys, not fleet updates. The claim work package carries the rendered
  runner prompt for the same reason.
- Contract with the model: ask for ONLY a JSON object, parse defensively
  (regex the first `{...}`, type-check every field), and **always have a
  deterministic fallback** — a model failure may degrade a feature but must
  never fail the user's action.
- Preserve human words: refinement flows keep the original request verbatim
  under `## Original request`.
- Model calls go through `invokeModel()` (`server/routes/llm-health.ts`),
  never `serving('default').invoke` directly — that is what retries transient
  errors, counts failures per flow, and posts the ⚠ feed item when a call
  fails (DAT-180: a model outage must never be silent). Fallback behavior per
  flow is documented in `docs/llm-fallbacks.md`; endpoint health is
  `GET /api/llm/health`.

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
  hanging — that is what the STALLED detector exists to catch.
- **Be chatty**: progress note at claim, at plan, and before pushing;
  silent heartbeat at least every 2 minutes during long runs; raise a flag
  (`/flag`) when stuck instead of guessing or dying quietly.
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
