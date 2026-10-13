import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  DEFAULT_QUIET_DAYS,
  MAX_QUIET_DAYS,
  MIN_QUIET_DAYS,
  STALE_NUDGE_SCHEMA_SQL,
  businessDaysBetween,
  checkStaleNudges,
  clampQuietDays,
  resolveNudgeRecipients,
} from './stale-nudges';
import { tenancyTestSql } from '../db/tenancy';

/**
 * The DAT-107 stale-ticket sweep run against pg-mem — the same SQL the
 * console executes against Lakebase — exercising every acceptance criterion:
 * a quiet ticket nudges its assignee exactly once (no repeat spam however
 * often the sweep runs), the threshold is per-engagement with a 5-business-day
 * default, unassigned tickets nudge the engagement leads, and the nudge lands
 * in app.notifications (the notification centre and the email digest both
 * render from that table).
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

// Minimal stand-ins for the console tables the sweep reads/writes.
const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY)`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '—')`,
  `CREATE TABLE app.ticket_events (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.ticket_comments (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.engagement_leads (engagement_id TEXT NOT NULL, email TEXT NOT NULL)`,
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, time_label TEXT NOT NULL, source TEXT, reversible BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE TABLE app.notifications (id SERIAL PRIMARY KEY, recipient_email TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, ticket_key TEXT, engagement_id TEXT, read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
];

const DAY = 86_400_000;
/** Monday 2026-08-03 09:00 UTC — the last activity all scenarios start from. */
const MON = Date.parse('2026-08-03T09:00:00Z');

let q: Query;

const at = (offsetDays: number): string => new Date(MON + offsetDays * DAY).toISOString();
const sweep = (offsetDays: number) => checkStaleNudges(q, { now: () => MON + offsetDays * DAY });

const notifications = async (): Promise<{ recipient: string; type: string; title: string }[]> =>
  (await q('SELECT recipient_email, type, title FROM app.notifications ORDER BY id')).rows.map((r) => ({
    recipient: String(r.recipient_email),
    type: String(r.type),
    title: String(r.title),
  }));

const nudgeRows = async (): Promise<number> => (await q('SELECT id FROM app.ticket_nudges')).rows.length;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...STALE_NUDGE_SCHEMA_SQL]) await q(sql);
  for (const sql of tenancyTestSql([...SUPPORT_SQL, ...STALE_NUDGE_SCHEMA_SQL])) await q(sql);
  await q(`INSERT INTO app.engagements (id) VALUES ('exec')`);
  await q(`INSERT INTO app.engagement_leads (engagement_id, email) VALUES ('exec', 'lead@example.com')`);
  await q(
    `INSERT INTO app.tickets (key, engagement_id, title, status, assignee)
     VALUES ('DAT-107', 'exec', 'Implement stale-ticket nudges', 'progress', 'dev@example.com')`,
  );
  // DAT-101 trail: the ticket entered progress at MON and nothing since.
  await q(`INSERT INTO app.ticket_events (ticket_key, engagement_id, from_status, to_status, created_at) VALUES ('DAT-107', 'exec', 'backlog', 'progress', $1)`, [at(0)]);
});

describe('businessDaysBetween', () => {
  it('counts only weekday steps, so a weekend adds nothing', () => {
    expect(businessDaysBetween(MON, MON + 4 * DAY)).toBe(4); // Tue–Fri
    expect(businessDaysBetween(MON, MON + 5 * DAY)).toBe(4); // …Sat
    expect(businessDaysBetween(MON, MON + 6 * DAY)).toBe(4); // …Sun
    expect(businessDaysBetween(MON, MON + 7 * DAY)).toBe(5); // next Mon
  });

  it('a Friday-evening quiet start skips straight over the weekend', () => {
    const fri = Date.parse('2026-08-07T18:00:00Z');
    expect(businessDaysBetween(fri, fri + 1 * DAY)).toBe(0); // Sat
    expect(businessDaysBetween(fri, fri + 2 * DAY)).toBe(0); // Sun
    expect(businessDaysBetween(fri, fri + 3 * DAY)).toBe(1); // Mon
  });

  it('never goes negative and ignores partial days', () => {
    expect(businessDaysBetween(MON, MON)).toBe(0);
    expect(businessDaysBetween(MON, MON - DAY)).toBe(0);
    expect(businessDaysBetween(MON, MON + DAY - 1)).toBe(0);
  });
});

describe('clampQuietDays', () => {
  it('defaults junk to 5 and clamps the extremes', () => {
    expect(clampQuietDays(undefined)).toBe(DEFAULT_QUIET_DAYS);
    expect(clampQuietDays('nope')).toBe(DEFAULT_QUIET_DAYS);
    expect(clampQuietDays(0)).toBe(MIN_QUIET_DAYS);
    expect(clampQuietDays(99)).toBe(MAX_QUIET_DAYS);
    expect(clampQuietDays('3')).toBe(3);
  });
});

