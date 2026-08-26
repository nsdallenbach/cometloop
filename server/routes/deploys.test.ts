import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  DEPLOY_EVENTS_SCHEMA_SQL,
  computeDeployMirror,
  listLocalDeployQueue,
  localDeployPending,
  recordDeployEvent,
  type DeployEventRow,
} from './deploys';

/**
 * Local deploy queue + events (DAT-236) against pg-mem: the exact SQL the
 * console runs in production. The mirror reduction is pure and tested
 * directly; recordDeployEvent's board side effects (Done-on-green, feed
 * warnings, PR settlement) run against real tables.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Minimal stand-ins for the console tables the deploy flow touches.
const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY)`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT, title TEXT NOT NULL DEFAULT '', done_at TIMESTAMPTZ)`,
  `CREATE TABLE app.ticket_events (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, time_label TEXT NOT NULL, source TEXT, reversible BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE TABLE app.notifications (id SERIAL PRIMARY KEY, recipient_email TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, ticket_key TEXT, engagement_id TEXT, read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.repo_connections (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, repo_name TEXT NOT NULL DEFAULT '', repo_url TEXT NOT NULL DEFAULT '', default_branch TEXT NOT NULL DEFAULT 'main')`,
  `CREATE TABLE app.repo_prs (id SERIAL PRIMARY KEY, connection_id INT NOT NULL, number INT NOT NULL, state TEXT NOT NULL, ticket_key TEXT, deploy_state TEXT, branch TEXT NOT NULL DEFAULT '', merge_sha TEXT, updated_at TIMESTAMPTZ)`,
  `CREATE TABLE app.team_members (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT)`,
  `CREATE TABLE app.engagement_members (engagement_id TEXT NOT NULL, member_id INT NOT NULL)`,
];

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  const rawQ: Query = (text: string, params?: unknown[]) => pool.query(text, params);
  // pg-mem cannot parse the `WITH prev AS (...) UPDATE` inside
  // setTicketStatus; emulate exactly the no-opts shape the deploy flow uses
  // (params = [key, status]) so the production code runs unmodified.
  q = async (text: string, params?: unknown[]) => {
    if (text.trimStart().startsWith('WITH prev AS')) {
      const [key, status] = (params ?? []) as [string, string];
      const prev = (await rawQ('SELECT key, engagement_id, status FROM app.tickets WHERE key = $1', [key])).rows[0];
      if (!prev) return { rows: [] };
      if (status === 'done') {
        await rawQ('UPDATE app.tickets SET status = $2, done_at = NOW() WHERE key = $1', [key, status]);
      } else {
        await rawQ('UPDATE app.tickets SET status = $2, done_at = NULL WHERE key = $1', [key, status]);
      }
      return { rows: [{ key: prev.key, engagement_id: prev.engagement_id, prev_status: prev.status }] };
    }
    return rawQ(text, params);
  };
  for (const sql of [...SUPPORT_SQL, ...DEPLOY_EVENTS_SCHEMA_SQL]) await q(sql);
  await q(`INSERT INTO app.engagements (id) VALUES ('eng-a')`);
  await q(`INSERT INTO app.tickets (key, engagement_id, status, assignee, title) VALUES
    ('DAT-1', 'eng-a', 'review', 'Nigel Silva', 'First feature'),
    ('DAT-2', 'eng-a', 'review', 'Nigel Silva', 'Second feature')`);
});

const ticketRow = async (key: string) =>
  (await q('SELECT key, engagement_id, status, assignee, title FROM app.tickets WHERE key = $1', [key])).rows[0];

const record = async (key: string, event: 'queued' | 'started' | 'succeeded' | 'failed' | 'removed', opts: { prNumber?: number; detail?: string } = {}) => {
  const t = await ticketRow(key);
  return recordDeployEvent(q, {
    agent: 'desktop-LAPTOP1',
    actor: 'nigel.silva@datavail.com',
    event,
    prNumber: opts.prNumber ?? null,
    detail: opts.detail ?? '',
    ticket: {
      key: String(t.key),
      engagementId: String(t.engagement_id),
      status: String(t.status),
      assignee: String(t.assignee),
      title: String(t.title),
    },
  });
};

// ---------- mirror reduction (pure) ----------

let evId = 0;
const ev = (ticketKey: string, event: DeployEventRow['event'], at: string, extra: Partial<DeployEventRow> = {}): DeployEventRow => ({
  id: ++evId,
  ticketKey,
  prNumber: null,
  agent: 'desktop-LAPTOP1',
  actor: 'dev@example.com',
  event,
  detail: '',
  createdAt: at,
  ...extra,
});

describe('computeDeployMirror', () => {
  it('folds a lifecycle to its latest state and keeps the original queue time', () => {
    const queue = computeDeployMirror([
      ev('DAT-1', 'queued', '2026-08-25T10:00:00Z'),
      ev('DAT-1', 'started', '2026-08-25T10:05:00Z'),
      ev('DAT-1', 'succeeded', '2026-08-25T10:09:00Z'),
    ]);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ ticketKey: 'DAT-1', state: 'succeeded', queuedAt: '2026-08-25T10:00:00Z', updatedAt: '2026-08-25T10:09:00Z' });
  });

  it('orders deploying first, then queued FIFO, then failed, then succeeded', () => {
    const queue = computeDeployMirror([
      ev('DAT-1', 'queued', '2026-08-25T09:00:00Z'),
      ev('DAT-1', 'started', '2026-08-25T09:01:00Z'),
      ev('DAT-1', 'succeeded', '2026-08-25T09:05:00Z'),
      ev('DAT-2', 'queued', '2026-08-25T09:10:00Z'),
      ev('DAT-3', 'queued', '2026-08-25T09:02:00Z'),
      ev('DAT-3', 'started', '2026-08-25T09:12:00Z'),
      ev('DAT-3', 'failed', '2026-08-25T09:14:00Z', { detail: 'bundle deploy exited 1' }),
      ev('DAT-4', 'queued', '2026-08-25T09:15:00Z'),
      ev('DAT-4', 'started', '2026-08-25T09:16:00Z'),
    ]);
    expect(queue.map((e) => `${e.ticketKey}:${e.state}`)).toEqual([
      'DAT-4:deploying',
      'DAT-2:queued',
      'DAT-3:failed',
      'DAT-1:succeeded',
    ]);
    expect(queue[2].detail).toBe('bundle deploy exited 1');
  });

  it('drops removed entries and starts a fresh cycle after a terminal state', () => {
    const queue = computeDeployMirror([
      ev('DAT-1', 'queued', '2026-08-25T09:00:00Z'),
      ev('DAT-1', 'removed', '2026-08-25T09:01:00Z'),
      ev('DAT-2', 'queued', '2026-08-25T09:02:00Z'),
      ev('DAT-2', 'started', '2026-08-25T09:03:00Z'),
      ev('DAT-2', 'failed', '2026-08-25T09:04:00Z', { detail: 'oops' }),
      ev('DAT-2', 'queued', '2026-08-25T09:30:00Z'),
    ]);
    expect(queue.map((e) => e.ticketKey)).toEqual(['DAT-2']);
    expect(queue[0]).toMatchObject({ state: 'queued', detail: '', queuedAt: '2026-08-25T09:30:00Z' });
  });
});

// ---------- events + board side effects ----------

describe('recordDeployEvent', () => {
  it('started parks the ticket in Deploying and writes a feed item', async () => {
    await record('DAT-1', 'started');
    const t = (await q(`SELECT status FROM app.tickets WHERE key = 'DAT-1'`)).rows[0];
    expect(t.status).toBe('deploying');
    const feed = (await q(`SELECT text, source FROM app.feed_items`)).rows;
    expect(feed).toHaveLength(1);
    expect(String(feed[0].text)).toContain('Local deploy started for DAT-1');
    expect(String(feed[0].text)).toContain('nigel.silva@datavail.com');
    expect(feed[0].source).toBe('deploys');
  });

  it('succeeded settles Done-on-green: ticket to Done, PR deploy_state to success, feed + notification', async () => {
    await q(`INSERT INTO app.repo_connections (engagement_id, repo_name) VALUES ('eng-a', 'org/repo')`);
    await q(`INSERT INTO app.repo_prs (connection_id, number, state, ticket_key, deploy_state) VALUES (1, 7, 'merged', 'DAT-1', 'pending')`);
    await record('DAT-1', 'started');
    await record('DAT-1', 'succeeded', { prNumber: 7 });
    const t = (await q(`SELECT status FROM app.tickets WHERE key = 'DAT-1'`)).rows[0];
    expect(t.status).toBe('done');
    const pr = (await q(`SELECT deploy_state FROM app.repo_prs WHERE number = 7`)).rows[0];
    expect(pr.deploy_state).toBe('success');
    const feed = (await q(`SELECT text FROM app.feed_items ORDER BY id`)).rows;
    const done = String(feed[feed.length - 1].text);
    expect(done).toContain('Local deploy succeeded for DAT-1 (PR #7)');
    expect(done).toContain('moved to Done');
    const notes = (await q(`SELECT recipient_email, title FROM app.notifications`)).rows;
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('DAT-1 moved to Done');
  });

  it('failed keeps the ticket in Deploying and posts the ⚠ warning with the failure reason', async () => {
    await record('DAT-1', 'started');
    await record('DAT-1', 'failed', { detail: 'databricks bundle deploy exited 1\nmore log' });
    const t = (await q(`SELECT status FROM app.tickets WHERE key = 'DAT-1'`)).rows[0];
    expect(t.status).toBe('deploying');
    const feed = (await q(`SELECT text FROM app.feed_items ORDER BY id`)).rows;
    const warning = String(feed[feed.length - 1].text);
    expect(warning).toContain('⚠ Local deploy failed for DAT-1');
    expect(warning).toContain('databricks bundle deploy exited 1');
    expect(warning).toContain('stays in Deploying');
    expect((await q(`SELECT id FROM app.notifications`)).rows).toHaveLength(1);
  });

  it('deduplicates re-announced queued events while the ticket is queued or deploying', async () => {
    expect(await record('DAT-1', 'queued')).toBe(true);
    expect(await record('DAT-1', 'queued')).toBe(false);
    await record('DAT-1', 'started');
    expect(await record('DAT-1', 'queued')).toBe(false);
    await record('DAT-1', 'failed', { detail: 'x' });
    // After a terminal state a fresh queued event starts a new cycle.
    expect(await record('DAT-1', 'queued')).toBe(true);
    const events = (await q(`SELECT event FROM app.deploy_events ORDER BY id`)).rows.map((r) => r.event);
    expect(events).toEqual(['queued', 'started', 'failed', 'queued']);
  });

  it('queued and removed events never move the ticket or write feed items', async () => {
    await record('DAT-1', 'queued');
    await record('DAT-1', 'removed');
    const t = (await q(`SELECT status FROM app.tickets WHERE key = 'DAT-1'`)).rows[0];
    expect(t.status).toBe('review');
    expect((await q(`SELECT id FROM app.feed_items`)).rows).toHaveLength(0);
  });
});

describe('localDeployPending', () => {
  it('is false with no events, true while a cycle exists, false again after removal', async () => {
    expect(await localDeployPending(q, 'DAT-1')).toBe(false);
    await record('DAT-1', 'queued');
    expect(await localDeployPending(q, 'DAT-1')).toBe(true);
    await record('DAT-1', 'started');
    await record('DAT-1', 'failed', { detail: 'x' });
    expect(await localDeployPending(q, 'DAT-1')).toBe(true);
    await record('DAT-1', 'removed');
    expect(await localDeployPending(q, 'DAT-1')).toBe(false);
    expect(await localDeployPending(q, null)).toBe(false);
  });
});

describe('listLocalDeployQueue', () => {
  beforeEach(async () => {
    await q(`INSERT INTO app.team_members (name, email) VALUES ('Nigel Silva', 'nigel.silva@datavail.com'), ('Other Dev', 'other@datavail.com')`);
    await q(`INSERT INTO app.engagement_members (engagement_id, member_id) VALUES ('eng-a', 1), ('eng-a', 2)`);
    await q(`INSERT INTO app.repo_connections (engagement_id, repo_name, repo_url) VALUES ('eng-a', 'org/repo', 'https://github.com/org/repo')`);
  });

  it('lists merged, unsettled PRs for tickets assigned to the caller, oldest merge first', async () => {
    await q(`INSERT INTO app.repo_prs (connection_id, number, state, ticket_key, deploy_state, updated_at) VALUES
      (1, 5, 'merged', 'DAT-1', 'pending', '2026-08-25T09:00:00Z'),
      (1, 6, 'merged', 'DAT-2', 'failed',  '2026-08-25T08:00:00Z'),
      (1, 7, 'open',   'DAT-1', NULL,      '2026-08-25T10:00:00Z')`);
    const items = await listLocalDeployQueue(q, 'NIGEL.SILVA@datavail.com');
    expect(items.map((r) => `${String(r.ticket_key)}#${String(r.pr_number)}`)).toEqual(['DAT-2#6', 'DAT-1#5']);
    expect(items[0]).toMatchObject({ engagement_id: 'eng-a', repo_name: 'org/repo' });
  });

  it("excludes settled deploys, closed tickets, and other people's tickets", async () => {
    await q(`UPDATE app.tickets SET assignee = 'Other Dev' WHERE key = 'DAT-2'`);
    await q(`UPDATE app.tickets SET status = 'done' WHERE key = 'DAT-1'`);
    await q(`INSERT INTO app.repo_prs (connection_id, number, state, ticket_key, deploy_state) VALUES
      (1, 5, 'merged', 'DAT-1', 'pending'),
      (1, 6, 'merged', 'DAT-2', 'pending')`);
    expect(await listLocalDeployQueue(q, 'nigel.silva@datavail.com')).toHaveLength(0);
    const other = await listLocalDeployQueue(q, 'other@datavail.com');
    expect(other.map((r) => r.ticket_key)).toEqual(['DAT-2']);
  });

  it('excludes deploys the CI watch or a local client already settled as success', async () => {
    await q(`INSERT INTO app.repo_prs (connection_id, number, state, ticket_key, deploy_state) VALUES (1, 5, 'merged', 'DAT-1', 'success')`);
    expect(await listLocalDeployQueue(q, 'nigel.silva@datavail.com')).toHaveLength(0);
  });
});
