/**
 * Paging for the status feed (board detail perf follow-up). The detail
 * payload carries only the latest `FEED_PAGE_SIZE` items, newest first; the
 * Status Feed tab pages further back through `GET /api/engagements/:id/feed`.
 *
 * Order is `created_at DESC, id DESC` and the cursor is a feed item id: ids
 * are SERIAL and `created_at` defaults to NOW(), so the two agree. The index
 * `feed_items_tenant_engagement_created` (server/db/tenancy.ts) serves both
 * the first page and every older one.
 */

/** Feed items per page — what the detail payload carries and what one "load older" fetches. */
export const FEED_PAGE_SIZE = 200;

export const FEED_PAGE_ORDER = 'ORDER BY created_at DESC, id DESC';

export interface FeedPageRequest {
  engagementId: string;
  /** Feed item id to page back from; omitted for the latest page. */
  before?: number;
  /** Clamped to 1..FEED_PAGE_SIZE. */
  limit?: number;
}

/** Parse the `before` / `limit` query strings; anything unparseable means "latest page, default size". */
export function parseFeedPageQuery(engagementId: string, query: { before?: unknown; limit?: unknown }): FeedPageRequest {
  const before = typeof query.before === 'string' ? Number.parseInt(query.before, 10) : Number.NaN;
  const limit = typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : Number.NaN;
  return {
    engagementId,
    ...(Number.isFinite(before) ? { before } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
  };
}

/** The statement and parameters for one page. */
export function feedPageQuery(req: FeedPageRequest): { text: string; params: unknown[]; limit: number } {
  const limit = Math.min(FEED_PAGE_SIZE, Math.max(1, req.limit ?? FEED_PAGE_SIZE));
  const params: unknown[] = [req.engagementId];
  let where = 'engagement_id = $1 AND NOT reverted';
  if (req.before !== undefined) {
    params.push(req.before);
    where += ` AND id < $${params.length}`;
  }
  return { text: `SELECT * FROM app.feed_items WHERE ${where} ${FEED_PAGE_ORDER} LIMIT ${limit}`, params, limit };
}
