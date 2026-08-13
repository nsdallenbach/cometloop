import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { applyTicketOrder } from './ticket-order';

/**
 * Runs the board-order renumbering against pg-mem — the exact UPDATE the
 * console runs against Lakebase Postgres when a card is dragged to a new
 * slot in its lane.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, status TEXT NOT NULL, seq SERIAL)`,
];

/** The subset of the pg adapter pg-mem hands back (untyped because `pg` itself is not installed). */
interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

const boardOrder = async (engagementId: string) =>
  (await q('SELECT key FROM app.tickets WHERE engagement_id = $1 ORDER BY seq DESC', [engagementId])).rows.map((r) =>
    String(r.key),
  );

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of SUPPORT_SQL) await q(sql);
  for (const [key, eng] of [
    ['DAT-101', 'eng-a'],
    ['DAT-102', 'eng-a'],
    ['DAT-103', 'eng-a'],
    ['NAC-101', 'eng-b'],
    ['NAC-102', 'eng-b'],
  ]) {
    await q(`INSERT INTO app.tickets (key, engagement_id, status) VALUES ($1, $2, 'backlog')`, [key, eng]);
  }
});

describe('applyTicketOrder', () => {
  it('renumbers seq to match the requested order', async () => {
    expect(await applyTicketOrder(q, 'eng-a', ['DAT-103', 'DAT-101', 'DAT-102'])).toBe(3);
    expect(await boardOrder('eng-a')).toEqual(['DAT-103', 'DAT-101', 'DAT-102']);
  });

  it('leaves other engagements untouched', async () => {
    await applyTicketOrder(q, 'eng-a', ['DAT-102', 'DAT-101', 'DAT-103']);
    // eng-b is never renumbered, so it keeps its SERIAL seq — which on a
    // newest-first board (DAT-223) puts the later-created ticket on top.
    expect(await boardOrder('eng-b')).toEqual(['NAC-102', 'NAC-101']);
  });

  it('ignores keys outside the engagement', async () => {
    expect(await applyTicketOrder(q, 'eng-a', ['NAC-101', 'DAT-102', 'DAT-101', 'DAT-103'])).toBe(3);
    expect(await boardOrder('eng-a')).toEqual(['DAT-102', 'DAT-101', 'DAT-103']);
    expect(await boardOrder('eng-b')).toEqual(['NAC-102', 'NAC-101']);
  });

  it('keeps the first position for duplicated keys', async () => {
    await applyTicketOrder(q, 'eng-a', ['DAT-103', 'DAT-101', 'DAT-103', 'DAT-102']);
    expect(await boardOrder('eng-a')).toEqual(['DAT-103', 'DAT-101', 'DAT-102']);
  });

  it('new tickets land before a renumbered board (SERIAL keeps outrunning seq)', async () => {
    await applyTicketOrder(q, 'eng-a', ['DAT-103', 'DAT-102', 'DAT-101']);
    await q(`INSERT INTO app.tickets (key, engagement_id, status) VALUES ('DAT-104', 'eng-a', 'backlog')`);
    expect(await boardOrder('eng-a')).toEqual(['DAT-104', 'DAT-103', 'DAT-102', 'DAT-101']);
  });
});
