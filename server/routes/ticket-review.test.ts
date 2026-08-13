import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  PROMPT_REJECTION_CHARS,
  PROMPT_REJECTION_LIMIT,
  TICKET_REVIEW_SCHEMA_SQL,
  loadRejections,
  rejectTicketReview,
  rejectionPromptSection,
  type TicketRejection,
} from './ticket-review';

/**
 * DAT-217 acceptance criteria against pg-mem — the same SQL the console runs
 * against Lakebase: a reason is required before anything is written, a rejected
 * ticket lands back in a claimable state (never 'done'), the reason plus who
 * and when are persisted and visible in the ticket history, and repeated
 * rejections accumulate instead of overwriting each other.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

// Stand-ins for the console tables the reject flow reads/writes.
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
  `CREATE TABLE app.agent_tasks (
     id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
     priority INT NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '', queued_by TEXT NOT NULL DEFAULT '',
     agent TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
];

let q: Query;

const ticket = async (): Promise<{ status: string; assignee: string }> => {
  const row = (await q(`SELECT status, assignee FROM app.tickets WHERE key = 'DAT-217'`)).rows[0];
  return { status: String(row.status), assignee: String(row.assignee) };
};

const comments = async (): Promise<string[]> => (await q('SELECT body FROM app.ticket_comments ORDER BY id')).rows.map((r) => String(r.body));

const feed = async (): Promise<string[]> => (await q('SELECT text FROM app.feed_items ORDER BY id')).rows.map((r) => String(r.text));

const tasks = async (): Promise<{ state: string; queued_by: string }[]> =>
  (await q('SELECT state, queued_by FROM app.agent_tasks ORDER BY id')).rows.map((r) => ({
    state: String(r.state),
    queued_by: String(r.queued_by),
  }));

/** The ticket as it looks when a runner has just finished and parked it in Review. */
const inReview = async (agent = 'local-runner') => {
  await q(`UPDATE app.tickets SET status = 'review', assignee = $1 WHERE key = 'DAT-217'`, [agent]);
  await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-217', 'exec', 'done', $1)`, [agent]);
};

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...TICKET_REVIEW_SCHEMA_SQL]) await q(sql);
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status) VALUES ('DAT-217', 'exec', 'Reason-based rejection', 'backlog')`);
});

describe('rejectTicketReview', () => {
  it('refuses a blank reason and writes nothing', async () => {
    await inReview();
    const result = await rejectTicketReview(q, 'DAT-217', { reason: '   \n ', rejectedBy: 'lead@datavail.com' });
    expect(result).toEqual({ ok: false, status: 400, error: 'A rejection reason is required' });
    expect(await loadRejections(q, 'DAT-217')).toEqual([]);
    expect((await ticket()).status).toBe('review');
    expect(await comments()).toEqual([]);
  });

  it('only rejects from review — a done ticket is refused', async () => {
    await q(`UPDATE app.tickets SET status = 'done' WHERE key = 'DAT-217'`);
    const result = await rejectTicketReview(q, 'DAT-217', { reason: 'Wrong endpoint', rejectedBy: 'lead@datavail.com' });
    expect(result).toEqual({ ok: false, status: 409, error: 'Only tickets in review can be rejected (this one is done)' });
    expect(await loadRejections(q, 'DAT-217')).toEqual([]);
  });

  it('404s on an unknown ticket', async () => {
    const result = await rejectTicketReview(q, 'DAT-999', { reason: 'nope', rejectedBy: 'lead@datavail.com' });
    expect(result).toEqual({ ok: false, status: 404, error: 'Ticket not found' });
  });

  it('sends the ticket back to a claimable state — never done — and records the transition', async () => {
    await inReview();
    const result = await rejectTicketReview(q, 'DAT-217', {
      reason: 'The reject endpoint is not lead-gated.',
      rejectedBy: 'lead@datavail.com',
    });
    expect(result.ok).toBe(true);
    const t = await ticket();
    expect(t.status).toBe('backlog');
    // The runner that delivered it stops owning the card, as on a failed run.
    expect(t.assignee).toBe('—');
    const events = (await q('SELECT from_status, to_status FROM app.ticket_events ORDER BY id')).rows;
    expect(events[0]).toMatchObject({ from_status: 'review', to_status: 'backlog' });
  });

  it('persists the reason with the rejector and a timestamp, and shows it in the ticket history', async () => {
    await inReview();
    await rejectTicketReview(q, 'DAT-217', { reason: 'Missing the AC about multiple cycles.', rejectedBy: 'lead@datavail.com' });
    const [rejection] = await loadRejections(q, 'DAT-217');
    expect(rejection.reason).toBe('Missing the AC about multiple cycles.');
    expect(rejection.rejectedBy).toBe('lead@datavail.com');
    expect(rejection.rejectedAt).not.toBe('');
    expect(await comments()).toEqual(['⨯ Review rejected (rejection 1): Missing the AC about multiple cycles.']);
    expect((await feed())[0]).toContain('Rejected DAT-217 in review');
  });

  it('re-queues an agent run by default when an agent worked the ticket', async () => {
    await inReview();
    const result = await rejectTicketReview(q, 'DAT-217', { reason: 'Rework the prompt section.', rejectedBy: 'lead@datavail.com' });
    expect(result.ok && result.requeued).toBe(true);
    expect(await tasks()).toEqual([
      { state: 'done', queued_by: '' },
      { state: 'queued', queued_by: 'lead@datavail.com' },
    ]);
  });

  it('leaves a ticket no agent ever worked in the backlog without queueing one', async () => {
    await q(`UPDATE app.tickets SET status = 'review', assignee = 'nigel' WHERE key = 'DAT-217'`);
    const result = await rejectTicketReview(q, 'DAT-217', { reason: 'Human rework.', rejectedBy: 'lead@datavail.com' });
    expect(result.ok && result.requeued).toBe(false);
    expect(await tasks()).toEqual([]);
    // Nothing claimed it, so the human assignee is left alone.
    expect((await ticket()).assignee).toBe('nigel');
  });

  it('honours requeue: false', async () => {
    await inReview();
    const result = await rejectTicketReview(q, 'DAT-217', { reason: 'Park it.', rejectedBy: 'lead@datavail.com', requeue: false });
    expect(result.ok && result.requeued).toBe(false);
    expect((await tasks()).filter((t) => t.state === 'queued')).toEqual([]);
  });

  it('never double-queues while a run is still active', async () => {
    await inReview();
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent) VALUES ('DAT-217', 'exec', 'working', 'local-runner')`);
    const result = await rejectTicketReview(q, 'DAT-217', { reason: 'Already running.', rejectedBy: 'lead@datavail.com', requeue: true });
    expect(result.ok && result.requeued).toBe(false);
    expect((await tasks()).filter((t) => t.state === 'queued')).toEqual([]);
  });

  it('accumulates reasons across cycles instead of overwriting them', async () => {
    for (const [i, reason] of ['First pass missed the endpoint.', 'Second pass has no tests.', 'Third pass broke the build.'].entries()) {
      await q(`UPDATE app.tickets SET status = 'review' WHERE key = 'DAT-217'`);
      const result = await rejectTicketReview(q, 'DAT-217', { reason, rejectedBy: `reviewer-${i}@datavail.com` });
      expect(result.ok && result.count).toBe(i + 1);
    }
    const history = await loadRejections(q, 'DAT-217');
    expect(history.map((r) => r.reason)).toEqual([
      'First pass missed the endpoint.',
      'Second pass has no tests.',
      'Third pass broke the build.',
    ]);
    expect(history.map((r) => r.rejectedBy)).toEqual([
      'reviewer-0@datavail.com',
      'reviewer-1@datavail.com',
      'reviewer-2@datavail.com',
    ]);
    // One comment per cycle, numbered, so the thread reads as a history too.
    expect(await comments()).toHaveLength(3);
    expect((await comments())[2]).toContain('(rejection 3)');
  });
});

