import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { FEED_PAGE_SIZE, feedPageQuery, parseFeedPageQuery } from './feed-page';

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}
type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

describe('feedPageQuery', () => {
  it('builds the latest page by default and the older page from an id cursor', () => {
    expect(feedPageQuery({ engagementId: 'cometloop' })).toEqual({
      text: `SELECT * FROM app.feed_items WHERE engagement_id = $1 AND NOT reverted ORDER BY created_at DESC, id DESC LIMIT ${FEED_PAGE_SIZE}`,
      params: ['cometloop'],
      limit: FEED_PAGE_SIZE,
    });
    expect(feedPageQuery({ engagementId: 'cometloop', before: 1090, limit: 50 })).toEqual({
      text: 'SELECT * FROM app.feed_items WHERE engagement_id = $1 AND NOT reverted AND id < $2 ORDER BY created_at DESC, id DESC LIMIT 50',
      params: ['cometloop', 1090],
      limit: 50,
    });
  });

  it('clamps the limit and ignores garbage cursors', () => {
    expect(feedPageQuery({ engagementId: 'e', limit: 5000 }).limit).toBe(FEED_PAGE_SIZE);
    expect(feedPageQuery({ engagementId: 'e', limit: 0 }).limit).toBe(1);
    expect(parseFeedPageQuery('e', { before: 'abc', limit: 'x' })).toEqual({ engagementId: 'e' });
    expect(parseFeedPageQuery('e', { before: '1090', limit: '20' })).toEqual({ engagementId: 'e', before: 1090, limit: 20 });
    expect(parseFeedPageQuery('e', { before: ['1', '2'] })).toEqual({ engagementId: 'e' });
  });
});

describe('feed paging (pg-mem)', () => {
  let q: Query;
  beforeEach(async () => {
    const { Pool } = newDb().adapters.createPg() as MemPg;
    const pool = new Pool();
    q = (text, params) => pool.query(text, params);
    await q('CREATE SCHEMA app');
    await q(
      `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL,
       time_label TEXT NOT NULL, reverted BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    );
    for (let i = 1; i <= 7; i++) {
      await q(`INSERT INTO app.feed_items (engagement_id, actor, text, time_label, created_at) VALUES ($1, 'AGENT', $2, 'now', $3)`, [
        i === 4 ? 'other' : 'cometloop',
        `item ${i}`,
        new Date(Date.UTC(2026, 0, i)).toISOString(),
      ]);
    }
    await q(`UPDATE app.feed_items SET reverted = true WHERE text = 'item 6'`);
  });

  const page = async (req: Parameters<typeof feedPageQuery>[0]) => {
    const { text, params } = feedPageQuery(req);
    return (await q(text, params)).rows.map((r) => r.text);
  };

  it('pages newest first through the engagement, skipping reverted rows and other engagements', async () => {
    expect(await page({ engagementId: 'cometloop', limit: 3 })).toEqual(['item 7', 'item 5', 'item 3']);
    expect(await page({ engagementId: 'cometloop', limit: 3, before: 3 })).toEqual(['item 2', 'item 1']);
    expect(await page({ engagementId: 'cometloop', limit: 3, before: 1 })).toEqual([]);
  });
});
