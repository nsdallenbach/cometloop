# Workflows

Automations drawn as a graph. A workflow starts on a **trigger**, walks its
nodes, and records every run. Build them at `/workflows` (the list) and
`/workflows/:id` (the builder); the desktop shows the same pages in its
Workflows entry.

## The pieces

| Node | What it is | Types |
| --- | --- | --- |
| **Trigger** | What starts the workflow. A workflow may have several. | Ticket created · Ticket moved (into / from a lane) · Comment added (optionally containing a phrase) · Pull request opened · Pull request merged · Deploy finished (any / succeeded / failed) · Agent run finished (any / done / failed) · Ticket idle (N business days without activity, once per quiet period) · Schedule (hourly, daily, weekdays, weekly; UTC) · Run by hand. Every trigger can be limited to one project. |
| **Condition** | Picks an outcome; the connections out of it are labelled with the outcome they wait for (an unlabelled one always follows). | **Rule** — compare one field of the event (equals, contains, greater, is set…), outcomes `yes` / `no`. **Decide** — a decision model picks one of your choices from the event; the choices are the outcomes. |
| **Action** | Does something. | Move the ticket · Comment on the ticket · Assign the ticket · Tag the ticket · Notify someone · Post to the project feed · Call a webhook (POST JSON). |
| **Agent** | Queues the ticket for a coding agent, with instructions, optionally routed to one person's machine. A runner claims it like any other queued ticket. | Queue for an agent. |

Text fields are templates: `{{ticket.key}}`, `{{pr.title}}`, `{{comment.body}}`,
`{{idle.days}}`, `{{workflow.name}}`… The inspector lists what the workflow's
triggers carry. The catalog — every type, its fields and what it fills — is
one file shared by the server and the client: `shared/workflows/catalog.ts`.

## Decide: Jev and `ai_decide`

The Decide node sends the event (or a template over it) and one `choice`
question to a decision model and branches on the answer. Providers, tried in
order under **Auto**:

1. **Jev** (TypeSafe's System One) — `POST https://api.typesafe.ai/v1/systemone`
   with `TYPESAFE_API_KEY`. Answers with a choice, a probability per option
   and a confidence, usually in well under a second.
2. **Databricks `ai_decide()`** — the same kind of model as a SQL function,
   run on a SQL warehouse through the Statement Execution API. Needs the
   workspace service principal (`DATABRICKS_HOST` / `_CLIENT_ID` /
   `_CLIENT_SECRET`) and `DATABRICKS_WAREHOUSE_ID`.
3. **The configured model** — the workspace's `review` role through
   `invokeModel`, asked for a JSON object naming the choice.
4. **Fallback** — the first choice, confidence 0. The run's step says
   `FALLBACK` and lists what was tried. A decision model outage degrades a
   workflow; it never breaks one.

The inspector shows which of Jev and Databricks this deployment can reach.

## Running

- **Switching on** needs a runnable graph: at least one trigger, every
  node's fields complete, and every labelled connection out of a condition
  naming one of its outcomes. Drafts can be anything well-formed (known
  kinds, no loops). Leads and admins switch workflows on; anyone edits.
- **Events** come from the places that already know something happened:
  the ticket status trail (`recordTicketEvent`), the comment route, the repo
  sync (PR opened / merged), the agent completion route, the deploy
  recorder. `emitWorkflowEvent` is fire-and-forget and never throws.
- **Timed triggers** run from a per-tenant sweep every minute. A schedule
  fires once per period; an idle trigger fires once per (ticket, quiet
  period) — a comment or a move opens the next period.
- **Walk**: breadth-first from the trigger. A failed step fails the run and
  stops it; a node fed by two branches runs when first reached. A workflow
  whose action moves a ticket may trigger another workflow (or itself);
  nesting stops at depth 3.
- **Run now** starts from the manual trigger if there is one, else the first
  trigger, with an optional ticket as the subject. Leads and admins.
- **History**: `app.workflow_runs` holds every run with its trigger, subject
  (the ticket key), state, error and the step list (what each node did, which
  outcome a condition took, how long it took). The list page shows the last
  run and the week's tally per workflow plus the recent runs across all of
  them; a workflow's Runs tab shows its own.

## Routes

| Route | What |
| --- | --- |
| `GET /api/workflows` | the list, with `trigger`, `enabled`, `lastRun`, `runs7d` |
| `GET /api/workflows/providers` | `{ jev, databricks }` reachability |
| `GET /api/workflows/:id` · `POST /api/workflows` · `PUT /api/workflows/:id` · `DELETE /api/workflows/:id` | storage; `PUT` takes `enabled` and a `baseUpdatedAt` stale-save guard |
| `POST /api/workflows/:id/run` | Run now (`{ ticketKey? }`); replies with the finished run |
| `GET /api/workflow-runs?workflow=&limit=` · `GET /api/workflow-runs/:id` | history; the detail carries `steps` and the event `payload` |

## Environment

| Variable | Purpose |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev. `TYPESAFE_API_URL` and `TYPESAFE_MODEL` override the endpoint (`/v1/systemone`) and model (`jev-latest`). |
| `DATABRICKS_WAREHOUSE_ID` | With the workspace SP: Databricks `ai_decide()`. |
