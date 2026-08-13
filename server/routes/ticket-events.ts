/**
 * Ticket status event trail: every status transition on app.tickets is
 * persisted with a timestamp in app.ticket_events, either via setTicketStatus
 * (status-only mutation sites) or recordTicketEvent (sites that run their own
 * UPDATE/INSERT and already know the before/after states). The trail feeds the
 * per-engagement burndown chart; computeBurndown replays it into a daily
 * open/done series.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Baseline events for tickets that predate the trail (or slipped past a
 * recording site): a synthetic creation event at the engagement's creation
 * time, so burndown replay always starts from a known state. Idempotent —
 * runs on every boot and after demo seeding.
 */
export const TICKET_EVENTS_BACKFILL_SQL = `
  INSERT INTO app.ticket_events (ticket_key, engagement_id, from_status, to_status, created_at)
  SELECT t.key, t.engagement_id, NULL, t.status, COALESCE(e.created_at, NOW())
  FROM app.tickets t
  LEFT JOIN app.engagements e ON e.id = t.engagement_id
  WHERE NOT EXISTS (SELECT 1 FROM app.ticket_events ev WHERE ev.ticket_key = t.key)`;

export const TICKET_EVENTS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.ticket_events (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    engagement_id TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS ticket_events_engagement_idx ON app.ticket_events (engagement_id, created_at)`,
  TICKET_EVENTS_BACKFILL_SQL,
];

/** Persist one transition. The trail must never break the mutation it records. */
export async function recordTicketEvent(
  q: Query,
  ticketKey: string,
  engagementId: string,
  fromStatus: string | null,
  toStatus: string,
): Promise<void> {
  if (fromStatus === toStatus) return;
  try {
    await q(`INSERT INTO app.ticket_events (ticket_key, engagement_id, from_status, to_status) VALUES ($1,$2,$3,$4)`, [
      ticketKey,
      engagementId,
      fromStatus,
      toStatus,
    ]);
  } catch (err) {
    console.warn(`[events] failed to record ${ticketKey} ${fromStatus ?? 'new'} → ${toStatus}:`, (err as Error).message);
  }
}

/**
 * Set a ticket's status (optionally the assignee too, optionally guarded on
 * the current status/assignee) and record the transition. Returns true when a
 * row was updated.
 */
export async function setTicketStatus(
  q: Query,
  key: string,
  status: string,
  opts: { assignee?: string; onlyIfStatus?: string; onlyIfAssignee?: string } = {},
): Promise<boolean> {
  const conds = ['key = $1'];
  const params: unknown[] = [key, status];
  if (opts.onlyIfStatus !== undefined) {
    params.push(opts.onlyIfStatus);
    conds.push(`status = $${params.length}`);
  }
  if (opts.onlyIfAssignee !== undefined) {
    params.push(opts.onlyIfAssignee);
    conds.push(`assignee = $${params.length}`);
  }
  // done_at stamps on entering Done and clears on leaving it (CASE without
  // ELSE yields NULL) — centralized here so every status path agrees.
  let set = `status = $2, done_at = CASE WHEN $2 = 'done' THEN COALESCE(t.done_at, NOW()) END`;
  if (opts.assignee !== undefined) {
    params.push(opts.assignee);
    set += `, assignee = $${params.length}`;
  }
  const { rows } = await q(
    `WITH prev AS (SELECT key, engagement_id, status FROM app.tickets WHERE ${conds.join(' AND ')})
     UPDATE app.tickets t SET ${set} FROM prev WHERE t.key = prev.key
     RETURNING t.key, t.engagement_id, prev.status AS prev_status`,
    params,
  );
  const row = rows[0];
  if (!row) return false;
  await recordTicketEvent(q, String(row.key), String(row.engagement_id), String(row.prev_status), status);
  return true;
}

// ---------- burndown series ----------

export interface TicketEvent {
  ticketKey: string;
  toStatus: string;
  /** ISO timestamp; events must arrive ordered by this. */
  createdAt: string;
}

export interface BurndownDay {
  date: string;
  open: number;
  done: number;
  total: number;
}

/** Board statuses that count as remaining work; proposed/dismissed sit outside
 *  the board. Deploying counts as open — approved is not shipped. */
const OPEN_STATUSES = new Set(['backlog', 'progress', 'review', 'deploying']);

/** Longest series returned; older days collapse into the opening snapshot. */
const MAX_DAYS = 366;

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Replay the event trail into an end-of-day open/done series from the first
 * event through `today` (YYYY-MM-DD). Empty trail (no tickets yet) → empty
 * series; a freshly created engagement yields a single day.
 */
export function computeBurndown(events: TicketEvent[], today: string): BurndownDay[] {
  if (events.length === 0) return [];
  const status = new Map<string, string>();
  let first = events[0].createdAt.slice(0, 10);
  const end = today >= first ? today : first;
  // Clamp runaway ranges (bad clocks, ancient backfills) to the trailing year.
  const minFirst = new Date(new Date(`${end}T00:00:00Z`).getTime() - (MAX_DAYS - 1) * 86400000).toISOString().slice(0, 10);
  if (first < minFirst) first = minFirst;

  const days: BurndownDay[] = [];
  let i = 0;
  for (let d = first; d <= end; d = nextDay(d)) {
    while (i < events.length && events[i].createdAt.slice(0, 10) <= d) {
      status.set(events[i].ticketKey, events[i].toStatus);
      i++;
    }
    let open = 0;
    let done = 0;
    for (const s of status.values()) {
      if (OPEN_STATUSES.has(s)) open++;
      else if (s === 'done') done++;
    }
    days.push({ date: d, open, done, total: open + done });
  }
  return days;
}
