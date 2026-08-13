import express from 'express';

/**
 * Organizational velocity KPIs (DAT-193), computed by replaying the ticket
 * event trail (app.ticket_events) against agent task timing and the
 * human/agent estimates. One endpoint answers the questions the Analytics
 * tab asks: how fast ideas reach production, whether the backlog is
 * shrinking, whether the org is getting faster, where decisions wait, and
 * how much human time agent delivery is saving.
 *
 * All computation is pure and unit-tested; the route is a thin data loader.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface VelocityEvent {
  ticketKey: string;
  fromStatus: string | null;
  toStatus: string;
  /** ISO timestamp; events must arrive ordered by this. */
  createdAt: string;
}

export interface VelocityTask {
  ticketKey: string;
  createdAt: string;
  claimedAt: string | null;
}

export interface VelocityTicket {
  key: string;
  status: string;
  estHours: number | null;
  humanEstHours: number | null;
  actualHours: number | null;
}

interface WindowedMedian {
  /** Median hours in the trailing window; null = no samples. */
  current: number | null;
  /** Median hours in the window before that; null = no samples. */
  previous: number | null;
  samples: number;
}

export interface VelocityReport {
  windowDays: number;
  leadTimeHrs: WindowedMedian;
  cycleTimeHrs: WindowedMedian;
  decisionTimeHrs: WindowedMedian;
  /** Share (0-100) of Review entries that went straight to Done; null = no completed review passes yet. */
  reviewPassRate: number | null;
  /** Median hours per pipeline stage, ranked by where work waits. */
  stages: { key: 'queue' | 'build' | 'review'; label: string; medianHrs: number | null; samples: number }[];
  /** End-of-day open-ticket counts (backlog+progress+review) for the trailing 8 weeks. */
  backlog: { date: string; open: number }[];
  /** Open-count change over the trailing window (negative = shrinking). */
  backlogDelta: number | null;
  /** Weekly series, oldest first: throughput and median times per ISO week start. */
  weekly: { week: string; doneCount: number; leadTimeHrs: number | null; cycleTimeHrs: number | null; humanHoursSaved: number }[];
  /** Human-equivalent hours delivered by agent-touched done tickets. */
  humanHoursSaved: { window: number; total: number; agentHoursSpent: number };
  /** First half vs second half of the trail; null until there is >= 14 days of history. */
  thenVsNow: {
    spanDays: number;
    then: { donePerWeek: number; leadTimeHrs: number | null; humanHoursSavedPerWeek: number };
    now: { donePerWeek: number; leadTimeHrs: number | null; humanHoursSavedPerWeek: number };
  } | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round1(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

const hoursBetween = (aIso: string, bIso: string): number => (new Date(bIso).getTime() - new Date(aIso).getTime()) / HOUR_MS;

/** Per-ticket lifecycle facts replayed from the ordered event trail. */
export interface TicketLifecycle {
  key: string;
  createdAt: string;
  /** First move out of backlog/proposed into active work (progress or review). */
  startedAt: string | null;
  /** Last transition into done, while currently done. */
  doneAt: string | null;
  /** Completed review passes: entered → left, with whether the pass was a pass —
   *  i.e. the ticket moved forward (approved into Deploying, or straight to
   *  Done) rather than being bounced back for rework. */
  reviews: { enteredAt: string; leftAt: string; approved: boolean }[];
}

/** Leaving Review for one of these means the reviewer approved the work. */
const APPROVED_EXITS = new Set(['deploying', 'done']);

export function replayLifecycles(events: VelocityEvent[]): Map<string, TicketLifecycle> {
  const map = new Map<string, TicketLifecycle>();
  const inReview = new Map<string, string>();
  for (const ev of events) {
    let t = map.get(ev.ticketKey);
    if (!t) {
      t = { key: ev.ticketKey, createdAt: ev.createdAt, startedAt: null, doneAt: null, reviews: [] };
      map.set(ev.ticketKey, t);
    }
    if (t.startedAt === null && (ev.toStatus === 'progress' || ev.toStatus === 'review')) t.startedAt = ev.createdAt;
    const reviewEntered = inReview.get(ev.ticketKey);
    if (reviewEntered !== undefined && ev.toStatus !== 'review') {
      t.reviews.push({ enteredAt: reviewEntered, leftAt: ev.createdAt, approved: APPROVED_EXITS.has(ev.toStatus) });
      inReview.delete(ev.ticketKey);
    }
    if (ev.toStatus === 'review' && reviewEntered === undefined) inReview.set(ev.ticketKey, ev.createdAt);
    t.doneAt = ev.toStatus === 'done' ? ev.createdAt : null;
  }
  return map;
}

/** ISO week start (Monday, UTC) for a timestamp. */
export function weekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const OPEN_STATUSES = new Set(['backlog', 'progress', 'review', 'deploying']);

function openSeries(events: VelocityEvent[], nowIso: string, days: number): { date: string; open: number }[] {
  if (events.length === 0) return [];
  const status = new Map<string, string>();
  const end = nowIso.slice(0, 10);
  let first = events[0].createdAt.slice(0, 10);
  const minFirst = new Date(new Date(`${end}T00:00:00Z`).getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  if (first < minFirst) first = minFirst;
  const out: { date: string; open: number }[] = [];
  let i = 0;
  for (let d = first; d <= end; ) {
    while (i < events.length && events[i].createdAt.slice(0, 10) <= d) {
      status.set(events[i].ticketKey, events[i].toStatus);
      i++;
    }
    let open = 0;
    for (const s of status.values()) if (OPEN_STATUSES.has(s)) open++;
    out.push({ date: d, open });
    const nd = new Date(`${d}T00:00:00Z`);
    nd.setUTCDate(nd.getUTCDate() + 1);
    d = nd.toISOString().slice(0, 10);
  }
  return out;
}

export function computeVelocity(
  rawEvents: VelocityEvent[],
  tasks: VelocityTask[],
  tickets: VelocityTicket[],
  nowIso: string,
  windowDays = 14,
): VelocityReport {
  // Replay logic depends on chronological order; don't trust callers with it.
  const events = [...rawEvents].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const now = new Date(nowIso).getTime();
  const windowStart = now - windowDays * DAY_MS;
  const prevStart = now - 2 * windowDays * DAY_MS;
  const life = replayLifecycles(events);
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const agentTouched = new Set(tasks.filter((t) => t.claimedAt !== null).map((t) => t.ticketKey));

  const inWindow = (iso: string) => new Date(iso).getTime() >= windowStart;
  const inPrev = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= prevStart && t < windowStart;
  };

  const leadCur: number[] = [];
  const leadPrev: number[] = [];
  const cycleCur: number[] = [];
  const cyclePrev: number[] = [];
  for (const t of life.values()) {
    if (t.doneAt === null) continue;
    const lead = hoursBetween(t.createdAt, t.doneAt);
    const cycle = hoursBetween(t.startedAt ?? t.createdAt, t.doneAt);
    if (inWindow(t.doneAt)) {
      leadCur.push(lead);
      cycleCur.push(cycle);
    } else if (inPrev(t.doneAt)) {
      leadPrev.push(lead);
      cyclePrev.push(cycle);
    }
  }

  const decisionCur: number[] = [];
  const decisionPrev: number[] = [];
  let reviewPasses = 0;
  let reviewApproved = 0;
  const reviewAll: number[] = [];
  for (const t of life.values()) {
    for (const r of t.reviews) {
      const dwell = hoursBetween(r.enteredAt, r.leftAt);
      reviewAll.push(dwell);
      reviewPasses++;
      if (r.approved) {
        reviewApproved++;
        if (inWindow(r.leftAt)) decisionCur.push(dwell);
        else if (inPrev(r.leftAt)) decisionPrev.push(dwell);
      }
    }
  }

  // Stage dwell: where a ticket's calendar time actually goes.
  const queueWaits: number[] = [];
  for (const task of tasks) if (task.claimedAt !== null) queueWaits.push(hoursBetween(task.createdAt, task.claimedAt));
  const buildTimes: number[] = [];
  for (const t of life.values()) {
    if (t.startedAt === null) continue;
    const firstReview = t.reviews[0]?.enteredAt ?? null;
    const end = firstReview ?? t.doneAt;
    if (end !== null) buildTimes.push(hoursBetween(t.startedAt, end));
  }

  // Weekly trend, oldest first, capped at 8 weeks of history.
  const weeks = new Map<string, { done: TicketLifecycle[]; saved: number }>();
  for (const t of life.values()) {
    if (t.doneAt === null) continue;
    const w = weekStart(t.doneAt);
    let bucket = weeks.get(w);
    if (!bucket) {
      bucket = { done: [], saved: 0 };
      weeks.set(w, bucket);
    }
    bucket.done.push(t);
    if (agentTouched.has(t.key)) bucket.saved += byKey.get(t.key)?.humanEstHours ?? 0;
  }
  const weekly = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-8)
    .map(([week, b]) => ({
      week,
      doneCount: b.done.length,
      leadTimeHrs: median(b.done.map((t) => hoursBetween(t.createdAt, t.doneAt as string))),
      cycleTimeHrs: median(b.done.map((t) => hoursBetween(t.startedAt ?? t.createdAt, t.doneAt as string))),
      humanHoursSaved: round1(b.saved),
    }));

  // Human time saved: human-equivalent estimate of agent-delivered done work.
  let savedWindow = 0;
  let savedTotal = 0;
  let agentSpent = 0;
  for (const t of life.values()) {
    if (t.doneAt === null || !agentTouched.has(t.key)) continue;
    const row = byKey.get(t.key);
    const saved = row?.humanEstHours ?? 0;
    savedTotal += saved;
    if (inWindow(t.doneAt)) savedWindow += saved;
    agentSpent += row?.actualHours ?? row?.estHours ?? 0;
  }

  const backlog = openSeries(events, nowIso, 56);
  let backlogDelta: number | null = null;
  if (backlog.length >= 2) {
    const anchor = backlog[Math.max(0, backlog.length - 1 - windowDays)];
    backlogDelta = backlog[backlog.length - 1].open - anchor.open;
  }

  // Then vs now: first half of the trail against the second half.
  let thenVsNow: VelocityReport['thenVsNow'] = null;
  if (events.length > 0) {
    const firstMs = new Date(events[0].createdAt).getTime();
    const spanDays = Math.floor((now - firstMs) / DAY_MS);
    if (spanDays >= 14) {
      const midMs = firstMs + (now - firstMs) / 2;
      const halfWeeks = (now - midMs) / (7 * DAY_MS);
      const halves = { then: { lead: [] as number[], done: 0, saved: 0 }, now: { lead: [] as number[], done: 0, saved: 0 } };
      for (const t of life.values()) {
        if (t.doneAt === null) continue;
        const half = new Date(t.doneAt).getTime() < midMs ? halves.then : halves.now;
        half.done++;
        half.lead.push(hoursBetween(t.createdAt, t.doneAt));
        if (agentTouched.has(t.key)) half.saved += byKey.get(t.key)?.humanEstHours ?? 0;
      }
      thenVsNow = {
        spanDays,
        then: {
          donePerWeek: round1(halves.then.done / halfWeeks),
          leadTimeHrs: median(halves.then.lead),
          humanHoursSavedPerWeek: round1(halves.then.saved / halfWeeks),
        },
        now: {
          donePerWeek: round1(halves.now.done / halfWeeks),
          leadTimeHrs: median(halves.now.lead),
          humanHoursSavedPerWeek: round1(halves.now.saved / halfWeeks),
        },
      };
    }
  }

  return {
    windowDays,
    leadTimeHrs: { current: median(leadCur), previous: median(leadPrev), samples: leadCur.length },
    cycleTimeHrs: { current: median(cycleCur), previous: median(cyclePrev), samples: cycleCur.length },
    decisionTimeHrs: { current: median(decisionCur), previous: median(decisionPrev), samples: decisionCur.length },
    reviewPassRate: reviewPasses > 0 ? Math.round((reviewApproved / reviewPasses) * 100) : null,
    stages: [
      { key: 'queue', label: 'Queue wait (deploy → agent claims)', medianHrs: median(queueWaits), samples: queueWaits.length },
      { key: 'build', label: 'Build (work start → review)', medianHrs: median(buildTimes), samples: buildTimes.length },
      { key: 'review', label: 'Review (human decision)', medianHrs: median(reviewAll), samples: reviewAll.length },
    ],
    backlog,
    backlogDelta,
    weekly,
    humanHoursSaved: { window: round1(savedWindow), total: round1(savedTotal), agentHoursSpent: round1(agentSpent) },
    thenVsNow,
  };
}

const asText = (v: unknown): string | null => (typeof v === 'string' && v ? v : v instanceof Date ? v.toISOString() : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function setupVelocityRoutes(app: express.Application, q: Query) {
  app.get('/api/engagements/:id/velocity', async (req, res) => {
    try {
      const engagementId = req.params.id;
      const events: VelocityEvent[] = (
        await q(
          `SELECT ticket_key, from_status, to_status, created_at FROM app.ticket_events
           WHERE engagement_id = $1 ORDER BY created_at, id`,
          [engagementId],
        )
      ).rows.map((r) => ({
        ticketKey: String(r.ticket_key),
        fromStatus: typeof r.from_status === 'string' && r.from_status ? r.from_status : null,
        toStatus: String(r.to_status),
        createdAt: asText(r.created_at) ?? new Date(0).toISOString(),
      }));
      const tasks: VelocityTask[] = (
        await q(`SELECT ticket_key, created_at, claimed_at FROM app.agent_tasks WHERE engagement_id = $1`, [engagementId])
      ).rows.map((r) => ({
        ticketKey: String(r.ticket_key),
        createdAt: asText(r.created_at) ?? new Date(0).toISOString(),
        claimedAt: asText(r.claimed_at),
      }));
      const tickets: VelocityTicket[] = (
        await q(`SELECT key, status, est_hours, human_est_hours, actual_hours FROM app.tickets WHERE engagement_id = $1`, [engagementId])
      ).rows.map((r) => ({
        key: String(r.key),
        status: String(r.status),
        estHours: asNum(r.est_hours),
        humanEstHours: asNum(r.human_est_hours),
        actualHours: asNum(r.actual_hours),
      }));
      res.json(computeVelocity(events, tasks, tickets, new Date().toISOString()));
    } catch (err) {
      console.error('velocity failed:', err);
      res.status(500).json({ error: 'Failed to compute velocity metrics' });
    }
  });

  // GitHub-style commit activity: synced commits per day for the trailing
  // 8 weeks (DAT-197). Zero-filling is the client's job.
  app.get('/api/engagements/:id/commit-activity', async (req, res) => {
    try {
      const rows = (
        await q(
          `SELECT to_char(date_trunc('day', c.committed_at), 'YYYY-MM-DD') AS date,
                  COUNT(*)::int AS commits, COUNT(DISTINCT c.author)::int AS authors
           FROM app.repo_commits c JOIN app.repo_connections rc ON rc.id = c.connection_id
           WHERE rc.engagement_id = $1 AND c.committed_at IS NOT NULL AND c.committed_at >= NOW() - INTERVAL '182 days'
           GROUP BY 1 ORDER BY 1`,
          [req.params.id],
        )
      ).rows;
      res.json({ days: rows });
    } catch (err) {
      console.error('commit activity failed:', err);
      res.status(500).json({ error: 'Failed to load commit activity' });
    }
  });
}
