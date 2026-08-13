# Inter-Agent Coordination via Lakebase Postgres (DAT-149)

Multiple autonomous agents can work concurrently on different branches of the
same repository. This channel lets them signal each other about in-progress
work, conflicts and dependencies — backed by the console's Lakebase Postgres
database, so the coordination state is durable, concurrent-safe and auditable.

## Architecture

```
agent (devbox runner / Claude Code)
   │  delivery-console MCP tools, or plain HTTPS
   ▼
Databricks Apps OAuth proxy ──► console /api/agent/coordination/*
                                      │  appkit lakebase plugin
                                      ▼
                       Lakebase Postgres (project engagement-console)
                         app.coordination_messages   app.branch_activity
```

Agents do **not** open their own Postgres connections. They call the console's
HTTP API (authenticated by the Databricks Apps OAuth proxy, exactly like the
agent work-queue endpoints), and the console executes the SQL against Lakebase
through the appkit `lakebase()` plugin. This matches how everything else in
the console reaches the database, keeps the schema owned by the app's service
principal, and means there are zero per-agent database credentials to
provision or rotate. See the [connection pooling finding](#connection-pooling-finding)
for why this is also the right call operationally.

Every agent has an id: its runner name (`AGENT_NAME`, e.g. `devbox-7`,
`local-emu`) — the same id used across the agent work queue.

## Schema

Both tables live in the `app` schema of the Lakebase Postgres database
(`projects/engagement-console/branches/production`, database
`databricks-postgres`) and are created by the console's startup migration
(`initSchema` in `server/routes/api.ts`, statements in
`server/routes/coordination.ts`), like every other console table.

```sql
CREATE TABLE app.coordination_messages (
  id                 BIGSERIAL PRIMARY KEY,     -- doubles as the polling cursor
  sender_agent_id    TEXT NOT NULL,
  recipient_agent_id TEXT,                      -- NULL = broadcast to all agents
  branch_name        TEXT,
  ticket_key         TEXT,
  message_type       TEXT NOT NULL,             -- status_update | conflict_warning |
                                                -- request_for_info | handoff | poke | response
  sla                TEXT,                      -- interrupt | wait (see below)
  payload            JSONB NOT NULL DEFAULT '{}',  -- { body: "...", data?: {...} }
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX coordination_messages_created_at ON app.coordination_messages (created_at);
CREATE INDEX coordination_messages_recipient  ON app.coordination_messages (recipient_agent_id, id);

CREATE TABLE app.branch_activity (
  branch_name      TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  ticket_key       TEXT,
  task_description TEXT NOT NULL DEFAULT '',
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status           TEXT NOT NULL DEFAULT 'active'   -- active | completed
);
CREATE INDEX branch_activity_status ON app.branch_activity (status);
```

## API

All endpoints accept any workspace-authenticated caller (that is the point of
a shared channel). Client library functions live in
`server/routes/coordination.ts`; MCP tools in `mcp/server.mjs`.

| Action | HTTP | MCP tool |
|---|---|---|
| Post a message | `POST /api/agent/coordination/messages` | `post_coordination_message` |
| Poke an agent (targeted + SLA) | same, `type: "poke"` | `poke_agent` |
| Fetch new messages since cursor | `GET /api/agent/coordination/messages?agent=&since_id=` | `get_coordination_messages` |
| Announce / heartbeat a branch | `POST /api/agent/coordination/branches` | `announce_branch_activity` |
| List active branches | `GET /api/agent/coordination/branches` | `list_active_branches` |

Fetch returns `{ messages, next_since_id }`; pass `next_since_id` back on the
next call. With `agent` set, a fetch returns broadcasts plus messages
addressed to that agent, excluding its own.

Posting and announcing additionally require the sender's `coordination` scope
in its per-agent security settings (DAT-212), checked against the engagement of
the claim it is working. A denied write answers 403 with the reason; reads are
never gated. See the per-agent security section in
[architecture.md](./architecture.md).

## Protocol

- **Announce before you work.** When a run starts, the agent checks
  `list_active_branches` for overlapping work, then upserts its own branch
  into `branch_activity`. Re-announcing the same branch is the heartbeat.
  When the run completes, the console's completion endpoint automatically
  marks the agent's branches `completed` and broadcasts a final
  `status_update` — so activity never leaks even if the agent forgets.
- **Attention without deadlock.** A message can target a `recipient` and
  carry an `sla`:
  - `interrupt` — the recipient should answer before continuing its work.
    Use only when actually blocked.
  - `wait` — the recipient should answer before completing its ticket, and
    may otherwise keep working.
  The requesting agent never blocks on a reply synchronously; it polls its
  inbox at its next checkpoint. An agent must not complete its task while an
  unanswered `interrupt` addressed to it is pending. Because pokes are
  asynchronous and the SLA tells the receiver how to prioritize against its
  own queue, two agents poking each other cannot mutually block.
- **Human review.** Targeted messages are mirrored as an `@recipient` comment
  on the ticket the recipient is actively working (or has in review) — the
  exchange reads like developers talking on each other's tickets and is
  reviewable from the board. The Lakebase table remains the durable source of
  truth; mirroring is best-effort.
- The rendered agent prompt (`renderPrompt` in `server/routes/agent-work.ts`)
  instructs every agent in this protocol, so it applies fleet-wide without
  devbox updates.

## New-message detection: polling, not LISTEN/NOTIFY

**Decision: indexed cursor polling.** `id BIGSERIAL` is the cursor; each poll
runs `WHERE id > $last ORDER BY id LIMIT n` against the primary key /
`(recipient_agent_id, id)` index — incremental, never a table scan.

`LISTEN/NOTIFY` was considered and rejected for this workload:

1. Each listener needs a dedicated, long-lived Postgres connection. Lakebase
   is serverless with scale-to-zero (5-minute default): a fleet of idle
   listener connections either keeps the endpoint awake (paying for idle
   compute) or gets dropped when it suspends.
2. Lakebase database credentials are OAuth tokens that expire after ~1 hour,
   and idle connections are reaped after 24 h — listeners must reconnect
   regularly, and `NOTIFY` is fire-and-forget: anything sent while a listener
   is reconnecting is silently lost. A durable cursor over an append-only
   table misses nothing by design.
3. Agents reach the store through the console's HTTP API, not raw Postgres,
   so a Postgres-level push channel would not reach them anyway.

Agents poll at natural checkpoints (post-plan, pre-push, pre-complete), which
is the cadence that matters for cross-branch coordination. If lower latency
is ever needed, the right lever is a long-poll HTTP endpoint in the console
(the pattern `/api/agent/work/wait` already uses), not LISTEN/NOTIFY.

## Connection pooling finding

**Question (raised on the ticket): do we need client-side connection pooling
for Databricks Lakebase Postgres?**

**Finding: no new pooling should be added anywhere in this design.**

- **Agents: no pooling — they hold no database connections at all.** Agents
  call the console over HTTPS; the only Postgres client in the system is the
  console app itself.
- **Console: pooling already exists and is owned by the platform.** The
  appkit `lakebase()` plugin manages the app's Lakebase connection lifecycle,
  including the OAuth credential refresh that plain Postgres poolers get
  wrong (Lakebase passwords are OAuth tokens that expire after ~1 hour, so a
  naive long-lived pool starts failing auth on new connections within an
  hour). Adding a second pool (pgbouncer, `pg.Pool`, SQLAlchemy pooling)
  in front of it would be redundant and would re-introduce exactly the
  token-expiry and idle-connection problems the plugin already solves.
- **Lakebase's own behavior makes ad-hoc client pools a liability, not an
  optimization:** scale-to-zero suspends the endpoint after idle periods
  (reconnects wake it in ~100 ms — handle with a connect retry, not a warm
  pool), idle connections are dropped after 24 h, and connection headroom
  scales with provisioned CU. For this workload — a handful of agents doing
  short, occasional reads/writes through one app — connection acquisition is
  nowhere near a bottleneck.

**Driver / connection recommendation:**

| Runtime | Recommendation |
|---|---|
| Agents (any runtime) | Console HTTP API via MCP tools — no driver, no pooling, OAuth handled by the Apps proxy |
| Console (Node, this repo) | appkit `lakebase()` plugin — keep as-is, no extra pool |
| Off-platform Node scripts | `@databricks/lakebase` (handles token refresh); short-lived connections, `sslmode=require` |
| Python scripts / jobs | `psycopg` 3, fresh OAuth credential per run (`databricks postgres generate-database-credential`), no long-lived pool |

## Retention & audit

`coordination_messages` is append-only: nothing deletes rows — polling reads
by cursor, and completion only inserts. The full message history stays
queryable in Lakebase (`ORDER BY created_at`, indexed) for audit and
debugging. No TTL is applied by default; if volume ever warrants it, the
agreed options are (a) a scheduled archival job copying rows older than N
months to a Unity Catalog Delta table (Lakehouse sync), or (b) a plain
`DELETE WHERE created_at < NOW() - INTERVAL 'N months'` after export. That
decision is explicitly deferred per the ticket.

`branch_activity` rows are likewise retained (`status = 'completed'`) as a
history of who worked which branch.

## Testing

- `server/routes/coordination.test.ts` — runs the library's real SQL (schema,
  upserts, cursor fetches, ticket-comment mirroring) against pg-mem, an
  in-memory Postgres engine, including a full two-agent round-trip
  (request → fetch → response → fetch) with audit assertions:
  `npx vitest run server/routes/coordination.test.ts`
- `scripts/coordination-roundtrip.mjs` — replays the same two-agent scenario
  against the **live** deployed console (and therefore real Lakebase
  Postgres): `node scripts/coordination-roundtrip.mjs`. Uses `DATABRICKS_TOKEN`
  or the Databricks CLI for auth, like the devbox runner.
- [coordination-drill-log.md](./coordination-drill-log.md) — results of live
  drills run with real concurrent agent runners (e.g. DAT-182), one entry per
  drill.
