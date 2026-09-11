# AI Assistant Instructions

<!-- appkit-instructions-start -->
## Databricks AppKit

This project uses Databricks AppKit packages. For AI assistant guidance on using these packages, refer to:

- **@databricks/appkit** (Backend SDK): [./node_modules/@databricks/appkit/CLAUDE.md](./node_modules/@databricks/appkit/CLAUDE.md)
- **@databricks/appkit-ui** (UI Integration, Charts, Tables, SSE, and more.): [./node_modules/@databricks/appkit-ui/CLAUDE.md](./node_modules/@databricks/appkit-ui/CLAUDE.md)

### Databricks Skills

For enhanced AI assistance with Databricks CLI operations, authentication, data exploration, and app development, install the Databricks skills:

```bash
databricks aitools install
```
<!-- appkit-instructions-end -->

## Development standards

Read [docs/development-standards.md](./docs/development-standards.md) before
making changes — it is the working agreement for this repo: git/PR flow and
the CI deploy gate, validation commands, database migration ownership rules,
server/client/LLM conventions, and agent-runner discipline. The same document
is mirrored into the app's Standards tab for the Execution Console engagement
(`node scripts/sync-standards.mjs` pushes the repo copy; never edit it in the
tab).

## One product, two shells

The repo ships **one product in two shells** that must move together:

| Package | What it is | Validate with |
|---|---|---|
| `client/` + `server/` | The web console — a Databricks App (AppKit, Express + React/Vite). Deployed by CI on every merge to `main`. | `npm run typecheck && npm run lint && npm run build` (root) |
| `desktop/` | The Electron desktop client — embeds the deployed web console in its Tickets tab and adds native-only surfaces (Agents, Identity, Deploys, Terminal, Metrics). Released by tag (`v*`). | `cd desktop && npm run typecheck && npm run build` |
| `shared/` | Code both shells import: `api-client/` (typed console client), `design/` (tokens), `harnesses/` (coding-agent adapters). | Covered by both of the above |
| `mcp/`, `devbox-runner/`, `scripts/` | Standalone plain-JS packages (MCP server, headless runner, ops scripts). | `node --check <file>` |

Rules that follow from that split:

- **An API or `shared/` change is a two-shell change.** If you touch a route
  the desktop calls (`shared/api-client/index.ts` is the list), a `shared/`
  type, or a work-package/claim payload, update the desktop consumer in the
  same PR and run the desktop typecheck. CI runs it too; do not let it be the
  first time you find out.
- **UI/UX changes carry their parity status.** Board, drawer, planning and
  every other `client/` screen reach the desktop through the embedded webview
  (parity by construction). Anything implemented separately on both sides —
  tokens, fonts, markdown rendering, toasts, theme, card idioms — is
  *shared by design*: tick the parity item in the PR template, update
  [docs/feature-parity-tracker.md](./docs/feature-parity-tracker.md), or file a
  `parity-gap` ticket. Process: [docs/cross-platform-parity.md](./docs/cross-platform-parity.md).
- **Run `/parity-check` before opening a PR** — the project skill walks the
  classification, the docs that need touching, and the validation for each
  package.

## Which doc to update

| When you change… | Update |
|---|---|
| A server route, table, or the runner/claim contract | `docs/architecture.md` (module list, flows); `docs/devbox-integration.md` if the HTTP contract moved |
| Anything a desktop user sees (nav entry, view, config key, install/update flow) | `desktop/README.md`; `docs/beta-runbook.md` if testers follow it |
| A working agreement (validation, git flow, migrations, prompts) | `docs/development-standards.md`, then `node scripts/sync-standards.mjs` after merge |
| The local-client plan or its status | `docs/local-client-architecture.md` |
| A harness adapter | `devbox-runner/README.md` (the harness table) |
| An LLM flow's fallback | `docs/llm-fallbacks.md` |

## Local development

- Web: copy `.env.example` to `.env` (values come from `databricks.yml` and
  `databricks postgres get-endpoint …`; see README), `databricks auth login`,
  then `npm run dev` → http://localhost:8000. Without `GITHUB_APP_PRIVATE_KEY`
  the repo-sync features are off; everything else works.
- Desktop against the local server: `cd desktop && APP_URL=http://localhost:8000 npm run dev`.
- The primary checkout is shared by several Claude sessions and the
  emulation runner lives in its own worktree (`~/delivery-runner`, pinned to
  `main`). Use a fresh worktree from `origin/main` for independent work
  (`claude --worktree` puts it under `.claude/worktrees/`, which git, eslint
  and vitest ignore).
