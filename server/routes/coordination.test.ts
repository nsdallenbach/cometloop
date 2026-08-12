import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  COORDINATION_SCHEMA_SQL,
  announceBranchActivity,
  completeAgentBranches,
  fetchCoordinationMessages,
  listBranchActivity,
  postCoordinationMessage,
} from './coordination';

/**
 * Runs the coordination library against pg-mem — an in-memory Postgres engine
 * executing the exact SQL (schema, upserts, cursor queries) the console runs
 * against Lakebase Postgres in production. scripts/coordination-roundtrip.mjs
 * replays the same two-agent scenario against the live deployment.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Minimal stand-ins for the console tables the ticket-comment mirror touches.
const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, agent TEXT, state TEXT NOT NULL)`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, assignee TEXT NOT NULL, status TEXT NOT NULL, seq SERIAL)`,
  `CREATE TABLE app.ticket_comments (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL)`,
];

/** The subset of the pg adapter pg-mem hands back (untyped because `pg` itself is not installed). */
interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...COORDINATION_SCHEMA_SQL]) await q(sql);
});

describe('branch activity', () => {
  it('announces a branch and lists it as active', async () => {
    await announceBranchActivity(q, { branch: 'DAT-100-feature-a', agent: 'agent-a', ticket: 'DAT-100', description: 'Build feature A' });
    const active = await listBranchActivity(q);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ branch_name: 'DAT-100-feature-a', agent_id: 'agent-a', ticket_key: 'DAT-100', status: 'active' });
  });

  it('re-announcing heartbeats instead of duplicating, and keeps earlier details', async () => {
    await announceBranchActivity(q, { branch: 'DAT-100-feature-a', agent: 'agent-a', ticket: 'DAT-100', description: 'Build feature A' });
    const updated = await announceBranchActivity(q, { branch: 'DAT-100-feature-a', agent: 'agent-a' });
    expect(updated.ticket_key).toBe('DAT-100');
    expect(updated.task_description).toBe('Build feature A');
    expect(await listBranchActivity(q)).toHaveLength(1);
  });

  it('returns active branches with their tasks, excluding completed ones', async () => {
    await announceBranchActivity(q, { branch: 'DAT-100-feature-a', agent: 'agent-a', ticket: 'DAT-100', description: 'Build feature A' });
    await announceBranchActivity(q, { branch: 'DAT-101-feature-b', agent: 'agent-b', ticket: 'DAT-101', description: 'Build feature B' });
    await announceBranchActivity(q, { branch: 'DAT-099-done', agent: 'agent-c', status: 'completed' });
    const active = await listBranchActivity(q);
    expect(active.map((b) => b.branch_name).sort()).toEqual(['DAT-100-feature-a', 'DAT-101-feature-b']);
    expect(active.map((b) => b.task_description).sort()).toEqual(['Build feature A', 'Build feature B']);
  });

  it('completeAgentBranches closes only that agent\'s active branches', async () => {
    await announceBranchActivity(q, { branch: 'DAT-100-feature-a', agent: 'agent-a', ticket: 'DAT-100' });
    await announceBranchActivity(q, { branch: 'DAT-101-feature-b', agent: 'agent-b', ticket: 'DAT-101' });
    const closed = await completeAgentBranches(q, 'agent-a');
    expect(closed).toEqual(['DAT-100-feature-a']);
    expect((await listBranchActivity(q)).map((b) => b.branch_name)).toEqual(['DAT-101-feature-b']);
    expect((await listBranchActivity(q, 'completed')).map((b) => b.branch_name)).toEqual(['DAT-100-feature-a']);
  });
});