const rejection = (n: number, reason = `reason ${n}`): TicketRejection => ({
  id: n,
  reason,
  rejectedBy: `reviewer-${n}@datavail.com`,
  rejectedAt: `2026-08-1${n}T09:00:00.000Z`,
});

describe('rejectionPromptSection', () => {
  it('renders nothing when the ticket has never been rejected', () => {
    expect(rejectionPromptSection([])).toEqual([]);
  });

  it('names the rejector, the time and the reason, and frames them as requirements', () => {
    const lines = rejectionPromptSection([rejection(1, 'The endpoint is not lead-gated.')]).join('\n');
    expect(lines).toContain('## Previous review rejections (1)');
    expect(lines).toContain('- Rejected by reviewer-1@datavail.com (2026-08-11T09:00:00.000Z): The endpoint is not lead-gated.');
    expect(lines).toContain('Treat every point above as a requirement');
  });

  it('keeps the newest rejections when over the cap, and says how many it dropped', () => {
    const lines = rejectionPromptSection(Array.from({ length: 8 }, (_, i) => rejection(i + 1))).join('\n');
    expect(lines).toContain(`## Previous review rejections (latest ${PROMPT_REJECTION_LIMIT} of 8)`);
    expect(lines).not.toContain('reason 3'); // oldest three dropped
    expect(lines).toContain('reason 8'); // newest survives
  });

  it('clips an oversized reason like the comment window does', () => {
    const lines = rejectionPromptSection([rejection(1, 'x'.repeat(4000))]).join('\n');
    expect(lines).toContain('x'.repeat(PROMPT_REJECTION_CHARS));
    expect(lines).not.toContain('x'.repeat(PROMPT_REJECTION_CHARS + 1));
  });

  it('falls back gracefully when the rejector or timestamp is missing', () => {
    const lines = rejectionPromptSection([{ id: 1, reason: 'Just fix it.', rejectedBy: '', rejectedAt: '' }]).join('\n');
    expect(lines).toContain('- Rejected by a reviewer: Just fix it.');
  });
});
