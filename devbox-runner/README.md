# Devbox runner

Reference implementation of the devbox side of the agent loop:

```
wait (long-poll) → claim → materialize workdir → coding agent → complete
```

No ingress required — the runner only makes outbound calls to the console.
Claims are atomic server-side, so any number of devboxes can run this
concurrently against the same queue.

## Harnesses — run any coding agent

The runner's lifecycle is agent-agnostic; the only harness-specific parts
(launch command, output parsing, MCP wiring) live in `harnesses.mjs`, selected
by the `HARNESS` env var. Built in:

| `HARNESS` | Agent | Notes |
|---|---|---|
| `claude` (default) | Claude Code | `claude -p` stream-json, workdir `.mcp.json` |
| `codex` | OpenAI Codex CLI | `codex exec --json`, prompt on stdin; MCP via Codex's global config |
| `generic` | any prompt-taking CLI | set `AGENT_BIN`/`AGENT_ARGS`; raw output feed, no MCP |
| `omnigent` | Omnigent (hosted) | **scaffolding only** — `mode: 'service'`, no process; see below |

Adapters come in two **modes**. The three above are `process` adapters: the
runner spawns them and reads stdout. `omnigent` is the first `service` adapter —
the agent is a hosted API, so instead of `bin`/`args`/`parseLine` it provides
`submit` / `poll` / `fetchResult` / `cancel`, and `runner.mjs` drives a poll loop
that emits into the same live-feed sink and writes `RESULT.md` itself. `mode` is
absent on process adapters and defaults to `process`, so nothing existing moved.

The Omnigent adapter is **deliberately non-functional**: its four vendor calls
throw a pointer to
[docs/omnigent-runner-architecture.md](../docs/omnigent-runner-architecture.md),
because the vendor API was unconfirmed at design time (DAT-221). The console half
— registry, branding, the service seam and the poll loop — is real. If Omnigent
turns out to ship a plain CLI, skip the adapter entirely and use
`HARNESS=generic AGENT_BIN=omnigent`.

Because nothing is shared or stateful between runs, a **mixed fleet just
works**: point some boxes at `HARNESS=claude` and others at `HARNESS=codex`
against the same queue — they claim atomically and show up side by side on the
board (`claude-1`, `codex-2`, …). This is how you spread work across model
budgets. Adding a new harness is one entry in `harnesses.mjs`; nothing in
`runner.mjs` changes. Add it to `tests/harness-abstraction.test.ts` too — that
smoke test is what keeps the adapter shape, the stream parsing and the console's
harness ids honest in CI, since a broken adapter otherwise only shows up on a
devbox mid-run.

```bash
HARNESS=codex AGENT_NAME=codex-1 node devbox-runner/runner.mjs
HARNESS=generic AGENT_BIN=aider AGENT_ARGS='--yes --no-git' node devbox-runner/runner.mjs
```

Name the runner after its harness (`codex-1`, `gemini-2`, …): the console infers
the harness from the runner id (`inferHarness` in `server/routes/agents.ts`) and
brands the agent on the board with the right logo.

### Setting up a Codex box

```bash
npm install -g @openai/codex
codex login                                    # browser sign-in, or --with-api-key
codex mcp add delivery-console -- node <repo>/mcp/server.mjs   # MCP is global, not per-workdir
```

Then `devbox-runner/run-codex.ps1` (Windows) or the env line above. Codex's
default args here are `exec --json --skip-git-repo-check
--dangerously-bypass-approvals-and-sandbox`: `--json` gives the JSONL event
stream the live feed is built from, and `--skip-git-repo-check` is required
because the agent's cwd is the task workdir, with the repo one level down in
`./repo`. The bypass flag suits a single-purpose runner VM; on a shared box
prefer `CODEX_ARGS='exec --json --skip-git-repo-check -s workspace-write'`.

## Requirements

Node 18+, git, the Databricks CLI authenticated against the workspace (or a
`DATABRICKS_TOKEN` env), and the coding agent for your chosen `HARNESS` on
PATH (`claude`, `codex`, …).

## Run

```bash
node devbox-runner/runner.mjs
```

Single-task mode (local testing / emulating a devbox):

```bash
ONCE=1 AGENT_NAME=local-emu MCP_SERVER=./mcp/server.mjs node devbox-runner/runner.mjs
```

All configuration is env-based — see the header of `runner.mjs`. On a real
devbox install `delivery-runner.service` so the loop survives reboots.

## What a task run looks like

1. `GET /api/agent/work/wait` holds until a lead queues a ticket (~1–2 s pickup).
2. `POST /api/agent/work/claim` returns the work package, including a
   **server-rendered prompt** — prompt wording is owned by the console repo,
   so changing it is a console deploy, not a fleet update.
3. The runner materializes `WORK_ROOT/<KEY>-task<id>/` with
   `work-package.json`, `./context/` files, and `./repo/` cloned via a vended
   short-lived GitHub App credential (`GIT_TOKEN` is exported into Claude's
   environment for pushing and opening the PR).
4. `claude -p` runs with the prompt on stdin, using
   `--output-format stream-json --verbose` so the runner can render a live
   activity feed in the terminal: assistant text as-is, one `  > Tool label`
   line per tool call (file path, command, or a prefix of the input JSON),
   and the final result event in full. Unparseable lines are printed raw.
   If `MCP_SERVER` is set, a `.mcp.json` in the workdir gives Claude the
   delivery-console tools to post progress notes and raise flags itself.
5. A sidecar heartbeat fires every 2 minutes so the board never shows STALLED
   during long runs. It doubles as a liveness check: the console answers 404
   once the task is no longer claimed/working by this agent (cancelled or
   recalled by a lead), and the runner then kills the Claude child and goes
   straight back to waiting instead of sitting wedged behind a dead run.
   A `MAX_RUN_MINUTES` watchdog (default 180) likewise kills a genuinely hung
   run and completes it `failed`.
6. On exit, the runner reads the agent's `RESULT.md` for the completion
   summary (and PR URL) and completes `done` (exit 0 → ticket to Review) or
   `failed` (ticket back to Backlog). If the console rejects the completion
   because the task was cancelled mid-run, the runner just returns to waiting.

## Permissions note

The default `CLAUDE_ARGS` is `--permission-mode acceptEdits`, but validation
showed non-interactive runs need an explicit allowlist — without it, file
writes and MCP tools get auto-denied. The tested set:

```bash
CLAUDE_ARGS='--permission-mode acceptEdits --allowedTools Write,Edit,Bash(git:*),Bash(gh:*),Bash(curl:*),Bash(node:*),Bash(npm:*),mcp__delivery-console__*'
```

On Windows, `run-local.ps1` launches the emulation with this configuration
baked in. On a locked-down single-purpose VM,
`CLAUDE_ARGS='--dangerously-skip-permissions'` is a defensible alternative.
