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
| `GET` | `/api/agent/work?engagement=&agent=` | List queued tasks (and this runner's active claims) |
| `POST` | `/api/agent/work/claim` | Atomically claim the next task → returns the work package |
| `GET` | `/api/agent/work/:id` | Re-fetch the work package for a claimed task |
| `POST` | `/api/agent/work/:id/progress` | Heartbeat + progress note (becomes a ticket comment) |
| `POST` | `/api/agent/work/:id/git-credential` | Short-lived clone/push token (GitHub App connections only) |
| `POST` | `/api/agent/work/:id/flag` | Raise a warning (stuck/erroring/needs input) — yellow on the board, no lane change |
| `DELETE` | `/api/agent/work/:id/flag` | Clear the warning after recovering |
| `POST` | `/api/agent/work/:id/pr/:number/conflicts` | Merge-conflict analysis for a PR the agent opened (see below) |
| `POST` | `/api/agent/work/:id/pr/:number/escalate` | Flag a conflicted PR for developer review (comment + label + reviewers + board flag) |
| `POST` | `/api/agent/work/:id/pr/:number/comment` | Post a PR comment (e.g. document an auto-resolved conflict) |
| `POST` | `/api/agent/work/:id/complete` | Finish with `done` or `failed` |
| `GET` | `/api/engagements/:id/context-files` | List context files for an engagement |
| `GET` | `/api/engagements/:id/context-files/:name` | Download one context file |

### Claim

```bash
curl -s -X POST "$APP/api/agent/work/claim" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"agent": "devbox-1"}'
```

Optional body fields: `engagement` (only claim from one engagement), `ticket`
(claim a specific queued ticket). `404` means nothing is queued. Claiming is
atomic (`FOR UPDATE SKIP LOCKED`) — concurrent runners never get the same task.

The response contains `task` (note `task.id` and `task.instructions`),
`ticket` (with `description` and `ac` acceptance criteria), `engagement`,
`comments`, `repo`, and `contextFiles` (each with a relative `url` to download
through the app).

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
