# LLM-hours estimation (DAT-120, DAT-175, DAT-195, DAT-207)

Every ticket gets an estimate of **actual LLM working time in hours** (one
decimal place, e.g. `2.5h`). Model-produced estimates come from the Databricks
model serving endpoint the console already uses for planning
(`serving('default')`, bound to `DATABRICKS_SERVING_ENDPOINT_NAME`).

Both `tickets.est_hours` and `tickets.human_est_hours` are **mandatory on the
row** (`NOT NULL` since DAT-195) but **not on the caller**: since DAT-207 the
ticket agent populates them and the human never has to. Estimates can be
revised but never cleared, and tickets that predated the rule were backfilled
by `scripts/dev-migrate.cjs` (hour-suffixed `est` labels parsed, everything
else defaulted to 1h/4h and tagged `needs-estimate-review`).

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

1. **The agent estimates at creation (DAT-207)** — `estHours` and
   `humanEstHours` are optional on `POST /api/engagements/:id/tickets`
   (supply both or neither; a lone figure is rejected). When they are omitted
   — the console's New Ticket modal and the stdio MCP `create_ticket` tool
   both omit them by default — the row lands with provisional 1h/4h and the
   `needs-estimate-review` tag, then `ensureTicketHours`
   (`server/routes/ticket-hours.ts`) runs the estimation agent **within the
   request** and clears the tag once real hours exist. Because every create
   path (app, MCP, direct API) goes through that one endpoint, they all get
   the same population and the same validation. Caller-supplied figures are
   still the values of record and skip the agent entirely — DAT-195's
   "never clobber human input" rule holds for callers that do have numbers.
   A **Refine** re-plans the scope, so it does re-estimate
   (`kind = 'revised'`, written to `tickets.est` / `tickets.est_hours` with a
   full record — raw model hours, calibration applied, confidence, rationale
   — appended to `app.ticket_estimates`), as does the DAT-197 estimate
   backfill endpoint (`POST /api/engagements/:id/estimates/backfill`).
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

## Missing-hours validation (DAT-207)

A ticket is never persisted silently incomplete. `needs-estimate-review` is
the single visible flag: it goes on at insert whenever the caller supplied no
estimates, comes off only when the agent produced real hours, and shows up as
`NO EST` in warn colour on the board card and the ticket table plus a tag chip
in the drawer. A failed estimation also logs `[hours]` and posts an engagement
feed item.

- `GET /api/engagements/:id/tickets/missing-hours` — the standing check:
  every non-dismissed ticket whose hours are absent, non-positive, or still
  flagged.
- `POST /api/engagements/:id/tickets/missing-hours/backfill` (lead) — re-runs
  the same populate/validate routine over that list in the background, for
  tickets that landed while the serving endpoint was down.

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
