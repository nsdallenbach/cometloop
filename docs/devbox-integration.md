# Devbox agent integration

The Delivery Console exposes an HTTP work queue that external agent runners — the
devbox platform (Azure VMs running Claude Code) — poll, claim from, and report
back to. The console never runs agents itself; a runner is any process that can
reach the app URL with a Databricks OAuth token.

```
App URL: https://delivery-console-7474645607548631.aws.databricksapps.com
```

## How work flows

1. An engagement lead drags a ticket into the board's **◆ Deploy to Agent**
   lane (or clicks **Queue for agent** in the ticket drawer to attach
   instructions). Order within the lane is claim priority — agents pull from
   the top; leads drag cards to reorder, or drag them out to recall.
2. A runner polls `GET /api/agent/work`, claims the task, and receives a
   **work package**: the ticket (title, description, acceptance criteria,
   comments), the engagement summary, the connected repo coordinates (URL,
   default branch — no token; the runner brings its own git credentials), the
   lead's instructions, and the engagement's **context files**.
3. The runner posts progress notes while it works — each note becomes a
   ticket comment **and** shows live on the ticket's board card, so post them
   often (claimed, repro'd, implementing, testing, pushing). It completes with
   `done` (ticket moves to **Review**) or `failed` (ticket returns to
   **Backlog**).
4. If the runner opens a PR whose branch or title contains the ticket key
   (e.g. `NAC-104-add-auth`), the existing repo integration links it to the
   ticket automatically and moves the ticket to **Done** when the PR merges.
5. Ticket comments are a steering channel: comments present at claim time are
   rendered into the server-side prompt, and the prompt tells the agent to
   re-read them (via the `get_ticket` MCP tool or
   `GET /api/agent/work/:id`) before pushing. Tickets in **Review** can be
   re-queued — post review feedback as comments, queue the ticket, and the
   next run's prompt carries the feedback. See
   [comment-steering.md](./comment-steering.md).

Task lifecycle: `queued → claimed → working → done | failed`, or `cancelled`
by a lead from the console.

## Authentication

Every request goes through the Databricks Apps OAuth proxy, so the runner
needs a workspace identity with **Can Use** permission on the app.

On a devbox VM with the Databricks CLI authenticated (user or service
principal), mint a token per request batch:

```bash
HOST="https://dbc-96494b8f-6b86.cloud.databricks.com"
APP="https://delivery-console-7474645607548631.aws.databricksapps.com"
TOKEN=$(databricks auth token --host "$HOST" | jq -r .access_token)
AUTH="Authorization: Bearer $TOKEN"
```

For unattended runners, prefer a dedicated service principal with an OAuth
secret (`databricks auth login` M2M or the `/oidc/v1/token` endpoint), granted
Can Use on the app.

## Endpoint reference

All bodies are JSON. `agent` is the runner's self-chosen name (e.g.
`devbox-1`) — it is displayed in the console and stamped on comments.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/agent/work/wait?engagement=&agent=` | Long-poll for queued work (~55s hold) — also the fleet liveness ping |
| `GET` | `/api/agent/work?engagement=&agent=` | List queued tasks (and this runner's active claims) |
| `POST` | `/api/agent/work/claim` | Atomically claim the next task → returns the work package |
| `GET` | `/api/agent/work/:id` | Re-fetch the work package for a claimed task |
| `POST` | `/api/agent/work/:id/progress` | Heartbeat + progress note (becomes a ticket comment) |
| `POST` | `/api/agent/work/:id/tool-calls` | Stream tool-call events (batched) → live feed in the ticket drawer, never comments |
| `POST` | `/api/agent/work/:id/git-credential` | Short-lived clone/push token (GitHub App connections only) |
| `POST` | `/api/agent/work/:id/flag` | Raise a warning (stuck/erroring/needs input) — yellow on the board, no lane change |
| `DELETE` | `/api/agent/work/:id/flag` | Clear the warning after recovering |
| `POST` | `/api/agent/work/:id/pr/:number/conflicts` | Merge-conflict analysis for a PR the agent opened (see below) |
| `POST` | `/api/agent/work/:id/pr/:number/escalate` | Flag a conflicted PR for developer review (comment + label + reviewers + board flag) |
| `POST` | `/api/agent/work/:id/pr/:number/comment` | Post a PR comment (e.g. document an auto-resolved conflict) |
| `POST` | `/api/agent/work/:id/complete` | Finish with `done` or `failed` |
| `GET` | `/api/engagements/:id/context-files` | List context files for an engagement |
| `GET` | `/api/engagements/:id/context-files/:name` | Download one context file |
| `GET` | `/api/tickets/:key/attachments` | List a ticket's file attachments |
| `POST` | `/api/tickets/:key/attachments?filename=` | Upload an attachment (raw body, max 25 MB; executables rejected) |
| `GET` | `/api/tickets/:key/attachments/:id` | Download one attachment (`X-Content-Sha256` header carries the checksum) |
| `DELETE` | `/api/tickets/:key/attachments/:id` | Delete an attachment (lead only) |

### Wait (and say who you are)

```bash
curl -s "$APP/api/agent/work/wait?agent=devbox-1" -H "$AUTH"
```

Always pass `agent` on the poll. The console stamps `last_polled_at` for that
runner and treats anything without a stamp inside the grace window (4 minutes,
about three missed cycles) as **offline** rather than idle — that stamp is the
only thing separating "waiting for work" from "the process died". Task
heartbeats count too, so a runner deep in a long run stays online while it is
not polling.

The payoff is on the board: when work has been queued past the alert threshold
(10 minutes) with zero online runners for its engagement, the console raises a
**FLEET DOWN** warning instead of leaving the card sitting quietly in the lane.
Omit `agent` and your runner is invisible to that check while idle (the console
logs a one-time warning saying so).

The console also reclaims work you drop. If a claimed task goes 15 minutes
without a heartbeat, it is released back to `queued` for another runner (and
after two releases it fails for a human). Keep heartbeating while you work, and
treat `404`/`409` from heartbeat or complete as "this run is no longer mine" —
kill the agent and go back to waiting rather than finishing a run the console
has already handed to someone else.

### Claim

```bash
curl -s -X POST "$APP/api/agent/work/claim" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent": "devbox-1"}'
```

Optional body fields: `engagement` (only claim from one engagement), `ticket`
(claim a specific queued ticket). `404` means nothing is queued. Claiming is
atomic (`FOR UPDATE SKIP LOCKED`) — concurrent runners never get the same task.

`403` means the runner's per-agent security settings forbid it (DAT-212): the
agent is disabled, or lacks the `claim_work` scope. The claim is released, so
the ticket stays queued for another runner, and the body carries the reason and
the `action` that was denied. Treat it as a configuration decision, not a
transient error — back off rather than retrying, or the still-queued work will
spin the loop (`runner.mjs` pauses `DENIED_COOLDOWN_MS`, default 2 minutes).
`git-credential` and the coordination endpoints answer 403 the same way; a lead
widens the scope from the agent's panel on the Agent Map (`/agent-map`). Reporting progress and
completing a task the runner already holds are never blocked, so an agent
disabled mid-run can always close out cleanly.

The response contains `task` (note `task.id` and `task.instructions`),
`ticket` (with `description` and `ac` acceptance criteria), `engagement`,
`comments`, `repo`, `contextFiles`, `attachments` (context files and
attachments each carry a relative `url` to download through the app), and
`runnerConfig` (see below).

### Runner environment (`runnerConfig`)

The project's **Config** tab sets the base image and preferred libraries for
its agent sessions; the claim response carries them already validated and
resolved:

```json
{
  "baseImage": "python-3.12",
  "image": "ghcr.io/datavail-solutions/runner-base:python-3.12",
  "label": "Python 3.12 (default)",
  "libraries": [{ "manager": "pip", "name": "pandas", "spec": "pandas==2.2.1" }],
  "installCommands": [
    { "manager": "pip", "argv": ["python3", "-m", "pip", "install", "--no-input", "--disable-pip-version-check", "pandas==2.2.1"] }
  ]
}
```

Provision before launching the agent, and note two contracts:

- **`installCommands` are argv arrays, never shell strings.** Spawn them
  directly (`execFile`, not `exec`). Package names are allowlist-validated at
  save time, so nothing here needs quoting — and nothing here should be given
  a shell that could interpret it.
- **A provisioning failure is a delivery failure.** Flag the task and complete
  it `failed` with the installer's error, rather than handing the agent a
  half-built environment. The bundled runner does exactly this.

Base images can't be swapped by a VM that is already running, so a runner
declares what it provides via `RUNNER_BASE_IMAGE` and reports a mismatch in
its progress note; set `RUNNER_IMAGE_STRICT=1` to fail the task instead of
delivering work from the wrong environment. Projects that never open the
Config tab get the default image and no extra libraries.

### Agent configuration (`agentConfig`)

What a lead set for **this agent** on the Agents page (DAT-278 / DAT-238),
resolved for the claiming runner by its agent name (DAT-279):

```json
{
  "model": "claude-opus-5",
  "mcpServers": [
    {
      "slug": "jira", "name": "Jira", "transport": "stdio",
      "command": "npx", "args": ["-y", "jira-mcp"], "url": null,
      "env": { "JIRA_SITE": "datavail.atlassian.net" },
      "requiresAuth": true, "authEnv": "MCP_AUTH_JIRA"
    }
  ],
  "skills": [
    { "slug": "review-style", "name": "Review style", "description": "How we review", "content": "# Review …", "harnesses": ["claude-code"] }
  ]
}
```

- **`model`** is the harness's own model id (`claude --model …`, `codex -m …`);
  `null` means the harness default. Pass it through the adapter's
  `modelArgs(model)` — never hard-code a switch in the runner.
- **`mcpServers`** are registry entries, shared or scoped to the project.
  The Claude harness writes them into the workdir `.mcp.json` next to
  `delivery-console`; a server with `requiresAuth` gets its credential as an
  env reference (`${MCP_AUTH_<SLUG>}`) so **the value must be in the runner's
  process environment** and never lands in a file. The bundled runner logs
  and notes on the ticket any server whose `authEnv` is unset. Codex reads
  MCP from its global config, so nothing is written for it.
- **`skills`** become `.claude/skills/<slug>/SKILL.md` for Claude Code and are
  appended to `AGENTS.md` for Codex.

An agent the console has no record for (a runner name it has never seen)
gets `{ "model": null, "mcpServers": [], "skills": [] }` — the claim never
fails on missing configuration.

### Progress

```bash
curl -s -X POST "$APP/api/agent/work/$TASK_ID/progress" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent": "devbox-1", "note": "Repro confirmed; writing the fix in feature/NAC-104-retry-backoff"}'
```

### Complete

```bash
curl -s -X POST "$APP/api/agent/work/$TASK_ID/complete" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent": "devbox-1", "outcome": "done", "summary": "Implemented retry with backoff; unit tests added.", "url": "https://github.com/org/repo/pull/42"}'
```

`outcome: "failed"` returns the ticket to the backlog; put the reason in
`summary` so the lead sees it on the ticket.

### Tool-call streaming (telemetry)

Runners that watch their agent's tool use (the bundled `devbox-runner` parses
Claude Code's `stream-json` output) should batch-post each `tool_use` event —
these render as a live **TOOL ACTIVITY** feed in the ticket drawer instead of
flooding the comment thread, and each batch doubles as a heartbeat:

```bash
curl -s -X POST "$APP/api/agent/work/$TASK_ID/tool-calls" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent": "devbox-1", "calls": [
        {"tool": "Bash", "detail": "git status", "ts": "2026-08-11T12:00:00Z"},
        {"tool": "Read", "detail": "server/server.ts", "ts": "2026-08-11T12:00:05Z"}
      ]}'
