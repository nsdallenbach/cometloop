# LLM-hours estimation (DAT-120)

Every ticket gets an automatic estimate of **actual LLM working time in hours**
(one decimal place, e.g. `2.5h`), produced by the Databricks model serving
endpoint the console already uses for planning (`serving('default')`, bound to
`DATABRICKS_SERVING_ENDPOINT_NAME`).

## Flow

1. **Estimate at creation** — when a ticket is created through the console
   (`POST /api/engagements/:id/tickets`), the estimation agent reviews the
   title, description and acceptance criteria in the background and writes the
   estimate to `tickets.est` / `tickets.est_hours`, with a full record
   (raw model hours, calibration applied, confidence, rationale) appended to
   `app.ticket_estimates`. Ticket creation never waits on, or fails with, the
   model. A **Refine** re-plans the scope, so it also re-estimates
   (`kind = 'revised'`).
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
