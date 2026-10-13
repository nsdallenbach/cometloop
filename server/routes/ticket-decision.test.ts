import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { APPROVED_STATUS, REJECTED_STATUS, decideTicketReview } from './ticket-decision';

/**
 * DAT-222 acceptance criteria against pg-mem — the same SQL the console runs
 * against Lakebase: approve is a single frictionless move into the Deploying
 * lane, reject refuses to write anything without a note, the note lands in the
 * ticket's visible history, and both decisions leave a status event behind for
 * burndown and velocity.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.tickets (
     key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
     assignee TEXT NOT NULL DEFAULT '—', done_at TIMESTAMPTZ)`,
  `CREATE TABLE app.ticket_events (
     id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL,
     from_status TEXT, to_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.ticket_comments (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE app.feed_items (
     id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL,
     time_label TEXT NOT NULL, reversible BOOLEAN NOT NULL DEFAULT false)`,
];

let q: Query;

const ticket = async (): Promise<{ status: string; doneAt: unknown }> => {
  const row = (await q(`SELECT status, done_at FROM app.tickets WHERE key = 'DAT-222'`)).rows[0];
  return { status: String(row.status), doneAt: row.done_at };
};

const comments = async (): Promise<string[]> =>
  (await q('SELECT body FROM app.ticket_comments ORDER BY id')).rows.map((r) => String(r.body));

const feed = async (): Promise<string[]> => (await q('SELECT text FROM app.feed_items ORDER BY id')).rows.map((r) => String(r.text));

const events = async (): Promise<string[]> =>
  (await q('SELECT from_status, to_status FROM app.ticket_events ORDER BY id')).rows.map((r) => `${String(r.from_status)}→${String(r.to_status)}`);

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of SUPPORT_SQL) await q(sql);
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status) VALUES ('DAT-222', 'exec', 'Deploying lane', 'review')`);
});

describe('decideTicketReview — approve', () => {
  it('moves the ticket to Deploying in one call and records the transition', async () => {
    const result = await decideTicketReview(q, 'DAT-222', { decision: 'approve', actor: 'lead@example.com' });
    expect(result).toMatchObject({ ok: true, status: APPROVED_STATUS });
    expect((await ticket()).status).toBe('deploying');
    expect(await events()).toEqual(['review→deploying']);
    expect(await feed()).toEqual(['Approved DAT-222 — Deploying lane moved to Deploying.']);
  });

  it('needs no note and writes no comment', async () => {
    await decideTicketReview(q, 'DAT-222', { decision: 'approve', actor: 'lead@example.com' });
    expect(await comments()).toEqual([]);
  });

  it('leaves no completion stamp — approved is not deployed', async () => {
    await q(`UPDATE app.tickets SET done_at = NOW() WHERE key = 'DAT-222'`);
    await decideTicketReview(q, 'DAT-222', { decision: 'approve', actor: 'lead@example.com' });
    expect((await ticket()).doneAt).toBeNull();
  });
});

describe('decideTicketReview — reject', () => {
  it('refuses a blank note and writes nothing at all', async () => {
    const result = await decideTicketReview(q, 'DAT-222', { decision: 'reject', note: '  \n ', actor: 'lead@example.com' });
    expect(result).toEqual({ ok: false, status: 400, error: 'A rejection note is required — say what needs to change' });
    expect((await ticket()).status).toBe('review');
    expect(await comments()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('refuses a missing note the same way', async () => {
    const result = await decideTicketReview(q, 'DAT-222', { decision: 'reject', actor: 'lead@example.com' });
    expect(result.ok).toBe(false);
    expect((await ticket()).status).toBe('review');
  });

  it('sends the ticket back to Backlog and saves the note to the ticket history', async () => {
    const result = await decideTicketReview(q, 'DAT-222', {
      decision: 'reject',
      note: '  The lane filter misses tickets with no deploy state.  ',
      actor: 'lead@example.com',
    });
    expect(result).toMatchObject({ ok: true, status: REJECTED_STATUS });
    expect((await ticket()).status).toBe('backlog');
    expect(await comments()).toEqual(['⨯ Review rejected: The lane filter misses tickets with no deploy state.']);
    expect(await events()).toEqual(['review→backlog']);
    expect(await feed()).toEqual(['Rejected DAT-222 — Deploying lane sent back to Backlog.']);
  });

  it('accumulates a note per rejection instead of overwriting the last one', async () => {
    await decideTicketReview(q, 'DAT-222', { decision: 'reject', note: 'first', actor: 'lead@example.com' });
    await q(`UPDATE app.tickets SET status = 'review' WHERE key = 'DAT-222'`);
    await decideTicketReview(q, 'DAT-222', { decision: 'reject', note: 'second', actor: 'lead@example.com' });
    expect(await comments()).toEqual(['⨯ Review rejected: first', '⨯ Review rejected: second']);
  });
});

describe('decideTicketReview — guards', () => {
  it('only decides tickets that are in review', async () => {
    await q(`UPDATE app.tickets SET status = 'deploying' WHERE key = 'DAT-222'`);
    const result = await decideTicketReview(q, 'DAT-222', { decision: 'approve', actor: 'lead@example.com' });
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'Only tickets in review can be approved or rejected (this one is deploying)',
    });
    expect(await events()).toEqual([]);
  });

  it('404s on an unknown ticket', async () => {
    const result = await decideTicketReview(q, 'DAT-999', { decision: 'approve', actor: 'lead@example.com' });
    expect(result).toEqual({ ok: false, status: 404, error: 'Ticket not found' });
  });
});