```

Up to 200 calls per batch; `detail` is a short human label (file path,
command), max 600 chars. Batch every few seconds rather than per event.
When the run completes (or is cancelled), the console archives the full log
as NDJSON to the `sandbox.engagement_console.agent_telemetry` UC volume under
`tool-calls/<engagement>/<ticket>/task-<id>.ndjson` for offline analysis.

## Merge conflicts on agent PRs

The server-rendered prompt tells the agent to check its freshly opened PR for
merge conflicts against the base branch and act on what it finds. The division
of labor: the agent has the clone (it computes the conflicted files locally
with `git merge-tree`), the console has the provider token and the PR↔ticket
links (it knows whose work overlaps).

```bash
curl -s -X POST "$APP/api/agent/work/$TASK_ID/pr/$PR/conflicts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent": "devbox-1", "conflict_files": ["server/routes/api.ts"]}'
```

The response reports the provider's mergeability verdict, every other open PR
(and recently merged PR) touching the same files with the ticket each is
linked to, and an `assessment`: `auto-resolve` when nothing overlapping is in
flight and no other ticket is impacted, otherwise `developer-review` with
reasons. The threshold for "impacts another ticket" is a shared file: an open
PR touching a conflicted file, or a recently merged PR from a different ticket
having changed one.

- **Auto-resolve path** — the agent merges the base branch into its PR branch,
  resolves, re-tests, pushes, and documents the resolution via
  `POST …/pr/:number/comment`.
- **Escalation path** — `POST …/pr/:number/escalate` with a `reason` and the
  overlapping `conflicting_prs`. The console comments on the PR naming the
  conflicting PR(s) and ticket(s), adds a `merge-conflict` label, requests
  review from the developers who authored the conflicting PRs (GitHub; on ADO
  the comment mention is the notification), flags the agent task on the board,
  and posts a heads-up comment on each impacted ticket. The agent then
  completes normally and notes the flag in `RESULT.md`.

All three endpoints are also exposed as MCP tools (`check_pr_conflicts`,
`escalate_pr_conflict`, `comment_on_pr`) when the runner wires up
`mcp/server.mjs`.

## Minimal runner loop (devbox)

```bash
#!/usr/bin/env bash
# Poll the Delivery Console and hand claimed tickets to Claude Code.
set -euo pipefail
HOST="https://dbc-96494b8f-6b86.cloud.databricks.com"
APP="https://delivery-console-7474645607548631.aws.databricksapps.com"
AGENT="devbox-$(hostname)"

