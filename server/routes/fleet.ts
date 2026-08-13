/**
 * Fleet liveness and orphan recovery (DAT-224): is anything actually out there
 * to pick work up, and does work a dead runner was holding get released?
 *
 * Runner status used to be derived purely from `app.agent_tasks` — a runner
 * with no claimed/working task read as 'idle', which is indistinguishable from
 * a runner whose process exited hours ago. On 2026-08-13 all three runners were
 * dead while the console showed a healthy-looking idle fleet and two tickets sat
 * queued for ~9h with nobody to claim them.
 *
 * The fix is a liveness stamp that only a running runner can produce.
 * `app.runner_polls` records the last time each runner reached the server:
 *
 * - the `/api/agent/work/wait` long-poll (every ~70s: a 55s hold plus the
 *   reconnect) — this is the one that proves an *idle* runner is alive, and it
 *   costs no new traffic because the request was already being made;
 * - claim / progress / heartbeat — a runner busy on a long task is not
 *   long-polling for new work, so its task heartbeats are what keep it online.
 *
 * A runner with no stamp inside the grace window is 'offline', not 'idle'. When
 * work has been queued past the alert threshold and *no* runner for that
 * engagement is online, the board raises FLEET DOWN instead of leaving the card
 * sitting silently in the lane. This is the zero-runners sibling of the
 * wedged-runner STALLED detector (DAT-184).
 *
 * The same incident had a second half. A runner that dies mid-task leaves its
 * row `claimed`/`working` forever: the ticket freezes in progress, and the
 * zombie row is invisible but still authoritative — the queue endpoint listed
 * nothing for the ticket while queueing it again returned 409. So the watch
 * also reclaims: a task whose runner has been silent past the orphan window is
 * released back to `queued` for any live runner to take, and only fails for a
 * human once it has been reclaimed too many times.
 */

