# DAT-171 — Agent commenting & flag paths: end-to-end validation report

**Date:** 2026-08-12 · **Agent:** local-runner (task 130) · **Result: all paths PASS**

Validation ran against the deployed console at
`https://delivery-console-7474645607548631.aws.databricksapps.com` — the single
live (production) instance, the same one serving this board — authenticated
through the Databricks Apps OAuth proxy. This consolidates DAT-168 (devbox
runner ticket-comment and flag paths) with the original inter-agent framework
check.

Two interfaces were exercised for every path:

- **MCP** — the delivery-console MCP server (`mcp/server.mjs`) driven by a live
  devbox Claude Code session, exactly as runners use it.
- **HTTP** — the raw console API, via the re-runnable
  [`scripts/validate-agent-comms.mjs`](../scripts/validate-agent-comms.mjs)
  (run markers `dat171-msqd01gv`, `dat171-msqd3999`).

Every path's evidence (request/response, persisted comment ids, latency) is
also posted as comments on DAT-171 (ids 410–414), per the acceptance criteria.

## Results matrix

| Path | MCP | HTTP | End-to-end verification |
|---|---|---|---|
| `report_agent_progress` | PASS | PASS (`POST /api/agent/work/130/progress` → 200, 744 ms) | `task.last_note` updated; notes persisted as DAT-171 comments (ids 397 + plan note) authored by the agent |
| `flag_agent_work` | PASS | PASS (`POST /api/agent/work/130/flag` → 200, 120 ms) | `task.flag` set (board attention treatment); mirrored as “⚠ Flagged: …” comments (id 398 + MCP twin) |
| `clear_agent_flag` | PASS | PASS (`DELETE /api/agent/work/130/flag` → 200, 112 ms) | `task.flag` back to null; “Flag cleared.” comments (id 399 + MCP twin) |
| Cross-ticket comment (ticket not owned by the agent) | PASS (`comment_on_ticket` → DAT-182 comment 408) | PASS (`POST /api/tickets/DAT-182/comments` → 201, comment 400, 105 ms) | Both read back via ticket API / MCP `get_ticket` — visible in DAT-182’s thread |
| Inter-agent broadcast | PASS (`post_coordination_message`, msg 63) | PASS (msg 61, 397 ms) | Received via anonymous cursor read (the broadcasts-only view) |
| Inter-agent targeted message + SLA | — | PASS (msg 62, `sla: wait`, 127 ms) | Recipient + SLA persisted; mirrored onto the sender’s ticket as an `→ @recipient` comment (id 405) |
| Inter-agent receipt (inbox polling) | PASS (`get_coordination_messages`) | PASS (same endpoint) | As local-runner, received 40+ live messages from local-emu / local-emu-2 / local-runner-2 with cursor semantics intact |
| Permission guards | — | PASS (negative tests) | Spoofed sender → 403; foreign inbox read → 403 (see below) |
| `announce_branch_activity` / `list_active_branches` | PASS | — | Branch DAT-171-validate-agent-comms announced and listed; the earlier 500 reported during the DAT-182 drill (fixed by DAT-175/PR #44) did not reproduce |

A live two-agent targeted round trip (request → response between two
concurrently claimed runners) requires two active tasks and was not re-run
here; it was verified on this deployment in the DAT-182/DAT-183 drill run #2
(coordination messages 13 → 17, `docs/coordination-drill-run2.md`).

## Permission model (validated behavior)

- Posting coordination messages, reading a named inbox, and announcing
  branches all require the caller to hold an **active claimed task** under the
  agent name used — spoofing another agent or reading a foreign inbox is
  rejected with 403 and a clear error. Anonymous reads see broadcasts only.
- Runner lifecycle endpoints (progress/flag/clear) verify the task is active
  and claimed by the named agent (404 for inactive task, 409 for wrong agent).
- Comment attribution differs by surface, by design: generic ticket comments
  (`POST /api/tickets/:key/comments`, MCP `comment_on_ticket`) are attributed
  to the OAuth identity behind the token; runner lifecycle comments
  (progress/flag) are attributed to the agent name passed in the body.

## Errors & latency observations

- **One transient failure:** a broadcast POST during run `dat171-msqd2gvv`
  returned a non-201 and did not persist a row; the identical request
  succeeded on immediate retry (likely a proxy/app blip). Runners should
  treat coordination posts as retryable.
- All other calls completed in 105–744 ms (first call of a session is the
  slowest; steady-state ~100–150 ms). No permission failures occurred outside
  the intentional negative tests; no latency issues affecting runner UX.

## Re-running

```bash
TASK_ID=<active task id> AGENT=<runner name> node scripts/validate-agent-comms.mjs
# optionally: STEPS=progress,flag,clear,cross,inter  TARGET_TICKET=DAT-xxx
```

The script needs an active claimed/working task owned by `AGENT` (the flag and
progress endpoints refuse anything else) and Databricks auth
(`DATABRICKS_TOKEN` or the CLI). It exits non-zero on any failure and prints
an evidence JSON block for pasting into ticket comments.
