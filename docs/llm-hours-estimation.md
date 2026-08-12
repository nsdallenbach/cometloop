# LLM-hours estimation (DAT-120, DAT-175, DAT-195)

Every ticket gets an estimate of **actual LLM working time in hours** (one
decimal place, e.g. `2.5h`). Model-produced estimates come from the Databricks
model serving endpoint the console already uses for planning
(`serving('default')`, bound to `DATABRICKS_SERVING_ENDPOINT_NAME`).

Since DAT-195 both `tickets.est_hours` and `tickets.human_est_hours` are
**mandatory** (`NOT NULL`, enforced by the create/patch endpoints and the UI):
creation requires caller-supplied values for both, estimates can be revised
but never cleared, and tickets that predated the rule were backfilled by
`scripts/dev-migrate.cjs` (hour-suffixed `est` labels parsed, everything else
defaulted to 1h/4h and tagged `needs-estimate-review`).

Since DAT-175 the same model call also returns a **human-developer estimate**
(`tickets.human_est_hours`) — an independently reasoned figure for the same
scope done by a human (not a fixed multiplier), shown in the ticket drawer as
"Human dev estimate" next to the agent estimate. The agent-hours prompt is
calibrated to Claude Code execution (anchors from ~0.1h for a config tweak to
3–8h for multi-system work). If the model omits the human figure, the code
falls back to 4× the calibrated agent estimate (`HUMAN_FALLBACK_RATIO`); the
same ratio backfills pre-existing tickets via `scripts/dev-migrate.cjs`.
Calibration factors only ever apply to the agent estimate, because actuals
are measured from agent runs.

## Flow

1. **Estimates at creation are caller-supplied (DAT-195)** — ticket creation
   (`POST /api/engagements/:id/tickets`) requires `estHours` and
   `humanEstHours` (> 0) in the body; the console's New Ticket modal and the
   stdio MCP `create_ticket` tool both collect them. The model no longer
   estimates at creation — human-entered figures must not be clobbered. A
   **Refine** re-plans the scope, so it does re-estimate (`kind = 'revised'`,
   written to `tickets.est` / `tickets.est_hours` with a full record — raw
   model hours, calibration applied, confidence, rationale — appended to
   `app.ticket_estimates`), as does the DAT-197 estimate backfill endpoint
   (`POST /api/engagements/:id/estimates/backfill`).
2. **Log actuals at ready-for-review** — whenever a ticket transitions into
   Review (agent `complete` with outcome `done`, the board's queue/complete
   drag, a status `PATCH`, or a bulk move), the actual agent time is computed
   as the sum of the ticket's `agent_tasks` run durations (claim →
   completion; claim → now for a run still active) and stored on the ticket
   and on its latest estimate row, and the estimate-vs-actual comparison is
   posted to the engagement feed.
3. **Refine going forward (per engagement)** — each new estimate is multiplied
   by a per-engagement **calibration factor**: the median `actual / estimate`
   ratio across that engagement's completed estimates. It needs at least 3
   samples to move off 1.0 and is clamped to [0.3, 3]. The most recent
   estimate-vs-actual pairs are also included in the prompt as few-shot
   examples, so the model grounds new estimates in the project's real
   velocity.

## Accuracy endpoint

`GET /api/engagements/:id/estimate-accuracy` returns every estimate row for
the engagement plus a summary: completed sample count, the calibration factor
currently in effect, and the mean absolute percentage error of past
estimates.

## Schema

- `app.ticket_estimates` — one row per estimate (initial or revised), with
  `actual_hours` / `actual_source` / `actual_recorded_at` filled when the
  ticket reaches Review.
- `app.tickets.est_hours`, `app.tickets.actual_hours` — latest values
  denormalized onto the ticket for the board and drawer.

## Vector search (explored, deferred)

Databricks Vector Search could replace the "most recent completed tickets"
few-shot selection with true similarity retrieval: index completed tickets'
title + description embeddings per engagement and pull the k most similar
completed tickets (with their estimate-vs-actual outcomes) into the prompt.
That needs a Vector Search endpoint + Delta sync index provisioned in the
bundle, which is out of scope while the history per engagement is small —
recency plus the calibration factor gives most of the benefit today. The
`estimateTicket` prompt assembly in `server/routes/estimates.ts` is the single
place to swap the example-selection strategy when history grows.