describe('checkStaleNudges', () => {
  it('nudges the assignee exactly when the quiet period crosses 5 business days', async () => {
    expect((await sweep(6)).nudged).toBe(0); // Sunday: still 4 business days
    expect(await notifications()).toEqual([]);

    expect((await sweep(7)).nudged).toBe(1); // Monday: 5 business days quiet
    const sent = await notifications();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient: 'dev@example.com', type: 'stale_nudge' });
    expect(sent[0].title).toContain('DAT-107');
    const feed = (await q('SELECT text FROM app.feed_items')).rows.map((r) => String(r.text));
    expect(feed.some((t) => t.includes('DAT-107') && t.includes('dev@example.com'))).toBe(true);
  });

  it('never repeats a nudge for the same quiet period, however often the sweep runs', async () => {
    await sweep(7);
    await sweep(7);
    await sweep(9);
    await sweep(20);
    expect(await notifications()).toHaveLength(1);
    expect(await nudgeRows()).toBe(1);
  });

  it('new activity opens a new quiet period that earns one fresh nudge', async () => {
    await sweep(7);
    // The assignee replies on day 8 (Tue) — the ticket is active again.
    await q(`INSERT INTO app.ticket_comments (ticket_key, author, body, created_at) VALUES ('DAT-107', 'dev@example.com', 'still on it', $1)`, [at(8)]);
    expect((await sweep(9)).nudged).toBe(0);
    // Quiet again for 5 business days from the comment (Tue +7 calendar days).
    expect((await sweep(15)).nudged).toBe(1);
    expect(await notifications()).toHaveLength(2);
    expect(await nudgeRows()).toBe(2);
  });

  it("console-authored comments never reset the clock they're chasing", async () => {
    await q(`INSERT INTO app.ticket_comments (ticket_key, author, body, created_at) VALUES ('DAT-107', 'Delivery Console', 'automated ping', $1)`, [at(6)]);
    expect((await sweep(7)).nudged).toBe(1);
  });

  it('unassigned or runner-assigned tickets nudge the engagement leads instead', async () => {
    await q(`UPDATE app.tickets SET assignee = '—' WHERE key = 'DAT-107'`);
    await sweep(7);
    let sent = await notifications();
    expect(sent).toHaveLength(1);
    expect(sent[0].recipient).toBe('lead@example.com');
    expect(sent[0].title).toContain('unassigned');

    // A runner name is not an inbox — the leads get that one too.
    await q(
      `INSERT INTO app.tickets (key, engagement_id, title, status, assignee) VALUES ('DAT-108', 'exec', 'Another', 'review', 'desktop-runner-3')`,
    );
    await q(`INSERT INTO app.ticket_events (ticket_key, engagement_id, from_status, to_status, created_at) VALUES ('DAT-108', 'exec', 'progress', 'review', $1)`, [at(0)]);
    await sweep(7);
    sent = await notifications();
    expect(sent).toHaveLength(2);
    expect(sent[1].recipient).toBe('lead@example.com');
  });

  it('honours a per-engagement threshold instead of the default', async () => {
    await q(`INSERT INTO app.nudge_settings (engagement_id, quiet_days) VALUES ('exec', 2)`);
    expect((await sweep(1)).nudged).toBe(0); // Tue: 1 business day
    expect((await sweep(2)).nudged).toBe(1); // Wed: 2 business days
  });

  it('leaves tickets outside progress/review alone', async () => {
    await q(`UPDATE app.tickets SET status = 'backlog' WHERE key = 'DAT-107'`);
    const run = await sweep(20);
    expect(run.candidates).toBe(0);
    expect(await notifications()).toEqual([]);
  });

  it('with nobody to tell, the quiet period stays unclaimed until a lead exists', async () => {
    await q(`UPDATE app.tickets SET assignee = '—' WHERE key = 'DAT-107'`);
    await q(`DELETE FROM app.engagement_leads`);
    expect((await sweep(7)).nudged).toBe(0);
    expect(await nudgeRows()).toBe(0);
    await q(`INSERT INTO app.engagement_leads (engagement_id, email) VALUES ('exec', 'lead@example.com')`);
    expect((await sweep(8)).nudged).toBe(1);
    expect((await notifications())[0].recipient).toBe('lead@example.com');
  });
});

describe('resolveNudgeRecipients', () => {
  it('an email assignee is the recipient; anything else falls to the leads', async () => {
    await expect(resolveNudgeRecipients(q, 'exec', ' Dev@example.com ')).resolves.toEqual({
      recipients: ['dev@example.com'],
      assigneeNudged: true,
    });
    await expect(resolveNudgeRecipients(q, 'exec', 'desktop-runner-3')).resolves.toEqual({
      recipients: ['lead@example.com'],
      assigneeNudged: false,
    });
    await expect(resolveNudgeRecipients(q, 'exec', '—')).resolves.toEqual({
      recipients: ['lead@example.com'],
      assigneeNudged: false,
    });
  });
});
