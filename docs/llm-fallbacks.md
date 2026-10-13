# LLM-backed flows: deterministic fallbacks and failure signals

Every model call in the console goes through `invokeModel(role, request, ctx)`
in `server/routes/llm-health.ts`. Since phase 3 (platform-architecture §6)
the *role* — `planning`, `estimate`, `review` or `draft` — is resolved to the
workspace's configured provider and model (`server/llm/config.ts`, the
Admin page's *Model providers* section) and the call goes through that
provider's adapter (`server/llm/providers/`). Above the adapter nothing
changed from DAT-180: one retry on transient errors (network, 408/429/5xx),
failures categorized (auth / rate-limit / server / payload / network),
per-flow counters, and a throttled ⚠ feed item on the engagement when a
call fails.

The standing rule (see development standards, "LLM calls"): **a model failure
may degrade a feature but must never fail the user's action.** This table is
the contract for what each flow does when the model is down — or when no
provider is mapped to its role, which takes the same fallback with no retry
and no feed item (configuration, not an outage).

| Flow | Role | Trigger | Deterministic fallback when the model fails | Failure signal |
| --- | --- | --- | --- | --- |
| Ticket planning (`ticket-refine`) — chatbox create | `planning` | `POST /api/engagements/:id/tickets` with no title | Ticket is still created: title derived from the first words of the request (`fallbackTitle`), raw request as description, no AC, no estimate | ⚠ feed item + `[llm]` error log |
| Ticket refine button (`ticket-refine`) | `planning` | `POST /api/tickets/:key/refine` | Ticket left unchanged; user sees 502 "The planning model is unavailable — try again shortly" | 502 to user + ⚠ feed item + log |
| Comment-feedback rework (`comment-rework`) | `planning` | Comment on a never-picked-up ticket | Comment stays a plain comment; plan not updated; no agent reply in thread | ⚠ feed item + log (was silent before DAT-180) |
| Hours estimation (`estimate`) | `estimate` | Background after ticket create/refine | Ticket keeps no estimate (`est` stays `—` or the human-entered value) and is tagged `needs-estimate`; creation never blocks | ⚠ feed item + log (was silent before DAT-180) |
| Weekly status draft (`status-draft`) | `draft` | `POST /api/engagements/:id/draft` | Composer unchanged; user sees 502 "Draft generation failed" and can write the update by hand | 502 to user + ⚠ feed item + log |
| SOW plan extraction (`sow-parse`) | `planning` | `POST /api/sow/parse` | No plan is seeded; user sees 502 with the failure reason and can retry or create the engagement without a seeded plan | 502 to user + log (no engagement exists yet, so no feed) |
| Standards refine (`standards-refine`) | `planning` | `POST /api/engagements/:id/standards/refine` | Draft left untouched; user sees 502 "AI refine failed" | 502 to user + ⚠ feed item + log |
| PR review (`pr-review`) | `review` | A linked PR opens, or the manual re-run | `app.pr_reviews` row recorded as `failed`; the PR is left unreviewed for a human; nothing is approved, merged or moved | ⚠ feed item + log; 502 on the manual route |
| Workflow decision (`workflow-decide`) | `review` | A Decide node runs with provider `model`, or under `auto` after Jev and Databricks `ai_decide` were unavailable | The node's first choice wins with confidence 0; the run's step says `FALLBACK` and lists what was tried; the walk continues down that branch | run step detail + `[llm]` log |

A call is also **refused before it is made** when the mapped model cannot
meet the role's contract (no JSON output, no tool use when the request
carries tools, or a context window under the role's floor). That counts as a
`payload` failure with the gap in the message, posts the feed item, and takes
the flow's fallback above. The Admin page refuses such a mapping at save time
with the same message, so this is a belt-and-braces check.

## Checking model health

`GET /api/llm/health` reports every role for the caller's workspace — its
mapping, any contract gap, and a live probe (tiny prompt, ~30 s result cache
per role) for the configured ones — plus the per-flow counters:

```json
{
  "ok": true,
  "configured": true,
  "error": null,
  "roles": {
    "planning": {
      "configured": true,
      "provider": { "id": 3, "name": "Anthropic", "kind": "anthropic" },
      "model": "claude-sonnet-5",
      "contract": { "json": true, "tools": true, "contextTokens": 100000 },
      "contractGap": null,
      "probe": { "ok": true, "latencyMs": 850, "model": "claude-sonnet-5-20260101", "error": null, "at": "…", "cached": false }
    },
    "estimate": { "configured": false, "provider": null, "model": null, "contract": { "…": "…" }, "contractGap": null, "probe": null }
  },
  "flows": { "ticket-refine": { "calls": 12, "failures": 1, "consecutiveFailures": 0, "lastError": "…", "lastErrorCategory": "server", "…": "…" } }
}
```

Returns **200** when at least one role is configured and every configured
role answers, **503** otherwise (`error` says "no model provider configured"
when nothing is mapped) — suitable as an external monitor/uptime-check
target. `lastErrorCategory` answers the scaling-vs-auth-vs-payload question
directly the next time a provider misbehaves. The same probe is behind the
Admin page's status dots and the Test button
(`POST /api/settings/providers/:id/test`).

## Usage

Every successful call writes one row to `app.run_token_usage` with
`source = 'control-plane'`, the `provider`, `model`, `role`, and the
`ticket_key` / `engagement_id` the caller passed in `ctx` — so a ticket's
Token usage panel shows what it cost to plan as well as to build. Pass
`ticketKey` whenever the caller has one.

## Rules for new LLM flows

1. Call the model through
   `invokeModel('<role>', { messages, maxTokens, json?, tools? }, { flow: '<flow>', engagementId, ticketKey })` —
   never an adapter or a vendor SDK directly. Add the flow name to `LlmFlow`
   and its role to `FLOW_ROLES` in `llm-health.ts`; read `response.text`
   (and `response.toolCalls` for a tool loop).
2. Say `json: true` when the prompt asks for a JSON object — that is what the
   contract check and the adapters key on.
3. Keep a deterministic fallback in the caller's `catch` and add the flow to
   the table above.
4. Interactive flows reply 502 with a human-readable reason; background flows
   must rely on the feed item — a bare `console.warn` is not a signal anyone
   sees.
