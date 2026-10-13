import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  FLAG_AFTER_MS,
  PING_AFTER_MS,
  PR_ESCALATION_SCHEMA_SQL,
  checkReviewEscalations,
  dismissEscalation,
  escalationSummaryComment,
  hoursSince,
  nextEscalationAction,
  publicEscalation,
  resolveLeads,
  type EscalationDeps,
} from './pr-escalation';
import type { Connection } from './repos';

/**
 * The review-SLA ladder run against pg-mem — the same SQL the console executes
 * against Lakebase — with the provider legs (review lookup, PR comment) stubbed
 * so every acceptance criterion of DAT-201 is exercised end to end: the 24h
 * ping, the 48h PR comment + board flag, dismissal resetting both timers,
 * timers stopping on review/merge, and no duplicate notifications when the
 * thresholds are checked over and over.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

// Minimal stand-ins for the console tables the escalation watch reads/writes.
const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.repo_connections (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, repo_name TEXT NOT NULL)`,
  `CREATE TABLE app.repo_prs (
     id SERIAL PRIMARY KEY, connection_id INT NOT NULL, number INT NOT NULL, state TEXT NOT NULL,
     url TEXT NOT NULL DEFAULT '', ticket_key TEXT, opened_at TIMESTAMPTZ)`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT NOT NULL DEFAULT '—')`,
  `CREATE TABLE app.ticket_comments (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, time_label TEXT NOT NULL, source TEXT, reversible BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE TABLE app.engagement_leads (engagement_id TEXT NOT NULL, email TEXT NOT NULL)`,
];

const conn = {
  id: 1,
  engagement_id: 'exec',
  provider: 'github',
  repo_url: 'https://github.com/your-org/your-repo',
  repo_name: 'your-org/your-repo',
  default_branch: 'main',
  token: 'x',
  auth_type: 'pat',
  installation_id: null,
} as Connection;

const OPENED = Date.parse('2026-08-01T09:00:00Z');
const H = 3_600_000;

let q: Query;
/** PR comments the 48h stage posted, in order. */
let posted: { number: number; body: string }[];

/** Deps with a fixed clock; `reviewed` defaults to "nobody has looked at it". */
const deps = (nowMs: number, reviewed = false): Partial<EscalationDeps> => ({
  now: () => nowMs,
  reviewed: () => Promise.resolve(reviewed),
  comment: (_c, number, body) => {
    posted.push({ number, body });
    return Promise.resolve();
  },
});

const stageOf = async (prNumber = 7): Promise<string> =>
  String((await q('SELECT stage FROM app.pr_review_escalations WHERE pr_number = $1', [prNumber])).rows[0]?.stage);

const comments = async (): Promise<string[]> =>
  (await q('SELECT body FROM app.ticket_comments ORDER BY id')).rows.map((r) => String(r.body));

