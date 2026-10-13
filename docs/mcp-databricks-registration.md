# Delivery Console MCP in Databricks (DAT-173)

How the delivery console's ticket tools are exposed to Databricks model
serving, and how the ticket-scoping flow became a tool-calling agent. This is
the first step toward the "delivery genie".

## The MCP surface

The console serves an MCP endpoint over the **Streamable HTTP** transport,
inside the app itself:

```
POST https://<app-url>/api/mcp        (JSON-RPC 2.0, stateless)
```

Tools (defined once in `server/routes/scoping-tools.ts`, JSON Schema shared
verbatim with the serving tool-calling loop):

| Tool | What it does |
|---|---|
| `search_tickets` | Keyword search over an engagement board (title + description, most recent first) |
| `get_ticket` | Full detail: description, AC, status, links, recent comments |
| `link_tickets` | Record `relates` / `blocks` / `blocked_by` between two board tickets |
| `consolidate_tickets` | Merge duplicate source tickets into a target: descriptions + AC fold in, links repoint, sources dismissed with a pointer comment |
| `submit_pr_review` | Publish a PR review verdict: comments on the pull request, comments on the ticket, flags the ticket on `escalate`. Never merges. (`server/routes/pr-review.ts`) |

The transport is stateless: no sessions, no server-initiated SSE. Each POST
carries one JSON-RPC message (or a batch); `initialize`, `ping`,
`tools/list` and `tools/call` are implemented in `server/routes/mcp.ts`.

## Why this counts as "registered in Databricks"

Databricks hosts custom MCP servers **as Databricks Apps** — an app URL behind
the workspace OAuth proxy is exactly what the agent tooling
(`databricks-mcp`'s `DatabricksMCPClient`, AI Playground, Mosaic AI agent
code) expects to connect to. The delivery console *is* a Databricks App, so
deploying it (CI on merge to `main`) is the registration: the MCP endpoint is
reachable at the app URL by any workspace principal granted access to the
app, authenticated with a workspace OAuth token — model serving endpoints
included. No separate gateway, secret, or long-lived token.

Connecting from agent code running on Databricks (e.g. inside a model
serving endpoint):

```python
from databricks.sdk import WorkspaceClient
from databricks_mcp import DatabricksMCPClient

MCP_URL = "https://<your-app>.databricksapps.com/api/mcp"
client = DatabricksMCPClient(server_url=MCP_URL, workspace_client=WorkspaceClient())
tools = client.list_tools()
```

Grant checklist for a serving endpoint (or any principal) that should use it:

1. The endpoint's service principal needs **Can use** on the
   `delivery-console` app (Apps → delivery-console → Permissions).
2. Nothing else — tool-level permissions are enforced by the console
   server-side (e.g. `consolidate_tickets` over REST is lead-gated; the MCP
   caller acts as whoever the token belongs to).

Quick reachability check from any workspace-authenticated shell:

```bash
TOKEN=$(databricks auth token --host https://<your-workspace>.cloud.databricks.com | jq -r .access_token)
curl -s -X POST "$MCP_URL" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Attaching an Agent Bricks agent (DAT-209)

The PR reviewer is an Agent Bricks agent, so it reaches the board the same way
any other workspace principal does — over this MCP endpoint.

1. **In Agent Bricks**, add a custom MCP server to the agent:

   ```
   https://<your-app>.databricksapps.com/api/mcp
   ```

   The same URL is on the Agent Map tab (/agent-map) — the New agent form and every
   endpoint-backed agent's detail popup show it with a copy button, resolved
   from the console you are looking at.

2. **Grant the agent's service principal `Can use`** on the `delivery-console`
   app (Apps → delivery-console → Permissions). Without it, `tools/list`
   returns the OAuth proxy's sign-in page instead of tools.

3. **Grant the console's service principal `CAN_QUERY`** on the agent's serving
   endpoint (Serving → the endpoint → Permissions). This is the other
   direction: it is how the console invokes the agent when a PR opens. Until it
   is granted, the agent node on the map reads `UNREACHABLE` and says why.

4. **Register the agent** on the Agent Map tab (/agent-map): New agent → Agent Bricks agent →
   the serving endpoint name → role **PR reviewer**. The node appears on that
   project's cluster with live endpoint status.

What the reviewer receives on each run is assembled by the console (ticket,
acceptance criteria, diff, CI status, and a `review_run_id`); the MCP tools are
there for anything else it wants to read, and for `submit_pr_review` if it
prefers to publish its own verdict rather than return JSON. Either path posts
exactly once — the console skips its own post if the tool already published
that run.

## The ticket-scoping agent

Ticket refinement (chatbox creation and the drawer's **Refine** action) no
longer runs a single-shot completion. `server/routes/scoping-agent.ts` drives
the workspace serving endpoint (`databricks-claude-sonnet-5`, already bound to
the app as the `serving-endpoint` resource with `CAN_QUERY`) through its
native tool-calling loop, passing the four board tools above. While planning
a new ticket the model can now:

- search the board and read related tickets, and fold what it learns into the
  plan (scope sharpening, dependency callouts);
- `link_tickets` to record relationships for the new ticket;
- `consolidate_tickets` to merge duplicates into the ticket being scoped.

Because the loop runs in the console process, the tools execute in-process
against Lakebase — the serving endpoint does not need to reach back over
HTTP for the creation flow. The MCP endpoint exposes the identical tool
contracts for out-of-process agents (AI Playground experiments, future
delivery-genie surfaces), so the two stay in lockstep by construction.

Failure ladder (per the repo's LLM standards — a model failure must never
fail the user's action):

1. board-aware tool loop (`refineTicketWithBoard`), max 8 tool rounds;
2. single-shot plan (`refinePlan`), the pre-DAT-173 behavior;
3. raw content with a derived fallback title.

The creation flow inserts the raw ticket row *before* refining so the agent's
link/consolidate calls have a real ticket key as their subject, then folds
the returned plan into the row in the same request. If the loop consolidated
tickets mid-flight, the merged "## Consolidated from" sections and AC are
carried across the description rewrite (`foldPlanIntoTicket` in `api.ts`).

## End-to-end verification

`server/routes/scoping-agent.test.ts` runs the full loop against pg-mem with
a scripted serving endpoint: a new ticket is created, the "model" searches
the board, reads a related ticket, links it, consolidates a duplicate, and
returns a plan that cites the board context — the test asserts the link row,
the dismissal + AC merge of the duplicate, and board context in the final
description. Run `npx vitest run server/routes/scoping-agent.test.ts`.

Against the live deployment, create a ticket via the chatbox on a board that
already has overlapping backlog tickets and check the drawer: linked tickets
appear under LINKED WORK, consolidated duplicates leave the board and their
AC show up on the new ticket, and the server log lines `[scoping]` /
`[api] <KEY> scoping actions:` list the tool calls the model made.
