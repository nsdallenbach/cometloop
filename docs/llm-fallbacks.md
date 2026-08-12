# LLM-backed flows: deterministic fallbacks and failure signals

Every model call in the console goes through `appkit.serving('default')` (the
workspace serving endpoint, `databricks-claude-sonnet-5`) — and, since
DAT-180, through `invokeModel()` in `server/routes/llm-health.ts`, which adds
one retry on transient errors (network, 408/429/5xx), categorizes failures
(auth / rate-limit / server / payload / network), keeps per-flow counters, and
surfaces a throttled ⚠ feed item on the engagement when a call fails.

The standing rule (see development standards, "LLM calls"): **a model failure
may degrade a feature but must never fail the user's action.** This table is
the contract for what each flow does when the model is down.

| Flow | Trigger | Deterministic fallback when the model fails | Failure signal |
| --- | --- | --- | --- |
| Ticket planning (`ticket-refine`) — chatbox create | `POST /api/engagements/:id/tickets` with no title | Ticket is still created: title derived from the first words of the request (`fallbackTitle`), raw request as description, no AC, no estimate | ⚠ feed item + `[llm]` error log |
| Ticket refine button (`ticket-refine`) | `POST /api/tickets/:key/refine` | Ticket left unchanged; user sees 502 "The planning model is unavailable — try again shortly" | 502 to user + ⚠ feed item + log |
| Comment-feedback rework (`comment-rework`) | Comment on a never-picked-up ticket | Comment stays a plain comment; plan not updated; no agent reply in thread | ⚠ feed item + log (was silent before DAT-180) |
| Hours estimation (`estimate`) | Background after ticket create/refine | Ticket keeps no estimate (`est` stays `—` or the human-entered value); creation never blocks | ⚠ feed item + log (was silent before DAT-180) |
| Weekly status draft (`status-draft`) | `POST /api/engagements/:id/draft` | Composer unchanged; user sees 502 "Draft generation failed" and can write the update by hand | 502 to user + ⚠ feed item + log |
| SOW plan extraction (`sow-parse`) | `POST /api/sow/parse` | No plan is seeded; user sees 502 with the failure reason and can retry or create the engagement without a seeded plan | 502 to user + log (no engagement exists yet, so no feed) |
| Standards refine (`standards-refine`) | `POST /api/engagements/:id/standards/refine` | Draft left untouched; user sees 502 "AI refine failed" | 502 to user + ⚠ feed item + log |

## Checking model health

`GET /api/llm/health` live-probes the serving endpoint (tiny prompt, ~30 s
result cache) and returns per-flow counters:

```json
{
  "ok": true,
  "endpoint": "default",
  "probe": { "latencyMs": 850, "at": "…", "cached": false, "error": null },
  "flows": { "ticket-refine": { "calls": 12, "failures": 1, "consecutiveFailures": 0, "lastError": "…", "lastErrorCategory": "server", "…": "…" } }
}
```

Returns **200** when the probe succeeds, **503** when it fails — suitable as
an external monitor/uptime-check target. `lastErrorCategory` answers the
scaling-vs-auth-vs-payload question directly the next time the endpoint
misbehaves.

## Rules for new LLM flows

1. Call the model through `invokeModel(serving, q, '<flow>', body, { engagementId, ticketKey })` —
   never `serving('default').invoke` directly. Add the flow name to `LlmFlow`.
2. Keep a deterministic fallback in the caller's `catch` and add the flow to
   the table above.
3. Interactive flows reply 502 with a human-readable reason; background flows
   must rely on the feed item — a bare `console.warn` is not a signal anyone
   sees.
