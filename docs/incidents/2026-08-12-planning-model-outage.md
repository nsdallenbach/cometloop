# Incident: planning model outage (intermittent), 2026-08-11 → 2026-08-12

**Ticket:** DAT-180 · **Status:** resolved (service recovered without intervention); safeguards shipped in the DAT-180 PR
**Impact:** all LLM-backed flows — chatbox ticket planning, Refine, comment-feedback rework, hours estimation, weekly status drafts, SOW parsing, standards refine
**Service:** Databricks workspace model serving endpoint `databricks-claude-sonnet-5`, reached via `appkit.serving('default')` — a managed workspace dependency, not self-hosted

## What happened

During the evening of 2026-08-11 (ET), planning-model calls failed
intermittently. User-visible symptoms: the Refine button returned "The
planning model is unavailable — try again shortly" (502), and chatbox-created
tickets silently landed **unplanned** (fallback title, raw description, no
acceptance criteria, no estimate). Background flows — comment-feedback rework
and hours estimation — failed with no user-visible signal at all. By late
evening (ticket comment, 2026-08-12 03:11 UTC / 2026-08-11 23:11 ET) the
model was responding again. No code was rolled back or changed to restore
service.

## Timeline (ET; from git history and ticket records)

| Time | Event |
| --- | --- |
| 2026-08-10 ~23:17 | First LLM planning flow ships (DAT-124 chatbox ticket creation); DAT-135 Refine follows ~23:56 |
| 2026-08-11 daytime | Remaining LLM flows land: comment rework (DAT-150), standards refine (DAT-148), hours estimation (DAT-120) |
| 2026-08-11 21:46–23:57 | Merge train: ~15 merges to `main`, each triggering a CI deploy that restarts the app (~1 min of 502s per deploy) |
| 2026-08-11 evening | Users observe "planning model is down": Refine 502s, unplanned chatbox tickets. DAT-180 filed |
| 2026-08-11 23:11 (03:11 UTC 08-12) | Lead confirms on DAT-180 the outage was intermittent and the model is responding again |
| 2026-08-12 | This RCA + safeguards implemented (DAT-180 PR) |

## Root cause

**Primary (assessed): transient unavailability of the serving endpoint.**
The service failed and recovered with no app-side change, which rules out a
code regression or bad deploy as the primary cause. The failure pattern
(intermittent, self-recovering) is consistent with endpoint-side transients —
capacity/scaling (429/5xx) or short-lived auth-token blips.

**Definitive endpoint-side classification (scaling vs auth vs payload) could
not be completed from this runner**: the agent environment has no Databricks
CLI/credentials, so serving-endpoint logs and metrics were out of reach. That
verification is a follow-up (below). Critically, the app also kept no record
of *its own* failures beyond transient `console.warn` lines, which is why
this RCA has to reason from symptoms — the instrumentation shipped with this
ticket makes the next incident self-classifying.

**Contributing causes (confirmed in code):**

1. **Single-attempt model calls.** Every flow called
   `serving('default').invoke` exactly once. Any transient error — including
   a single 429 or a connection reset — escalated straight to a user-visible
   failure or a silent degradation. No retry, no timeout, no accounting.
2. **Silent fallbacks in background flows.** Chatbox planning, comment
   rework, and estimation caught failures and fell back with only a
   `console.warn`. Nobody sees app-container logs in normal operation, so the
   outage was only noticed when a human happened to hit an interactive 502 —
   this is the detection gap that made the outage "silent".
3. **Deploy churn overlapped the window.** Each of the ~15 merges that
   evening restarted the app (~1 min of 502s each, per the development
   standards). Some of what was perceived as "the planning model is down" was
   likely app restarts, indistinguishable to users from model failure — and
   indistinguishable in retrospect because nothing was recorded.

## Detection gap

- No health check existed for the serving endpoint — no way to answer "is
  the model up right now?" without manually exercising a feature.
- No persistent failure record — `console.warn` only.
- No user-facing signal for background-flow failures.

## Remediation (shipped in the DAT-180 PR)

1. **Shared reliability wrapper** (`server/routes/llm-health.ts`): all six
   LLM call sites now go through `invokeModel()`, which retries once on
   transient errors (network/408/429/5xx; never auth/payload), categorizes
   every failure (auth / rate-limit / server / payload / network), and keeps
   per-flow counters (calls, failures, consecutive failures, last error).
2. **Failure surfacing:** when a refine/rework/estimate/draft/standards call
   fails, a ⚠ feed item is posted on the engagement (throttled to one per
   flow per 10 minutes) naming the flow, ticket, and error category — model
   failures are never silent again.
3. **Health endpoint:** `GET /api/llm/health` live-probes the endpoint
   (200/503, ~30 s cache) and reports the per-flow counters. Suitable as an
   uptime-monitor target.
4. **Fallback contract documented:** `docs/llm-fallbacks.md` records the
   deterministic fallback and failure signal for every LLM-backed flow, plus
   the rules for adding new ones.

## Recommended follow-ups

1. **Endpoint-side verification** (needs workspace access): pull serving
   endpoint logs/metrics for 2026-08-11 18:00–24:00 ET
   (`databricks serving-endpoints logs` / the endpoint's metrics UI) and
   confirm the transient class — scaling, auth, or payload. Attach findings
   to DAT-180.
2. **Point an external uptime monitor at `/api/llm/health`** so endpoint
   failures page someone instead of waiting for a user report; route alerts
   per the on-call process (owner to confirm routing).
3. **Batch merges outside working sessions** (already a standards rule:
   "deploys blink") — the merge-train pattern amplified perceived downtime.
4. **Consider queue-and-replan for chatbox tickets** created during an
   outage: a ticket created unplanned currently stays unplanned unless
   someone presses Refine; the feed item now at least makes those visible.
5. **Consider a circuit breaker** if sustained endpoint outages recur
   (skip the model fast after N consecutive failures instead of paying the
   retry latency on every call) — `consecutiveFailures` in the health state
   is the input for this.