const feed = async (): Promise<string[]> => (await q('SELECT text FROM app.feed_items ORDER BY id')).rows.map((r) => String(r.text));

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...PR_ESCALATION_SCHEMA_SQL]) await q(sql);
  posted = [];
  await q(`INSERT INTO app.repo_connections (engagement_id, repo_name) VALUES ('exec', 'your-org/your-repo')`);
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status) VALUES ('DAT-201', 'exec', 'Escalate unreviewed PRs', 'review')`);
  await q(`INSERT INTO app.engagement_leads (engagement_id, email) VALUES ('exec', 'lead@example.com')`);
  await q(
    `INSERT INTO app.repo_prs (connection_id, number, state, url, ticket_key, opened_at)
     VALUES (1, 7, 'open', 'https://github.com/o/r/pull/7', 'DAT-201', $1)`,
    [new Date(OPENED).toISOString()],
  );
});

describe('nextEscalationAction', () => {
  const base = { stage: 'waiting' as const, timerStartedMs: 0, nowMs: 0, prState: 'open' as const, reviewed: false, ticketOpen: true };

  it('holds until the 24h threshold, then pings once', () => {
    expect(nextEscalationAction({ ...base, nowMs: PING_AFTER_MS - 1 })).toBe('none');
    expect(nextEscalationAction({ ...base, nowMs: PING_AFTER_MS })).toBe('ping');
  });

  it('holds after the ping until 48h, then flags', () => {
    expect(nextEscalationAction({ ...base, stage: 'pinged', nowMs: FLAG_AFTER_MS - 1 })).toBe('none');
    expect(nextEscalationAction({ ...base, stage: 'pinged', nowMs: FLAG_AFTER_MS })).toBe('flag');
  });

  it('never re-fires a stage that already happened, however long it sits', () => {
    expect(nextEscalationAction({ ...base, stage: 'pinged', nowMs: PING_AFTER_MS })).toBe('none');
    expect(nextEscalationAction({ ...base, stage: 'flagged', nowMs: 10 * FLAG_AFTER_MS })).toBe('none');
    expect(nextEscalationAction({ ...base, stage: 'cleared', nowMs: 10 * FLAG_AFTER_MS })).toBe('none');
  });

  it('clears once the PR is reviewed, merged, closed, or the ticket leaves the board', () => {
    expect(nextEscalationAction({ ...base, nowMs: FLAG_AFTER_MS, reviewed: true })).toBe('clear');
    expect(nextEscalationAction({ ...base, stage: 'flagged', prState: 'merged' })).toBe('clear');
    expect(nextEscalationAction({ ...base, stage: 'pinged', prState: 'closed' })).toBe('clear');
    expect(nextEscalationAction({ ...base, ticketOpen: false })).toBe('clear');
  });

  it('rewinding the clock (a dismissal) puts the ladder back at the start', () => {
    const dismissed = { ...base, stage: 'waiting' as const, timerStartedMs: 10 * FLAG_AFTER_MS, nowMs: 10 * FLAG_AFTER_MS + H };
    expect(nextEscalationAction(dismissed)).toBe('none');
    expect(nextEscalationAction({ ...dismissed, nowMs: dismissed.timerStartedMs + PING_AFTER_MS })).toBe('ping');
  });
});

describe('review SLA watch', () => {
  it('starts a clock from the PR open time and does nothing before 24h', async () => {
    const run = await checkReviewEscalations(q, conn, {
      ...deps(OPENED + 23 * H),
      // Provider review status must not be consulted before a threshold is due.
      reviewed: () => Promise.reject(new Error('should not be called')),
    });
    expect(run).toMatchObject({ tracked: 1, pinged: 0, flagged: 0, cleared: 0 });
    expect(await stageOf()).toBe('waiting');
    expect(await comments()).toEqual([]);
    const row = (await q('SELECT timer_started_at FROM app.pr_review_escalations')).rows[0];
    expect(new Date(String(row.timer_started_at)).toISOString()).toBe(new Date(OPENED).toISOString());
  });

  it('pings the lead in the notification centre at 24h', async () => {
    const run = await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    expect(run.pinged).toBe(1);
    expect(await stageOf()).toBe('pinged');
    const [comment] = await comments();
    expect(comment).toContain('@lead@example.com');
    expect(comment).toContain('PR #7');
    expect(comment).toContain('25h');
    expect((await feed())[0]).toContain('unreviewed for 25h');
    expect(posted).toEqual([]); // the PR itself is untouched at this stage
  });

  it('does not duplicate the ping when the threshold is checked repeatedly', async () => {
    await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    await checkReviewEscalations(q, conn, deps(OPENED + 26 * H));
    await checkReviewEscalations(q, conn, deps(OPENED + 47 * H));
    expect(await comments()).toHaveLength(1);
    expect(await feed()).toHaveLength(1);
    expect(await stageOf()).toBe('pinged');
  });

  it('posts a summary comment on the PR and flags the ticket at 48h', async () => {
    await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    const run = await checkReviewEscalations(q, conn, deps(OPENED + 49 * H));
    expect(run.flagged).toBe(1);
    expect(await stageOf()).toBe('flagged');
    expect(posted).toHaveLength(1);
    expect(posted[0].number).toBe(7);
    expect(posted[0].body).toContain('Review SLA breached');
    expect(posted[0].body).toContain('DAT-201');
    expect(posted[0].body).toContain('49h');
    expect((await feed())[1]).toContain('ticket flagged');
  });

  it('does not duplicate the flag or the PR comment on repeated checks', async () => {
    await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    await checkReviewEscalations(q, conn, deps(OPENED + 49 * H));
    await checkReviewEscalations(q, conn, deps(OPENED + 60 * H));
    await checkReviewEscalations(q, conn, deps(OPENED + 96 * H));
    expect(posted).toHaveLength(1);
    expect(await comments()).toHaveLength(2); // one ping, one flag
    expect(await stageOf()).toBe('flagged');
  });

  it('stops the timers once the PR is reviewed — no further escalation fires', async () => {
    await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    await checkReviewEscalations(q, conn, { ...deps(OPENED + 30 * H), reviewed: () => Promise.resolve(true) });
    expect(await stageOf()).toBe('cleared');
    const cleared = (await q('SELECT cleared_reason FROM app.pr_review_escalations')).rows[0];
    expect(cleared.cleared_reason).toBe('reviewed');
    // Days later, with the PR still open and unreviewed, nothing more happens.
    const run = await checkReviewEscalations(q, conn, deps(OPENED + 200 * H));
    expect(run).toMatchObject({ tracked: 0, pinged: 0, flagged: 0 });
    expect(posted).toEqual([]);
  });

  it('stops the timers when the PR merges, without asking the provider', async () => {
    await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    await q(`UPDATE app.repo_prs SET state = 'merged' WHERE number = 7`);
    const run = await checkReviewEscalations(q, conn, {
      ...deps(OPENED + 49 * H),
      reviewed: () => Promise.reject(new Error('should not be called')),
    });
    expect(run.cleared).toBe(1);
    expect(await stageOf()).toBe('cleared');
    expect(posted).toEqual([]);
  });

  it('stops the timers when the ticket leaves the board', async () => {
    await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    await q(`UPDATE app.tickets SET status = 'done' WHERE key = 'DAT-201'`);
    const run = await checkReviewEscalations(q, conn, {
      ...deps(OPENED + 49 * H),
      reviewed: () => Promise.reject(new Error('should not be called')),
    });
    expect(run.cleared).toBe(1);
    expect(await stageOf()).toBe('cleared');
    expect(posted).toEqual([]);
  });

  it('never starts a clock for a ticket that is already off the board', async () => {
    await q(`UPDATE app.tickets SET status = 'done' WHERE key = 'DAT-201'`);
    const run = await checkReviewEscalations(q, conn, deps(OPENED + 49 * H));
    expect(run.tracked).toBe(0);
    expect((await q('SELECT id FROM app.pr_review_escalations')).rows).toEqual([]);
  });

  it('never escalates while the review state is unknown (provider error)', async () => {
    const run = await checkReviewEscalations(q, conn, {
      ...deps(OPENED + 49 * H),
      reviewed: () => Promise.reject(new Error('502 from provider')),
    });
    expect(run).toMatchObject({ pinged: 0, flagged: 0, cleared: 0 });
    expect(await stageOf()).toBe('waiting');
  });

  it('ignores PRs with no linked ticket', async () => {
    await q(`INSERT INTO app.repo_prs (connection_id, number, state, ticket_key, opened_at) VALUES (1, 8, 'open', NULL, $1)`, [
      new Date(OPENED).toISOString(),
    ]);
    await checkReviewEscalations(q, conn, deps(OPENED + 49 * H));
    expect((await q('SELECT pr_number FROM app.pr_review_escalations')).rows.map((r) => Number(r.pr_number))).toEqual([7]);
  });

  it('dismissal resets both timers, clears the flag, and lets the cycle restart', async () => {
    await checkReviewEscalations(q, conn, deps(OPENED + 25 * H));
    await checkReviewEscalations(q, conn, deps(OPENED + 49 * H));
    expect(await stageOf()).toBe('flagged');

    const row = await dismissEscalation(q, 'DAT-201', 'lead@example.com');
    expect(row).not.toBeNull();
    expect(row?.stage).toBe('waiting');
    expect(row?.pinged_at).toBeNull();
    expect(row?.flagged_at).toBeNull();
    expect(Number(row?.dismiss_count)).toBe(1);
    // The clock restarted at dismissal time, so nothing is due an hour later…
    const dismissedAtMs = new Date(String(row?.timer_started_at)).getTime();
    await checkReviewEscalations(q, conn, deps(dismissedAtMs + H));
    expect(await stageOf()).toBe('waiting');
    expect(posted).toHaveLength(1);
    // …and the ladder starts again 24h after the dismissal, not after the PR opened.
    const again = await checkReviewEscalations(q, conn, deps(dismissedAtMs + 25 * H));
    expect(again.pinged).toBe(1);
    expect(await stageOf()).toBe('pinged');
    expect((await comments()).filter((c) => c.includes('@lead@example.com'))).toHaveLength(2);
  });

  it('dismissing a ticket with no active escalation reports nothing to dismiss', async () => {
    expect(await dismissEscalation(q, 'DAT-999', 'lead@example.com')).toBeNull();
  });
});

describe('lead resolution', () => {
  it('uses the engagement leads', async () => {
    expect(await resolveLeads(q, 'exec', 'DAT-201')).toEqual(['lead@example.com']);
  });

  it('falls back to the ticket assignee when the engagement has no lead', async () => {
    await q(`DELETE FROM app.engagement_leads`);
    await q(`UPDATE app.tickets SET assignee = 'dev@example.com' WHERE key = 'DAT-201'`);
    expect(await resolveLeads(q, 'exec', 'DAT-201')).toEqual(['dev@example.com']);
  });

  it('returns nobody rather than the placeholder assignee', async () => {
    await q(`DELETE FROM app.engagement_leads`);
    expect(await resolveLeads(q, 'exec', 'DAT-201')).toEqual([]);
  });
});

describe('presentation helpers', () => {
  it('counts whole hours from the timer start', () => {
    expect(hoursSince(OPENED, OPENED + 25 * H + 59 * 60_000)).toBe(25);
    expect(hoursSince(OPENED, OPENED - H)).toBe(0);
  });

  it('reports how long is left before the next stage', () => {
    const row = { pr_number: 7, ticket_key: 'DAT-201', stage: 'waiting', timer_started_at: new Date(OPENED).toISOString(), dismiss_count: 0 };
    expect(publicEscalation(row, OPENED + 5 * H)).toMatchObject({ stage: 'waiting', hoursUnreviewed: 5, hoursUntilNextStage: 19 });
    expect(publicEscalation({ ...row, stage: 'pinged' }, OPENED + 30 * H)).toMatchObject({ hoursUntilNextStage: 18 });
    expect(publicEscalation({ ...row, stage: 'flagged' }, OPENED + 90 * H)).toMatchObject({ hoursUntilNextStage: null });
  });

  it('spells out the escalation ladder in the PR comment', () => {
    const body = escalationSummaryComment({
      ticketKey: 'DAT-201',
      ticketTitle: 'Escalate unreviewed PRs',
      prNumber: 7,
      hoursUnreviewed: 48,
      leads: ['lead@example.com'],
      pingedAtIso: '2026-08-02T09:00:00.000Z',
    });
    expect(body).toContain('48h');
    expect(body).toContain('lead@example.com');
    expect(body).toContain('flagged on the board');
    expect(body).toContain('dismiss');
  });
});
