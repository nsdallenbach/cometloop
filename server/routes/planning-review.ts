/**
 * Planning-agent review status (DAT-218).
 *
 * The planning agent (server/routes/scoping-agent.ts, plus the comment-driven
 * rework in api.ts) rewrites a ticket's title, description, acceptance criteria
 * and estimates while a team member may be looking straight at it. Until now
 * that happened invisibly: the board card and the drawer just changed under
 * you, with no way to tell a pass was in flight.
 *
 * `app.planning_reviews` is that missing bit of state — one row per ticket
 * currently under review, written when a pass starts and deleted when it ends.
 * Two properties matter:
 *
 *  - **It self-heals.** Every row carries `expires_at`; readers only count a
 *    row while `expires_at > NOW()`. An explicit clear in a `finally` covers
 *    the normal and thrown paths, and the TTL covers the ones a `finally`
 *    cannot — the process being killed mid-pass, a model call that never
 *    settles. A stuck badge is worse than a missing one, so the clock always
 *    wins eventually.
 *  - **It is its own table.** `app.tickets` is owned by the developer role, so
 *    boot-time `ALTER`s on it are rejected (see docs/development-standards.md)
 *    and a new column there could not ship without a dev-migrate run landing
 *    first. A fresh table is created by the app's service principal at boot, so
 *    the flag works the moment the deploy is live. No foreign key onto
 *    `app.tickets` for the same ownership reason; `clearPlanningReview` on the
 *    delete path plus the TTL keep it from accumulating orphans.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const PLANNING_REVIEW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.planning_reviews (
    ticket_key TEXT PRIMARY KEY,
    engagement_id TEXT NOT NULL,
    flow TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  // Readers filter on the expiry; the sweep deletes by it.
  `CREATE INDEX IF NOT EXISTS planning_reviews_expires_at ON app.planning_reviews (expires_at)`,
];

/** Which planning pass is running — drives the wording of the UI tooltip. */
export const PLANNING_REVIEW_FLOWS = ['plan', 'refine', 'comment-rework'] as const;
export type PlanningReviewFlow = (typeof PLANNING_REVIEW_FLOWS)[number];

/**
 * How long a review pass may claim a ticket before the badge clears itself.
 * The slowest pass is the board-aware tool loop (up to 8 model rounds, each
 * with a retry), so this is deliberately several times the realistic worst
 * case — the TTL is a backstop for a dead process, not a deadline.
 */
export const PLANNING_REVIEW_TTL_MS = 10 * 60 * 1000;

export interface PlanningReviewStart {
  key: string;
  engagementId: string;
  flow: PlanningReviewFlow;
}

/**
 * Mark a ticket as under planning review. Upserts, so a second pass starting
 * on the same ticket refreshes the window instead of failing on the primary
 * key. Best-effort by design: the flag is a status indicator, and failing to
 * raise it must never fail the planning work it describes.
 */
export async function beginPlanningReview(q: Query, opts: PlanningReviewStart): Promise<void> {
  try {
    await q(
      `INSERT INTO app.planning_reviews (ticket_key, engagement_id, flow, started_at, expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + ($4::text || ' milliseconds')::interval)
       ON CONFLICT (ticket_key) DO UPDATE
         SET engagement_id = EXCLUDED.engagement_id,
             flow = EXCLUDED.flow,
             started_at = EXCLUDED.started_at,
             expires_at = EXCLUDED.expires_at`,
      [opts.key, opts.engagementId, opts.flow, String(PLANNING_REVIEW_TTL_MS)],
    );
  } catch (err) {
    console.warn(`[planning-review] could not flag ${opts.key} as reviewing:`, (err as Error).message);
  }
}

/**
 * Clear a ticket's review flag. Best-effort for the same reason as the begin
 * side — and harmless when it fails, because the row expires on its own.
 */
export async function clearPlanningReview(q: Query, key: string): Promise<void> {
  try {
    await q('DELETE FROM app.planning_reviews WHERE ticket_key = $1', [key]);
  } catch (err) {
    console.warn(`[planning-review] could not clear the reviewing flag on ${key}:`, (err as Error).message);
  }
}

/** Drop rows whose TTL has run out — the sweep behind the read-side filter. */
export async function sweepExpiredPlanningReviews(q: Query): Promise<number> {
  try {
    const { rows } = await q('DELETE FROM app.planning_reviews WHERE expires_at <= NOW() RETURNING ticket_key');
    if (rows.length > 0) {
      console.warn(`[planning-review] swept ${rows.length} expired review flag(s): ${rows.map((r) => String(r.ticket_key)).join(', ')}`);
    }
    return rows.length;
  } catch (err) {
    console.warn('[planning-review] expiry sweep failed:', (err as Error).message);
    return 0;
  }
}

/**
 * Background sweep. The read side already hides expired rows, so this exists
 * to keep the table from growing and — more usefully — to log the passes that
 * died without clearing up after themselves.
 */
export function startPlanningReviewSweep(q: Query, intervalMs = PLANNING_REVIEW_TTL_MS): void {
  setInterval(() => void sweepExpiredPlanningReviews(q), intervalMs).unref?.();
}

/**
 * Run a planning pass with the ticket flagged as under review for its
 * duration. The flag is cleared in a `finally`, so an exception, an early
 * return, or a rejected model call all put the ticket back to normal — and the
 * TTL covers the process dying before the `finally` ever runs.
 *
 * Returns whatever the wrapped function returns; exceptions propagate
 * unchanged, so callers keep their existing error handling.
 */
export async function withPlanningReview<T>(q: Query, opts: PlanningReviewStart, run: () => Promise<T>): Promise<T> {
  await beginPlanningReview(q, opts);
  try {
    return await run();
  } finally {
    await clearPlanningReview(q, opts.key);
  }
}

/**
 * SQL for the read side: exposes the live review (if any) as
 * `planning_review_flow` / `planning_review_started_at`. A plain join, not a
 * lateral — `ticket_key` is the primary key, so there is at most one row per
 * ticket to begin with. Expired rows are filtered in the join condition rather
 * than trusted to the sweep, so the badge disappears on the next poll even if
 * nothing has swept yet.
 *
 * `%T%` stands in for the tickets alias used by the surrounding query.
 */
export const PLANNING_REVIEW_JOIN_SQL =
  'LEFT JOIN app.planning_reviews plr ON plr.ticket_key = %T%.key AND plr.expires_at > NOW()';

export const PLANNING_REVIEW_COLUMNS_SQL = 'plr.flow AS planning_review_flow, plr.started_at AS planning_review_started_at';

/** The lateral join above, bound to a tickets alias (`t`, `ti`, …). */
export function planningReviewJoin(ticketsAlias: string): string {
  return PLANNING_REVIEW_JOIN_SQL.replace(/%T%/g, ticketsAlias);
}