import { setTicketStatus } from './ticket-events';

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const FLEET_SCHEMA_SQL = [
  // One row per runner — a runner is a process, not a per-engagement record.
  // engagement_id is the queue scope it last polled ('' = the whole fleet
  // queue, i.e. it will claim work on any engagement).
  `CREATE TABLE IF NOT EXISTS app.runner_polls (
    agent TEXT PRIMARY KEY,
    engagement_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'poll',
    last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

/**
 * How long a runner may go without reaching the server before it counts as
 * offline. The wait long-poll returns after ~55s and the runner reconnects
 * immediately, so a live runner stamps roughly every 70s; task heartbeats run
 * every 120s. Four minutes tolerates a couple of missed cycles (a slow claim, a
 * deploy blink) without calling a healthy fleet dead.
 */
export const RUNNER_OFFLINE_MS = 4 * 60_000;

/**
 * How long queued work may sit with nobody online before it is an outage
 * rather than a queue. A live fleet claims within seconds, so anything past
 * ten minutes with zero online runners is work that will wait forever.
 */
export const FLEET_DOWN_AFTER_MS = 10 * 60_000;

/**
 * How far back a runner still counts as part of the fleet. Without this the
 * offline list would accumulate every runner name ever seen on the engagement;
 * a runner absent for a day has been decommissioned, not lost.
 */
export const FLEET_MEMBER_MS = 24 * 60 * 60_000;

/** Don't re-post the outage to the activity feed more than once an hour. */
const FEED_COOLDOWN_MS = 60 * 60_000;

/**
 * How long a claimed/working task may go without a heartbeat before its runner
 * counts as gone and the task is reclaimed. Runners heartbeat every 2 minutes
 * from the runner process itself — not from the coding agent — so silence here
 * means the process is gone, not that the work got slow. Fifteen minutes is
 * about seven missed beats: far beyond the 3-minute STALLED badge (which only
 * warns a human), and well short of the ~8h these tickets actually froze for.
 */
export const ORPHAN_AFTER_MS = 15 * 60_000;

/**
 * How many times a task may be released back to the queue before it fails for
 * a human instead. Without this, a ticket that reliably kills its runner would
 * cycle claim → die → requeue forever.
 */
export const MAX_RECLAIMS = 2;

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);

const ms = (v: unknown): number | null => {
  const s = iso(v);
  if (s === null) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
};

/** Coarse "9h 4m" / "12m" phrasing for the warning text. */
export function humanDuration(msSpan: number): string {
  const mins = Math.max(0, Math.round(msSpan / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

export interface FleetRunner {
  agent: string;
  /** Last time the runner reached the server (poll, claim or heartbeat). */
  lastPolledAt: string | null;
  /** Last activity on one of this engagement's tasks. */
  lastSeenAt: string | null;
  online: boolean;
  /** Holding a claimed/working task on this engagement right now. */
  busy: boolean;
}

export interface FleetStatus {
  engagementId: string;
  runners: FleetRunner[];
  online: number;
  offline: number;
  /** Tasks sitting in the queue with nobody holding them. */
  queued: number;
  oldestQueuedKey: string | null;
  oldestQueuedAt: string | null;
  /** How long the oldest queued task has waited, ms (0 when nothing queued). */
  waitingMs: number;
  down: boolean;
  /** Board-ready sentence; null unless `down`. */
  message: string | null;
}

/**
 * Stamp a runner's liveness. Bookkeeping must never break the call it rides
 * along with — a failure here is logged and swallowed, because the poll/claim
 * that triggered it is the runner's actual job.
 *
 * Only a poll rewrites the queue scope. Which engagements a runner serves is a
 * property of its poll loop, not of whatever task it happens to be holding —
 * letting a claim narrow an unscoped runner to that task's engagement would
 * make it look absent everywhere else for the length of the run.
 */
export async function recordRunnerPoll(
  q: Query,
  agent: string,
  engagementId: string | null,
  source: 'poll' | 'claim' | 'heartbeat' = 'poll',
): Promise<void> {
  const name = agent.trim().slice(0, 80);
  if (!name) return;
  try {
    await q(
      `INSERT INTO app.runner_polls (agent, engagement_id, source, last_polled_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (agent) DO UPDATE
         SET engagement_id = CASE WHEN $3 = 'poll' THEN $2 ELSE app.runner_polls.engagement_id END,
             source = $3,
             last_polled_at = NOW()`,
      [name, engagementId ?? '', source],
    );
  } catch (err) {
    console.warn(`[fleet] could not stamp poll for '${name}':`, (err as Error).message);
  }
}

/**
 * Fleet health for one engagement. `now` is injectable so the thresholds can be
 * tested without waiting out the clock.
 *
 * A runner counts for this engagement if it polls the whole-fleet queue
 * (engagement_id '') or this engagement specifically, or if it has task history
 * here. Liveness is the later of its poll stamp and its task activity: a runner
 * busy on a three-hour task is not long-polling, and its heartbeats are the
 * proof it is alive.
 */
export async function loadFleetStatus(q: Query, engagementId: string, now: number = Date.now()): Promise<FleetStatus> {
  const polls = (
    await q(`SELECT agent, engagement_id, last_polled_at FROM app.runner_polls WHERE engagement_id = '' OR engagement_id = $1`, [
      engagementId,
    ])
  ).rows;

  const observed = (
    await q(
      `SELECT agent,
              MAX(COALESCE(last_heartbeat, updated_at, created_at)) AS last_seen,
              SUM(CASE WHEN state IN ('claimed','working') THEN 1 ELSE 0 END)::int AS active_tasks
       FROM app.agent_tasks
       WHERE engagement_id = $1 AND agent IS NOT NULL AND agent <> ''
       GROUP BY agent`,
      [engagementId],
    )
  ).rows;

  const queuedRows = (
    await q(
      `SELECT ticket_key, created_at FROM app.agent_tasks
       WHERE engagement_id = $1 AND state = 'queued'
       ORDER BY created_at, id`,
      [engagementId],
    )
  ).rows;

  const polled = new Map<string, number | null>();
  for (const r of polls) polled.set(txt(r.agent), ms(r.last_polled_at));
  const seen = new Map<string, { at: number | null; busy: boolean }>();
  for (const r of observed) seen.set(txt(r.agent), { at: ms(r.last_seen), busy: num(r.active_tasks) > 0 });

  const runners: FleetRunner[] = [];
  for (const agent of new Set([...polled.keys(), ...seen.keys()])) {
    if (!agent) continue;
    const pollAt = polled.get(agent) ?? null;
    const activity = seen.get(agent);
    const seenAt = activity?.at ?? null;
    const liveAt = Math.max(pollAt ?? 0, seenAt ?? 0);
    // Long gone: a runner nobody has heard from in a day is decommissioned,
    // not an outage — drop it rather than growing the offline list forever.
    if (liveAt === 0 || now - liveAt > FLEET_MEMBER_MS) continue;
    runners.push({
      agent,
      lastPolledAt: pollAt === null ? null : new Date(pollAt).toISOString(),
      lastSeenAt: seenAt === null ? null : new Date(seenAt).toISOString(),
      online: now - liveAt <= RUNNER_OFFLINE_MS,
      busy: activity?.busy ?? false,
    });
  }
  runners.sort((a, b) => a.agent.localeCompare(b.agent));

  const online = runners.filter((r) => r.online).length;
  const oldest = queuedRows[0];
  const oldestAt = oldest ? ms(oldest.created_at) : null;
  const waitingMs = oldestAt === null ? 0 : Math.max(0, now - oldestAt);
  const down = queuedRows.length > 0 && online === 0 && waitingMs >= FLEET_DOWN_AFTER_MS;

  // Newest liveness signal across the fleet — "nothing has polled in 9h" is
  // the sentence that would have caught the original outage.
  const lastContact = runners.reduce<number>((acc, r) => {
    const t = Math.max(r.lastPolledAt ? new Date(r.lastPolledAt).getTime() : 0, r.lastSeenAt ? new Date(r.lastSeenAt).getTime() : 0);
    return Math.max(acc, t);
  }, 0);

  return {
    engagementId,
    runners,
    online,
    offline: runners.length - online,
    queued: queuedRows.length,
    oldestQueuedKey: oldest ? txt(oldest.ticket_key) : null,
    oldestQueuedAt: oldest ? iso(oldest.created_at) : null,
    waitingMs,
    down,
    message: down ? fleetDownMessage(runners.length, queuedRows.length, txt(oldest?.ticket_key), waitingMs, lastContact, now) : null,
  };
}

/** The board banner text: what is stuck, for how long, and why nothing moved. */
function fleetDownMessage(
  knownRunners: number,
  queued: number,
  oldestKey: string,
  waitingMs: number,
  lastContact: number,
  now: number,
): string {
  const fleet =
    knownRunners === 0
      ? 'No runner has ever reached this engagement'
      : `${knownRunners === 1 ? 'The only known runner' : `All ${knownRunners} known runners`} last reached the console ${humanDuration(now - lastContact)} ago`;
  const work =
    queued === 1
      ? `${oldestKey || 'A ticket'} has been queued ${humanDuration(waitingMs)}`
      : `${queued} tickets have been queued — the oldest (${oldestKey || 'unknown'}) for ${humanDuration(waitingMs)}`;
  return `${fleet}. ${work} with nothing online to claim it — check that the runner processes are actually running.`;
}

/**
 * Write the outage to the activity feed once per engagement per hour, so the
 * fleet dying leaves a timestamped trace instead of only a banner somebody has
 * to be looking at. In-memory cooldown: a restart may repeat the note once,
 * which is the harmless direction to fail.
 */
const lastFeedAt = new Map<string, number>();

export async function recordFleetDown(q: Query, status: FleetStatus, now: number = Date.now()): Promise<void> {
  if (!status.down || status.message === null) return;
  const last = lastFeedAt.get(status.engagementId) ?? 0;
  if (now - last < FEED_COOLDOWN_MS) return;
  lastFeedAt.set(status.engagementId, now);
  try {
    await q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
       VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
      [status.engagementId, `⚠ FLEET DOWN — ${status.message}`],
    );
    console.warn(`[fleet] ${status.engagementId}: ${status.message}`);
  } catch (err) {
    console.warn('[fleet] could not record the outage on the feed:', (err as Error).message);
  }
}

/** Reset the feed cooldown — tests only. */
export function resetFleetAlerts(): void {
  lastFeedAt.clear();
}

export interface ReclaimedTask {
  taskId: number;
  ticketKey: string;
  engagementId: string;
  /** The runner that went silent holding it. */
  agent: string;
  /** How long it had been silent when we gave up on it. */
  silentMs: number;
  outcome: 'requeued' | 'failed';
}

/**
 * Release tasks whose runner has gone silent. A reclaimed task goes back to
 * `queued` with its agent cleared, so the next live runner claims it normally
 * and the board stops showing the ticket as actively worked.
 *
 * The race with a runner that is merely slow is already handled by the
 * existing liveness contract, in the right direction: once the task is no
 * longer claimed by that agent, its next heartbeat 404s, which runners treat
 * as "the console no longer wants this run" — they kill the child and go back
 * to waiting. A late `complete` from the same zombie is refused for the same
 * reason.
 */
export async function reclaimOrphanedTasks(q: Query, now: number = Date.now()): Promise<ReclaimedTask[]> {
  const candidates = (
    await q(
      `SELECT id, ticket_key, engagement_id, agent, state, reclaims,
              COALESCE(last_heartbeat, claimed_at, updated_at, created_at) AS last_alive
       FROM app.agent_tasks
       WHERE state IN ('claimed','working')
       ORDER BY id`,
    )
  ).rows;

  const reclaimed: ReclaimedTask[] = [];
  for (const row of candidates) {
    const lastAlive = ms(row.last_alive);
    const silentMs = lastAlive === null ? Number.POSITIVE_INFINITY : now - lastAlive;
    if (silentMs < ORPHAN_AFTER_MS) continue;

    const taskId = num(row.id);
    const key = txt(row.ticket_key);
    const engagementId = txt(row.engagement_id);
    const agent = txt(row.agent) || 'the runner';
    const attempts = num(row.reclaims) + 1;
    const silent = Number.isFinite(silentMs) ? humanDuration(silentMs) : 'an unknown time';
    const giveUp = attempts > MAX_RECLAIMS;

    const note = giveUp
      ? `Reclaimed ${MAX_RECLAIMS} times and orphaned again — ${agent} went silent for ${silent} without completing. A human should look before this is queued again.`
      : `Requeued automatically — ${agent} stopped heartbeating ${silent} ago, so the task was released for another runner (attempt ${attempts}/${MAX_RECLAIMS}).`;

    // Releasing the row is the part that matters — it is what unblocks the
    // ticket. If it fails, leave the task alone and try again next tick.
    try {
      if (giveUp) {
        await q(
          `UPDATE app.agent_tasks
           SET state = 'failed', result = $2, flag = NULL, reclaims = $3, updated_at = NOW()
           WHERE id = $1`,
          [taskId, note, attempts],
        );
      } else {
        await q(
          `UPDATE app.agent_tasks
           SET state = 'queued', agent = NULL, agent_identity = NULL, claimed_at = NULL, last_heartbeat = NULL,
               flag = NULL, last_note = $2, reclaims = $3, updated_at = NOW()
           WHERE id = $1`,
          [taskId, note, attempts],
        );
      }
    } catch (err) {
      console.warn(`[fleet] could not reclaim task ${taskId} (${key}):`, (err as Error).message);
      continue;
    }

    console.warn(`[fleet] task ${taskId} (${key}) orphaned by ${agent} after ${silent} of silence — ${giveUp ? 'failed' : 'requeued'}`);
    reclaimed.push({ taskId, ticketKey: key, engagementId, agent, silentMs, outcome: giveUp ? 'failed' : 'requeued' });

    // Telling everyone comes second: the task is already released, so a
    // failure here must not un-report the reclaim (a claim by the next runner
    // resets status and assignee anyway).
    try {
      await comment(q, key, `⚠ ${giveUp ? 'Agent run abandoned: ' : ''}${note}`);
      await feedItem(
        q,
        engagementId,
        giveUp
          ? `⚠ ${key} abandoned — ${agent} died mid-task ${MAX_RECLAIMS + 1} times; the run failed for review.`
          : `⚠ ${key} released back to the queue — ${agent} went silent for ${silent}.`,
      );
      // The ticket is no longer being worked: drop the dead runner as assignee
      // and lift it out of progress, exactly as a cancelled or failed run does.
      await setTicketStatus(q, key, 'backlog', { assignee: '—', onlyIfAssignee: txt(row.agent) });
      await setTicketStatus(q, key, 'backlog', { onlyIfStatus: 'progress' });
    } catch (err) {
      console.warn(`[fleet] reclaimed task ${taskId} (${key}) but could not update the ticket:`, (err as Error).message);
    }
  }
  return reclaimed;
}

const comment = (q: Query, ticketKey: string, body: string) =>
  q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [ticketKey, 'console', body]);

const feedItem = (q: Query, engagementId: string, text: string) =>
  q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
    [engagementId, text],
  );

/**
 * Background fleet watch: reclaim orphaned work, then record an outage on the
 * activity feed for any engagement whose queue is stranded. It runs on a timer
 * rather than off the board poll because both jobs have to happen whether or
 * not anyone has the console open — that is the whole failure being fixed.
 */
export function startFleetWatch(q: Query, intervalMs = 60_000): void {
  const tick = async () => {
    try {
      await reclaimOrphanedTasks(q);
      const engagements = (
        await q(`SELECT DISTINCT engagement_id FROM app.agent_tasks WHERE state = 'queued'`)
      ).rows.map((r) => txt(r.engagement_id));
      for (const engagementId of engagements) {
        if (!engagementId) continue;
        const status = await loadFleetStatus(q, engagementId);
        await recordFleetDown(q, status);
      }
    } catch (err) {
      console.warn('[fleet] watch tick failed:', (err as Error).message);
    }
  };
  setInterval(() => void tick(), intervalMs).unref?.();
}

/** Last poll stamp per runner, for callers that need liveness across engagements. */
export async function loadRunnerPolls(q: Query): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    for (const r of (await q('SELECT agent, last_polled_at FROM app.runner_polls')).rows) {
      const at = ms(r.last_polled_at);
      if (at !== null) map.set(txt(r.agent), at);
    }
  } catch (err) {
    // Pre-migration boot (table not created yet): fall back to task activity
    // alone rather than reporting the whole fleet offline.
    console.warn('[fleet] runner poll stamps unavailable:', (err as Error).message);
  }
  return map;
}

/**
 * What to call a runner on the agent map. 'idle' now means "polling, with
 * nothing to do"; a runner that has stopped reaching the server is 'offline',
 * which is the distinction the console was missing (DAT-224). A runner still
 * holding a task but silent past the window is offline too — that is the same
 * silence the card-level STALLED badge reports.
 */
export function runnerStatus(activeTasks: number, lastPolledAt: number | null, lastSeenAt: number | null, now: number = Date.now()): string {
  const liveAt = Math.max(lastPolledAt ?? 0, lastSeenAt ?? 0);
  if (liveAt === 0 || now - liveAt > RUNNER_OFFLINE_MS) return 'offline';
  return activeTasks > 0 ? 'active' : 'idle';
}
