import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  FLEET_DOWN_AFTER_MS,
  FLEET_SCHEMA_SQL,
  MAX_RECLAIMS,
  ORPHAN_AFTER_MS,
  RUNNER_OFFLINE_MS,
  humanDuration,
  loadFleetStatus,
  loadRunnerPolls,
  recordFleetDown,
  recordRunnerPoll,
  reclaimOrphanedTasks,
  resetFleetAlerts,
  runnerStatus,
} from './fleet';
import { tenancyTestSql } from '../db/tenancy';

/**
 * The fleet monitor against pg-mem, same harness as the agent-map tests. These
 * pin the distinction the console was missing on 2026-08-13: a runner that is
 * idle-but-polling versus a runner whose process is gone, and queued work that
 * nothing will ever claim.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Columns the fleet queries touch; no FKs (pg-mem needs none, and prod gets
// them from the shared boot migration).
const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, state TEXT NOT NULL, agent TEXT, agent_identity TEXT, claimed_at TIMESTAMPTZ, last_heartbeat TIMESTAMPTZ, last_note TEXT, flag TEXT, result TEXT, reclaims INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL, time_label TEXT NOT NULL, reversible BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE TABLE app.ticket_comments (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT, done_at TIMESTAMPTZ)`,
  `CREATE TABLE app.ticket_events (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
];

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const ago = (msSpan: number): string => new Date(NOW - msSpan).toISOString();
const MINUTE = 60_000;

let q: Query;

/** A runner that reached the server `msSpan` ago. */
const polled = (agent: string, msSpan: number, engagement = '') =>
  q(`INSERT INTO app.runner_polls (agent, engagement_id, source, last_polled_at) VALUES ($1,$2,'poll',$3)`, [
    agent,
    engagement,
    ago(msSpan),
  ]);