describe('messages', () => {
  it('posts a message with sender, branch, type, sla and payload', async () => {
    const row = await postCoordinationMessage(q, {
      sender: 'agent-a',
      type: 'conflict_warning',
      body: 'We both touch server/routes/api.ts',
      branch: 'DAT-100-feature-a',
      sla: 'wait',
      data: { files: ['server/routes/api.ts'] },
    });
    expect(row).toMatchObject({ sender_agent_id: 'agent-a', message_type: 'conflict_warning', branch_name: 'DAT-100-feature-a', sla: 'wait' });
    expect(row.payload).toMatchObject({ body: 'We both touch server/routes/api.ts', data: { files: ['server/routes/api.ts'] } });
    expect(row.created_at).toBeTruthy();
  });

  it('cursor fetch returns only newer messages, broadcasts included, own messages excluded', async () => {
    await postCoordinationMessage(q, { sender: 'agent-a', type: 'status_update', body: 'starting' });
    const first = await fetchCoordinationMessages(q, { forAgent: 'agent-b' });
    expect(first.messages).toHaveLength(1);

    await postCoordinationMessage(q, { sender: 'agent-b', type: 'status_update', body: 'me too' });
    await postCoordinationMessage(q, { sender: 'agent-a', type: 'status_update', body: 'pushing soon' });
    const second = await fetchCoordinationMessages(q, { forAgent: 'agent-b', sinceId: first.nextSinceId });
    // agent-b's own message is excluded; only agent-a's newer broadcast arrives.
    expect(second.messages.map((m) => m.payload)).toEqual([{ body: 'pushing soon' }]);

    const third = await fetchCoordinationMessages(q, { forAgent: 'agent-b', sinceId: second.nextSinceId });
    expect(third.messages).toHaveLength(0);
    expect(third.nextSinceId).toBe(second.nextSinceId);
  });

  it('targeted messages reach only the recipient (plus broadcasts for everyone)', async () => {
    await postCoordinationMessage(q, { sender: 'agent-a', type: 'poke', body: 'need input', recipient: 'agent-b', sla: 'interrupt' });
    const forB = await fetchCoordinationMessages(q, { forAgent: 'agent-b' });
    const forC = await fetchCoordinationMessages(q, { forAgent: 'agent-c' });
    expect(forB.messages).toHaveLength(1);
    expect(forC.messages).toHaveLength(0);
  });

  it('every message is retained for audit — nothing is deleted by reading', async () => {
    for (let i = 0; i < 5; i++) await postCoordinationMessage(q, { sender: 'agent-a', type: 'status_update', body: `update ${i}` });
    await fetchCoordinationMessages(q, { forAgent: 'agent-b' });
    await fetchCoordinationMessages(q, { forAgent: 'agent-b' });
    const { rows } = await q('SELECT COUNT(*) AS n FROM app.coordination_messages');
    expect(Number(rows[0].n)).toBe(5);
  });

  it('mirrors a targeted message onto the ticket the recipient is working, @-tagged', async () => {
    await q(`INSERT INTO app.tickets (key, assignee, status) VALUES ('DAT-101', 'agent-b', 'progress')`);
    await q(`INSERT INTO app.agent_tasks (ticket_key, agent, state) VALUES ('DAT-101', 'agent-b', 'working')`);
    await postCoordinationMessage(q, { sender: 'agent-a', type: 'request_for_info', body: 'Which schema do you own?', recipient: 'agent-b', sla: 'wait' });
    const comments = (await q('SELECT * FROM app.ticket_comments')).rows;
    expect(comments).toHaveLength(1);
    expect(comments[0].ticket_key).toBe('DAT-101');
    expect(comments[0].author).toBe('agent-a');
    expect(String(comments[0].body)).toContain('@agent-b');
    expect(String(comments[0].body)).toContain('SLA wait');
    expect(String(comments[0].body)).toContain('Which schema do you own?');
  });

  it('mirrors to a ticket in review when the recipient has no active task', async () => {
    await q(`INSERT INTO app.tickets (key, assignee, status) VALUES ('DAT-102', 'agent-b', 'review')`);
    await postCoordinationMessage(q, { sender: 'agent-a', type: 'poke', body: 'quick question', recipient: 'agent-b', sla: 'wait' });
    const comments = (await q('SELECT * FROM app.ticket_comments')).rows;
    expect(comments).toHaveLength(1);
    expect(comments[0].ticket_key).toBe('DAT-102');
  });

  it('does not mirror broadcasts without a ticket, or when mirror is disabled', async () => {
    await postCoordinationMessage(q, { sender: 'agent-a', type: 'status_update', body: 'broadcast only' });
    await q(`INSERT INTO app.tickets (key, assignee, status) VALUES ('DAT-103', 'agent-a', 'progress')`);
    await postCoordinationMessage(q, { sender: 'agent-a', type: 'status_update', body: 'silent', ticket: 'DAT-103' }, { mirror: false });
    expect((await q('SELECT * FROM app.ticket_comments')).rows).toHaveLength(0);
  });
});

describe('two agents on different branches exchange a round-trip message', () => {
  it('request → fetch → response → fetch, all rows retained for audit', async () => {
    // Both agents announce their branches; each can see the other's activity.
    await announceBranchActivity(q, { branch: 'DAT-100-feature-a', agent: 'agent-a', ticket: 'DAT-100', description: 'Build feature A' });
    await announceBranchActivity(q, { branch: 'DAT-101-feature-b', agent: 'agent-b', ticket: 'DAT-101', description: 'Build feature B' });
    expect((await listBranchActivity(q)).map((b) => b.agent_id).sort()).toEqual(['agent-a', 'agent-b']);

    // agent-a asks agent-b for information (SLA: wait).
    await postCoordinationMessage(q, {
      sender: 'agent-a',
      type: 'request_for_info',
      body: 'Are you renaming app.tickets columns on your branch?',
      recipient: 'agent-b',
      branch: 'DAT-100-feature-a',
      sla: 'wait',
    });

    // agent-b polls and sees the request.
    const inbox = await fetchCoordinationMessages(q, { forAgent: 'agent-b' });
    expect(inbox.messages).toHaveLength(1);
    const request = inbox.messages[0];
    expect(request.sender_agent_id).toBe('agent-a');
    expect((request.payload as { body: string }).body).toContain('renaming');

    // agent-b answers back.
    await postCoordinationMessage(q, {
      sender: 'agent-b',
      type: 'response',
      body: 'No — only adding a table, no renames.',
      recipient: 'agent-a',
      branch: 'DAT-101-feature-b',
    });

    // agent-a polls from its cursor and receives the answer: round trip done.
    const reply = await fetchCoordinationMessages(q, { forAgent: 'agent-a' });
    expect(reply.messages.map((m) => (m.payload as { body: string }).body)).toEqual(['No — only adding a table, no renames.']);

    // The whole exchange remains queryable for audit.
    const audit = (await q('SELECT sender_agent_id, recipient_agent_id, message_type FROM app.coordination_messages ORDER BY id')).rows;
    expect(audit).toEqual([
      { sender_agent_id: 'agent-a', recipient_agent_id: 'agent-b', message_type: 'request_for_info' },
      { sender_agent_id: 'agent-b', recipient_agent_id: 'agent-a', message_type: 'response' },
    ]);
  });
});
