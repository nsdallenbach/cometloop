# Delivery Console MCP server

Exposes the Delivery Console to AI tooling over MCP (stdio): boards, tickets,
comments, the agent work queue, git credential vending and context files.
This is how a devbox Claude Code instance comments on tickets, moves them,
creates them, and drives its own work lifecycle.

## Setup

Requires Node 18+ and either a pre-minted OAuth token or the Databricks CLI
authenticated against the workspace.

```bash
cd mcp && npm install

# register with Claude Code (from anywhere):
claude mcp add delivery-console -- node /path/to/engagement-console/mcp/server.mjs
```

This repo also ships a project-level `.mcp.json`, so Claude Code sessions
inside the repo pick the server up automatically.

Environment (all optional):

| Var | Default | Purpose |
|---|---|---|
| `DELIVERY_CONSOLE_URL` | the deployed app URL | Console base URL |
| `DATABRICKS_HOST` | workspace URL | Host for CLI token minting |
| `DATABRICKS_TOKEN` | — | Pre-minted OAuth token (skips the CLI) |
| `DATABRICKS_CLI` | `databricks` | CLI binary path override |

## Tools

**Read**: `list_engagements`, `get_board`, `get_ticket`,
`list_context_files`, `read_context_file`

**Tickets**: `create_ticket`, `move_ticket`, `assign_ticket`,
`comment_on_ticket`

**Attachments**: `list_ticket_attachments`, `attach_file_to_ticket`,
`read_ticket_attachment`, `delete_ticket_attachment` (lead only; uploads are
capped at 25 MB and executable file types are rejected)

**Queue (lead)**: `queue_ticket_for_agent`, `cancel_agent_work`,
`complete_agent_work`

**Runner lifecycle (devbox)**: `get_agent_queue`, `claim_agent_work`,
`report_agent_progress`, `finish_agent_work`, `get_git_credential`

Permissions are enforced server-side by the console (lead-gated actions fail
with a clear error for non-leads); the MCP server adds no privileges of its
own — it acts as whoever the Databricks token belongs to.

## Devbox loop over MCP

A devbox Claude Code session with this server can run the whole loop without
shell scripts: `claim_agent_work` → read the returned work package and
`read_context_file` for references → `get_git_credential` to clone/push →
`report_agent_progress` as it works → `finish_agent_work` when done.
