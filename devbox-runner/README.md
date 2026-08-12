# Devbox runner

Reference implementation of the devbox side of the agent loop:

```
wait (long-poll) → claim → materialize workdir → claude -p → complete
```

No ingress required — the runner only makes outbound calls to the console.
Claims are atomic server-side, so any number of devboxes can run this
concurrently against the same queue.

## Requirements

Node 18+, git, the Databricks CLI authenticated against the workspace (or a
`DATABRICKS_TOKEN` env), and Claude Code (`claude`) on PATH.

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