while true; do
  TOKEN=$(databricks auth token --host "$HOST" | jq -r .access_token)
  AUTH="Authorization: Bearer $TOKEN"
  PKG=$(curl -s -X POST "$APP/api/agent/work/claim" -H "$AUTH" -H 'Content-Type: application/json' \
        -d "{\"agent\": \"$AGENT\"}")
  if [ "$(echo "$PKG" | jq -r '.task.id // empty')" = "" ]; then
    sleep 60
    continue
  fi

  ID=$(echo "$PKG" | jq -r .task.id)
  KEY=$(echo "$PKG" | jq -r .ticket.key)
  ENG=$(echo "$PKG" | jq -r .task.engagement_id)
  REPO_URL=$(echo "$PKG" | jq -r '.repo.repo_url // empty')

  WORKDIR=$(mktemp -d)
  echo "$PKG" | jq . > "$WORKDIR/work-package.json"
  # Pull the engagement's context files next to the work package.
  echo "$PKG" | jq -r '.contextFiles[]?.name' | while read -r NAME; do
    curl -s "$APP/api/engagements/$ENG/context-files/$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$NAME")" \
      -H "$AUTH" -o "$WORKDIR/context/$NAME" --create-dirs
  done
  [ -n "$REPO_URL" ] && git clone "$REPO_URL" "$WORKDIR/repo"   # devbox's own git credentials

  curl -s -X POST "$APP/api/agent/work/$ID/progress" -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"agent\": \"$AGENT\", \"note\": \"Claimed on $(hostname); starting Claude Code run.\"}"

  # Hand the whole package to Claude Code. Branch names must contain the
  # ticket key so the console auto-links the PR.
  if (cd "$WORKDIR" && claude -p "You are working ticket $KEY. Read work-package.json for the ticket, \
acceptance criteria and lead instructions, and ./context/ for reference files. The repo is cloned in ./repo. \
Create branch $KEY-<slug>, implement the work, push, and open a PR." --permission-mode acceptEdits); then
    curl -s -X POST "$APP/api/agent/work/$ID/complete" -H "$AUTH" -H 'Content-Type: application/json' \
      -d "{\"agent\": \"$AGENT\", \"outcome\": \"done\", \"summary\": \"Claude Code run finished; see linked PR.\"}"
  else
    curl -s -X POST "$APP/api/agent/work/$ID/complete" -H "$AUTH" -H 'Content-Type: application/json' \
      -d "{\"agent\": \"$AGENT\", \"outcome\": \"failed\", \"summary\": \"Claude Code run exited non-zero; see devbox logs.\"}"
  fi
done
```

Adapt freely — the contract is only: claim, heartbeat via progress, then
complete with an honest outcome.