/** A queued task that has been waiting `msSpan`. */
const queued = (key: string, msSpan: number, engagement = 'eng-a') =>
  q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, created_at, updated_at) VALUES ($1,$2,'queued',$3,$3)`, [
    key,
    engagement,
    ago(msSpan),
  ]);

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...FLEET_SCHEMA_SQL]) await q(sql);
  for (const sql of tenancyTestSql([...SUPPORT_SQL, ...FLEET_SCHEMA_SQL])) await q(sql);
  resetFleetAlerts();
});

describe('runnerStatus', () => {
  it('separates a polling idle runner from one that stopped reaching the server', () => {
    expect(runnerStatus(0, NOW - MINUTE, null, NOW)).toBe('idle');
    expect(runnerStatus(1, NOW - MINUTE, null, NOW)).toBe('active');
    // The bug: no poll, only stale task history — used to read as 'idle'.
    expect(runnerStatus(0, null, NOW - 9 * 60 * MINUTE, NOW)).toBe('offline');
    expect(runnerStatus(0, null, null, NOW)).toBe('offline');
  });

  it('counts a runner busy on a task as alive via its heartbeats', () => {
    expect(runnerStatus(1, null, NOW - MINUTE, NOW)).toBe('active');
    // Holding a task but silent past the window — the STALLED case.
    expect(runnerStatus(1, null, NOW - RUNNER_OFFLINE_MS - MINUTE, NOW)).toBe('offline');
  });
});

describe('humanDuration', () => {
  it('reads as a person would say it', () => {
    expect(humanDuration(90_000)).toBe('2m');
    expect(humanDuration(60 * MINUTE)).toBe('1h');
    expect(humanDuration(9 * 60 * MINUTE + 4 * MINUTE)).toBe('9h 4m');
  });
});

describe('recordRunnerPoll', () => {
  it('upserts one row per runner and keeps the newest stamp', async () => {
    await recordRunnerPoll(q, 'runner-1', 'eng-a', 'poll');
    await recordRunnerPoll(q, 'runner-1', 'eng-a', 'poll');
    const rows = (await q('SELECT agent, engagement_id FROM app.runner_polls')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: 'runner-1', engagement_id: 'eng-a' });
    expect((await loadRunnerPolls(q)).has('runner-1')).toBe(true);
  });

  it('lets only a poll set the queue scope, so a claim cannot narrow a fleet-wide runner', async () => {
    await recordRunnerPoll(q, 'runner-1', null, 'poll'); // polls every engagement
    await recordRunnerPoll(q, 'runner-1', 'eng-a', 'claim'); // happens to claim on eng-a
    const rows = (await q('SELECT engagement_id, source FROM app.runner_polls')).rows;
    expect(rows[0]).toMatchObject({ engagement_id: '', source: 'claim' });
  });

  it('ignores a blank agent id and survives a missing table', async () => {
    await recordRunnerPoll(q, '   ', 'eng-a', 'poll');
    expect((await q('SELECT agent FROM app.runner_polls')).rows).toHaveLength(0);
    await q('DROP TABLE app.runner_polls');
    // A liveness failure must never break the poll it rides along with.
    await expect(recordRunnerPoll(q, 'runner-1', 'eng-a', 'poll')).resolves.toBeUndefined();
    expect((await loadRunnerPolls(q)).size).toBe(0);
  });
});

describe('loadFleetStatus', () => {
  it('reports a healthy fleet with work queued but runners online', async () => {
    await polled('runner-1', MINUTE);
    await queued('DAT-1', 30 * MINUTE);

    const fleet = await loadFleetStatus(q, 'eng-a', NOW);
    expect(fleet).toMatchObject({ online: 1, offline: 0, queued: 1, down: false, message: null });
    expect(fleet.runners[0]).toMatchObject({ agent: 'runner-1', online: true, busy: false });
  });

  it('raises FLEET DOWN when queued work has waited past the threshold with nobody online', async () => {
    // The 2026-08-13 outage: three runners exited, two tickets sat ~9h.
    await polled('runner-1', 9 * 60 * MINUTE);
    await polled('runner-2', 9 * 60 * MINUTE);
    await polled('runner-3', 9 * 60 * MINUTE);
    await queued('DAT-222', 9 * 60 * MINUTE + 4 * MINUTE);
    await queued('DAT-223', 8 * 60 * MINUTE);

    const fleet = await loadFleetStatus(q, 'eng-a', NOW);
    expect(fleet).toMatchObject({ online: 0, offline: 3, queued: 2, down: true, oldestQueuedKey: 'DAT-222' });
    expect(fleet.message).toContain('All 3 known runners');
    expect(fleet.message).toContain('DAT-222');
    expect(fleet.message).toContain('9h 4m');
  });

  it('holds off while the wait is still short — a queue is not an outage', async () => {
    await polled('runner-1', 30 * MINUTE);
    await queued('DAT-1', FLEET_DOWN_AFTER_MS - MINUTE);

    expect(await loadFleetStatus(q, 'eng-a', NOW)).toMatchObject({ online: 0, offline: 1, down: false });
  });

  it('does not fire with nothing queued, however dead the fleet is', async () => {
    await polled('runner-1', 12 * 60 * MINUTE);

    expect(await loadFleetStatus(q, 'eng-a', NOW)).toMatchObject({ queued: 0, waitingMs: 0, down: false, offline: 1 });
  });

  it('treats a runner busy on a long task as online even though it stopped polling', async () => {
    // Claimed hours ago, still heartbeating — not long-polling for new work.
    await q(
      `INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent, last_heartbeat, created_at, updated_at)
       VALUES ('DAT-9','eng-a','working','runner-1',$1,$2,$1)`,
      [ago(MINUTE), ago(3 * 60 * MINUTE)],
    );
    await polled('runner-1', 3 * 60 * MINUTE);
    await queued('DAT-10', 30 * MINUTE);

    const fleet = await loadFleetStatus(q, 'eng-a', NOW);
    expect(fleet).toMatchObject({ online: 1, down: false });
    expect(fleet.runners[0]).toMatchObject({ agent: 'runner-1', online: true, busy: true });
  });

  it('only counts runners whose queue scope covers the engagement', async () => {
    await polled('fleet-wide', MINUTE, '');
    await polled('eng-b-only', MINUTE, 'eng-b');
    await queued('DAT-1', 30 * MINUTE, 'eng-a');

    const fleet = await loadFleetStatus(q, 'eng-a', NOW);
    expect(fleet.runners.map((r) => r.agent)).toEqual(['fleet-wide']);
    expect(fleet.down).toBe(false);

    // Scope the only live runner elsewhere and eng-a is genuinely stranded.
    await q(`UPDATE app.runner_polls SET engagement_id = 'eng-b' WHERE agent = 'fleet-wide'`);
    expect(await loadFleetStatus(q, 'eng-a', NOW)).toMatchObject({ online: 0, down: true });
  });

  it('forgets runners nobody has heard from in over a day instead of listing them offline forever', async () => {
    await polled('retired-runner', 3 * 24 * 60 * MINUTE);
    await polled('runner-1', 20 * 60 * MINUTE);
    await queued('DAT-1', 60 * MINUTE);

    const fleet = await loadFleetStatus(q, 'eng-a', NOW);
    expect(fleet.runners.map((r) => r.agent)).toEqual(['runner-1']);
    expect(fleet).toMatchObject({ offline: 1, down: true });
    expect(fleet.message).toContain('The only known runner');
  });

  it('still raises the alarm when no runner has ever touched the engagement', async () => {
    await queued('DAT-1', 60 * MINUTE);

    const fleet = await loadFleetStatus(q, 'eng-a', NOW);
    expect(fleet).toMatchObject({ runners: [], online: 0, offline: 0, down: true });
    expect(fleet.message).toContain('No runner has ever reached this engagement');
  });
});

/** A task claimed by `agent` whose last heartbeat was `silentMs` ago. */
const claimedTask = async (key: string, agent: string, silentMs: number, reclaims = 0) => {
  await q(`INSERT INTO app.tickets (key, engagement_id, status, assignee) VALUES ($1,'eng-a','progress',$2)`, [key, agent]);
  await q(
    `INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, agent, agent_identity, claimed_at, last_heartbeat, reclaims, created_at, updated_at)
     VALUES ($1,'eng-a','working',$2,$2,$3,$3,$4,$3,$3)`,
    [key, agent, ago(silentMs), reclaims],
  );
};

const taskRow = async (key: string) =>
  (await q('SELECT state, agent, claimed_at, reclaims, result, last_note FROM app.agent_tasks WHERE ticket_key = $1', [key])).rows[0];

describe('reclaimOrphanedTasks', () => {
  it('releases a task whose runner died mid-run back to the queue', async () => {
    // DAT-219..222 froze in progress for ~8h behind runners that had exited.
    await claimedTask('DAT-219', 'dead-runner', 8 * 60 * MINUTE);

    const reclaimed = await reclaimOrphanedTasks(q, NOW);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ ticketKey: 'DAT-219', agent: 'dead-runner', outcome: 'requeued' });

    // Claimable again by any live runner, and no longer showing as worked.
    expect(await taskRow('DAT-219')).toMatchObject({ state: 'queued', agent: null, claimed_at: null, reclaims: 1 });
    // (The ticket's own status/assignee move goes through setTicketStatus,
    // whose CTE-update pg-mem cannot execute — it is exercised in prod by
    // every cancel and failed completion, which use the same two calls.)
    // And it says why, on the ticket and in the feed.
    expect(String((await q(`SELECT body FROM app.ticket_comments WHERE ticket_key = 'DAT-219'`)).rows[0].body)).toContain(
      'stopped heartbeating',
    );
    expect(String((await q('SELECT text FROM app.feed_items')).rows[0].text)).toContain('released back to the queue');
  });

  it('leaves a runner that is still heartbeating alone', async () => {
    await claimedTask('DAT-219', 'live-runner', ORPHAN_AFTER_MS - MINUTE);

    expect(await reclaimOrphanedTasks(q, NOW)).toEqual([]);
    expect(await taskRow('DAT-219')).toMatchObject({ state: 'working', agent: 'live-runner' });
  });

  it('fails the task instead of cycling once it has been reclaimed too often', async () => {
    await claimedTask('DAT-219', 'dead-runner', 8 * 60 * MINUTE, MAX_RECLAIMS);

    const reclaimed = await reclaimOrphanedTasks(q, NOW);
    expect(reclaimed[0]).toMatchObject({ outcome: 'failed' });
    const row = await taskRow('DAT-219');
    expect(row).toMatchObject({ state: 'failed', reclaims: MAX_RECLAIMS + 1 });
    expect(String(row.result)).toContain('A human should look');
    // Not requeued — nothing is left holding the ticket, so a lead can queue
    // it again deliberately once they know why it keeps dying.
    expect((await q(`SELECT id FROM app.agent_tasks WHERE state IN ('queued','claimed','working')`)).rows).toHaveLength(0);
  });

  it('treats a claim that never heartbeated as orphaned', async () => {
    await claimedTask('DAT-219', 'dead-runner', 60 * MINUTE);
    await q(`UPDATE app.agent_tasks SET last_heartbeat = NULL, claimed_at = NULL, created_at = $1, updated_at = $1`, [ago(60 * MINUTE)]);

    expect(await reclaimOrphanedTasks(q, NOW)).toHaveLength(1);
    expect(await taskRow('DAT-219')).toMatchObject({ state: 'queued' });
  });

  it('a reclaimed task counts as queued work again, so a dead fleet shows FLEET DOWN', async () => {
    await polled('dead-runner', 8 * 60 * MINUTE);
    await claimedTask('DAT-222', 'dead-runner', 8 * 60 * MINUTE);

    await reclaimOrphanedTasks(q, NOW);
    // created_at on the released task is the original claim time, so the wait
    // clock counts from when the work actually stopped moving.
    const fleet = await loadFleetStatus(q, 'eng-a', NOW);
    expect(fleet).toMatchObject({ queued: 1, online: 0, down: true, oldestQueuedKey: 'DAT-222' });
  });
});

describe('recordFleetDown', () => {
  it('writes the outage to the feed once per cooldown window', async () => {
    await polled('runner-1', 9 * 60 * MINUTE);
    await queued('DAT-222', 9 * 60 * MINUTE);
    const fleet = await loadFleetStatus(q, 'eng-a', NOW);

    await recordFleetDown(q, fleet, NOW);
    await recordFleetDown(q, fleet, NOW + MINUTE);
    const rows = (await q('SELECT text FROM app.feed_items')).rows;
    expect(rows).toHaveLength(1);
    expect(String(rows[0].text)).toContain('FLEET DOWN');

    // A new hour, still down — worth saying again.
    await recordFleetDown(q, fleet, NOW + 2 * 60 * MINUTE);
    expect((await q('SELECT text FROM app.feed_items')).rows).toHaveLength(2);
  });

  it('says nothing when the fleet is healthy', async () => {
    await polled('runner-1', MINUTE);
    await queued('DAT-1', 30 * MINUTE);

    await recordFleetDown(q, await loadFleetStatus(q, 'eng-a', NOW), NOW);
    expect((await q('SELECT text FROM app.feed_items')).rows).toHaveLength(0);
  });
});
