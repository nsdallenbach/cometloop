import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  PLANNING_REVIEW_COLUMNS_SQL,
  PLANNING_REVIEW_SCHEMA_SQL,
  beginPlanningReview,
  clearPlanningReview,
  planningReviewJoin,
  sweepExpiredPlanningReviews,
  withPlanningReview,
} from './planning-review';
import { tenancyTestSql } from '../db/tenancy';

/**
 * DAT-218. Runs the planning-review helpers against pg-mem — the same SQL the
 * console runs against Lakebase, including the lateral join the board reads
 * the flag through.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '')`,
];

/** The subset of the pg adapter pg-mem hands back (untyped because `pg` itself is not installed). */
interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

/** What the board sees: one row per ticket, with the live review joined on. */
const boardRows = () =>
  q(`SELECT t.key, ${PLANNING_REVIEW_COLUMNS_SQL} FROM app.tickets t ${planningReviewJoin('t')} ORDER BY t.key`);

const flagOf = async (key: string): Promise<unknown> => {
  const { rows } = await boardRows();
  return rows.find((r) => r.key === key)?.planning_review_flow ?? null;
};

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...PLANNING_REVIEW_SCHEMA_SQL]) await q(sql);
  for (const sql of tenancyTestSql([...SUPPORT_SQL, ...PLANNING_REVIEW_SCHEMA_SQL])) await q(sql);
  await q(`INSERT INTO app.tickets (key, engagement_id) VALUES ('DAT-1', 'exec'), ('DAT-2', 'exec'), ('DAT-3', 'exec')`);
});

describe('planning review flag', () => {
  it('raises the flag for the duration of a pass and clears it after', async () => {
    let seenDuringPass: unknown = 'not run';
    await withPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'refine' }, async () => {
      seenDuringPass = await flagOf('DAT-1');
    });
    expect(seenDuringPass).toBe('refine');
    expect(await flagOf('DAT-1')).toBeNull();
  });

  it('clears the flag when the pass throws, and re-raises the error', async () => {
    await expect(
      withPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'comment-rework' }, () =>
        Promise.reject(new Error('the planning model is unavailable')),
      ),
    ).rejects.toThrow('the planning model is unavailable');
    expect(await flagOf('DAT-1')).toBeNull();
  });

  it('returns the wrapped value untouched', async () => {
    const result = await withPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'plan' }, () =>
      Promise.resolve({ ac: ['one', 'two'] }),
    );
    expect(result).toEqual({ ac: ['one', 'two'] });
  });

  it('tracks tickets independently — concurrent passes do not bleed into each other', async () => {
    await beginPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'plan' });
    await beginPlanningReview(q, { key: 'DAT-2', engagementId: 'exec', flow: 'comment-rework' });
    const { rows } = await boardRows();
    expect(rows.map((r) => [r.key, r.planning_review_flow])).toEqual([
      ['DAT-1', 'plan'],
      ['DAT-2', 'comment-rework'],
      ['DAT-3', null],
    ]);
    await clearPlanningReview(q, 'DAT-1');
    expect(await flagOf('DAT-1')).toBeNull();
    expect(await flagOf('DAT-2')).toBe('comment-rework');
  });

  it('a second pass on the same ticket refreshes the row instead of failing on the key', async () => {
    await beginPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'plan' });
    await beginPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'refine' });
    expect(await flagOf('DAT-1')).toBe('refine');
    expect((await q('SELECT * FROM app.planning_reviews')).rows).toHaveLength(1);
  });

  it('hides a flag whose TTL ran out, even before anything sweeps it', async () => {
    // Stands in for a pass whose process died before the `finally` ran.
    await beginPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'refine' });
    await q(`UPDATE app.planning_reviews SET expires_at = NOW() - INTERVAL '1 minute' WHERE ticket_key = 'DAT-1'`);
    expect(await flagOf('DAT-1')).toBeNull();
    expect((await q('SELECT * FROM app.planning_reviews')).rows).toHaveLength(1);
  });

  it('sweeps expired rows and leaves live ones alone', async () => {
    await beginPlanningReview(q, { key: 'DAT-1', engagementId: 'exec', flow: 'refine' });
    await beginPlanningReview(q, { key: 'DAT-2', engagementId: 'exec', flow: 'plan' });
    await q(`UPDATE app.planning_reviews SET expires_at = NOW() - INTERVAL '1 minute' WHERE ticket_key = 'DAT-1'`);
    expect(await sweepExpiredPlanningReviews(q)).toBe(1);
    expect((await q('SELECT ticket_key FROM app.planning_reviews')).rows).toEqual([{ ticket_key: 'DAT-2' }]);
  });

  it('clearing a ticket that was never flagged is a no-op', async () => {
    await clearPlanningReview(q, 'DAT-3');
    expect(await flagOf('DAT-3')).toBeNull();
  });
});
