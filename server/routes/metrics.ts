import type express from 'express';
import { DEFAULT_RATES, addSliceCost, emptyRollup, loadEffectiveRates, sliceCost, type CostRollup, type RateTable } from '../llm/pricing';
import { USAGE_SUM_SQL, usageSums, type UsageSource } from './token-usage';

/**
 * Cross-project Metrics page: velocity & status, token consumption and
 * efficiency gains in one payload (`GET /api/metrics?range=30d&engagement=all`).
 *
 * Every query runs through the tenant-scoped `q`, so the numbers are always
 * the caller's tenant. Volume series are aggregated in SQL (`date_trunc` per
 * day / ISO week); the two things SQL is bad at without window tricks — cycle
 * time percentiles and the end-of-day open count — are derived in TS from a
 * single per-ticket row set (one row per ticket, never per ticket queries).
 *
 * Formulas (also printed on the page):
 *   cycle time      = done_at − first ticket_events row (creation), hours; median and p90 per completion week
 *   open at day d   = tickets created ≤ d that were not done by the end of d (proposed/dismissed excluded)
 *   throughput      = tickets with done_at on that day / in that ISO week
 *   tokens          = input + output, per day per (source, provider, model); cache read / write are
 *                     reported beside it, never counted. Harness rows: a run that reported a final sample
 *                     counts only its final rows (the harness's own total), otherwise its per-turn rows.
 *                     Control-plane rows (the server's own planning / estimate / review calls) each count
 *                     once — same rule as the drawer
 *   cost            = the harness's recorded cost_usd where a row has one, else input×in + output×out +
 *                     cache read×cr + cache write×cw at the workspace's rates for the row's model
 *                     (server/llm/pricing.ts); flagged `costEstimated`. A model nothing prices adds no
 *                     cost and is named in `unpricedModels` rather than counted as $0
 *   cache hit ratio = cache read / (input + cache read)
 *   agent hours     = actual_hours when a run was measured, else the agent estimate (est_hours)
 *   human hours     = human_est_hours (the model's independent human-developer estimate)
 *   hours saved     = human hours − agent hours, over done tickets an agent actually worked on
 *   leverage        = human hours / agent hours;  cost per saved hour = model spend / hours saved
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const METRICS_RANGES = ['7d', '30d', '90d', 'all'] as const;
export type MetricsRange = (typeof METRICS_RANGES)[number];

const RANGE_DAYS: Record<MetricsRange, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null };

export interface MetricsProject {
  id: string;
  client: string;
  name: string;
  health: string;
  /** backlog + progress */
  open: number;
  /** review + deploying */
  review: number;
  done: number;
  proposed: number;
  total: number;
  /** Done tickets whose done_at falls inside the range. */
  doneInRange: number;
}

export interface MetricsReport {
  range: MetricsRange;
  /** ISO start of the window; null for `all`. */
  since: string | null;
  engagement: string | null;
  generatedAt: string;
  projects: MetricsProject[];
  velocity: {
    doneByWeek: { week: string; done: number }[];
    cycleByWeek: { week: string; medianHrs: number | null; p90Hrs: number | null; samples: number }[];
    cycle: { medianHrs: number | null; p90Hrs: number | null; samples: number };
    /** End-of-day open count and that day's completions, oldest first. */
    flow: { date: string; open: number; done: number }[];
    status: { backlog: number; progress: number; review: number; deploying: number; done: number; proposed: number };
  };
  tokens: {
    /** One row per (day, source, provider, model), oldest first. `model` is '' for rows written before models were tracked. */
    perDay: {
      date: string;
      source: UsageSource;
      provider: string;
      model: string;
      tokens: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheCreate: number;
      cost: number | null;
      /** `cost` includes figures estimated from rates. */
      costEstimated: boolean;
      /** Harness runs that reported on that day. */
      runs: number;
      /** Control-plane calls (planning, estimates, reviews, drafts) on that day. */
      calls: number;
    }[];
    topTickets: { key: string; title: string; engagementId: string; tokens: number; cost: number | null; costEstimated: boolean; unpriced: boolean; runs: number }[];
    totals: {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreate: number;
      /** input + output */
      tokens: number;
      cost: number | null;
      costEstimated: boolean;
      /** Models that spent tokens in the window that nothing prices. */
      unpricedModels: string[];
      runs: number;
      controlPlaneCalls: number;
    };
    bySource: { harness: number; controlPlane: number };
    cacheHitRatio: number | null;
  };
  efficiency: {
    /** Per completion week, over done tickets an agent worked on. */
    perWeek: { week: string; tickets: number; agentHrs: number; humanHrs: number; withActual: number }[];
    totals: { tickets: number; agentHrs: number; humanHrs: number; withActual: number };
  };
}

// ---------- coercion ----------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string' || typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? new Date(v).toISOString() : null;
const round1 = (n: number): number => Math.round(n * 10) / 10;

// ---------- pure helpers (unit-tested) ----------

export function parseRange(v: unknown): MetricsRange {
  return typeof v === 'string' && (METRICS_RANGES as readonly string[]).includes(v) ? (v as MetricsRange) : '30d';
}

/** Window start for a range, or null for everything. */
export function rangeSince(range: MetricsRange, now: Date): Date | null {
  const days = RANGE_DAYS[range];
  return days === null ? null : new Date(now.getTime() - days * 86_400_000);
}

/** Nearest-rank percentile on a sample (p in 0..1); null on no samples. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (p <= 0) return round1(s[0]);
  if (p >= 1) return round1(s[s.length - 1]);
  const idx = Math.max(0, Math.ceil(p * s.length) - 1);
  return round1(s[idx]);
}

/** Interpolated median, matching the Analytics tab's definition. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round1(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** ISO week start (Monday, UTC) as YYYY-MM-DD. */
export function weekStart(isoTs: string): string {
  const d = new Date(isoTs);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

export interface TicketRow {
  key: string;
  status: string;
  /** First event on the ticket — creation, or the backfill stamp for pre-trail tickets. */
  createdAt: string | null;
  doneAt: string | null;
}

/** Cycle time per completion week plus the whole-window summary. */
export function cycleTimes(
  tickets: TicketRow[],
  since: Date | null,
): { byWeek: MetricsReport['velocity']['cycleByWeek']; summary: MetricsReport['velocity']['cycle'] } {
  const weeks = new Map<string, number[]>();
  const all: number[] = [];
  for (const t of tickets) {
    if (t.status !== 'done' || !t.doneAt || !t.createdAt) continue;
    const done = new Date(t.doneAt);
    if (since && done < since) continue;
    const hrs = (done.getTime() - new Date(t.createdAt).getTime()) / 3_600_000;
    if (!Number.isFinite(hrs) || hrs < 0) continue;
    all.push(hrs);
    const w = weekStart(t.doneAt);
    const bucket = weeks.get(w) ?? [];
    bucket.push(hrs);
    weeks.set(w, bucket);
  }
  const byWeek = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, hrs]) => ({ week, medianHrs: median(hrs), p90Hrs: percentile(hrs, 0.9), samples: hrs.length }));
  return { byWeek, summary: { medianHrs: median(all), p90Hrs: percentile(all, 0.9), samples: all.length } };
}

const NOT_ON_BOARD = new Set(['proposed', 'dismissed']);
const MAX_FLOW_DAYS = 366;

/**
 * End-of-day open count and daily completions. Open = created on or before
 * the day and not done by the end of it (a reopened ticket has done_at
 * cleared, so it is open again). Capped at a year of days for `all`.
 */
export function flowSeries(tickets: TicketRow[], since: Date | null, now: Date): MetricsReport['velocity']['flow'] {
  const onBoard = tickets.filter((t) => !NOT_ON_BOARD.has(t.status) && t.createdAt);
  if (onBoard.length === 0) return [];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let start: Date;
  if (since) {
    start = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  } else {
    const first = onBoard.reduce((a, t) => Math.min(a, new Date(t.createdAt as string).getTime()), Infinity);
    start = new Date(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth(), new Date(first).getUTCDate()));
  }
  const floor = new Date(end.getTime() - (MAX_FLOW_DAYS - 1) * 86_400_000);
  if (start < floor) start = floor;
  const out: MetricsReport['velocity']['flow'] = [];
  for (let d = start; d <= end; d = new Date(d.getTime() + 86_400_000)) {
    const dayEnd = d.getTime() + 86_400_000;
    let open = 0;
    let done = 0;
    for (const t of onBoard) {
      const created = new Date(t.createdAt as string).getTime();
      const doneAt = t.status === 'done' && t.doneAt ? new Date(t.doneAt).getTime() : null;
      if (created < dayEnd && (doneAt === null || doneAt >= dayEnd)) open++;
      if (doneAt !== null && doneAt >= d.getTime() && doneAt < dayEnd) done++;
    }
    out.push({ date: d.toISOString().slice(0, 10), open, done });
  }
  return out;
}

// ---------- loader ----------

interface Filter {
  since: Date | null;
  engagement: string | null;
}

/** `WHERE`-fragment builder: `col >= $n` for the window and `eng = $n` for one project. */
function where(f: Filter, timeCol: string | null, engCol: string, params: unknown[]): string {
  const parts: string[] = [];
  if (f.since && timeCol) {
    params.push(f.since.toISOString());
    parts.push(`${timeCol} >= $${params.length}::timestamptz`);
  }
  if (f.engagement) {
    params.push(f.engagement);
    parts.push(`${engCol} = $${params.length}`);
  }
  return parts.length ? `AND ${parts.join(' AND ')}` : '';
}

export async function loadMetrics(q: Query, range: MetricsRange, engagement: string | null, now = new Date(), rates: RateTable = DEFAULT_RATES): Promise<MetricsReport> {
  const since = rangeSince(range, now);
  const f: Filter = { since, engagement };

  // One row per ticket: status distribution, cycle times and the open series
  // all derive from this; creation is the first event on the trail.
  const ticketParams: unknown[] = [];
  const ticketRows = (
    await q(
      `SELECT t.key, t.engagement_id, t.status, t.done_at, c.created_at
       FROM app.tickets t
       LEFT JOIN (SELECT ticket_key, MIN(created_at) AS created_at FROM app.ticket_events GROUP BY ticket_key) c
         ON c.ticket_key = t.key
       WHERE t.status <> 'dismissed' ${where(f, null, 't.engagement_id', ticketParams)}`,
      ticketParams,
    )
  ).rows;
  const tickets: (TicketRow & { engagementId: string })[] = ticketRows.map((r) => ({
    key: str(r.key),
    engagementId: str(r.engagement_id),
    status: str(r.status),
    createdAt: iso(r.created_at),
    doneAt: iso(r.done_at),
  }));

  const engParams: unknown[] = [];
  const engRows = (
    await q(
      `SELECT id, client, name, health FROM app.engagements WHERE true ${where(f, null, 'id', engParams)} ORDER BY client, name`,
      engParams,
    )
  ).rows;

  const doneParams: unknown[] = [];
  const doneByWeek = (
    await q(
      `SELECT week, COUNT(*)::int AS done
       FROM (SELECT to_char(date_trunc('week', done_at), 'YYYY-MM-DD') AS week
             FROM app.tickets WHERE status = 'done' AND done_at IS NOT NULL ${where(f, 'done_at', 'engagement_id', doneParams)}) d
       GROUP BY week ORDER BY week`,
      doneParams,
    )
  ).rows.map((r) => ({ week: str(r.week), done: num(r.done) }));

  // Token rows. Harness: a finished run counts its final rows only, an
  // unfinished one its per-turn rows — never both (mirrors foldTicketUsage
  // on the drawer). Control-plane rows have no run and are never final, so
  // each counts once.
  const FOLD = `LEFT JOIN (SELECT DISTINCT task_id FROM app.run_token_usage WHERE final AND source = 'harness') fin ON fin.task_id = u.task_id
       WHERE (u.source = 'control-plane' OR u.final OR fin.task_id IS NULL)`;
  const usageParams: unknown[] = [];
  const usageRows = (
    await q(
      `SELECT date, source, provider, model, ${USAGE_SUM_SQL},
              COUNT(DISTINCT run_id)::int AS runs, SUM(calls)::int AS calls
       FROM (SELECT to_char(date_trunc('day', u.created_at), 'YYYY-MM-DD') AS date, u.source, u.provider, u.model,
                    u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_create_tokens, u.cost_usd,
                    CASE WHEN u.source = 'harness' THEN u.task_id ELSE NULL END AS run_id,
                    CASE WHEN u.source = 'control-plane' THEN 1 ELSE 0 END AS calls
             FROM app.run_token_usage u ${FOLD} ${where(f, 'u.created_at', 'u.engagement_id', usageParams)}) x
       GROUP BY date, source, provider, model ORDER BY date, source, provider, model`,
      usageParams,
    )
  ).rows;
  // Cost per slice by the one shared rule (pricing.ts): recorded where the
  // harness sent it, estimated at the model's rates where it did not.
  const windowCost = emptyRollup();
  const perDay: MetricsReport['tokens']['perDay'] = usageRows.map((r) => {
    const model = str(r.model);
    const { totals, unpriced } = usageSums(r);
    const c = sliceCost({ model, recordedUsd: totals.costUsd, unpriced }, rates);
    addSliceCost(windowCost, model, c);
    return {
      date: str(r.date),
      source: str(r.source) === 'control-plane' ? 'control-plane' : 'harness',
      provider: str(r.provider),
      model,
      tokens: totals.input + totals.output,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheCreate: totals.cacheCreate,
      cost: c.usd,
      costEstimated: c.estimated,
      runs: num(r.runs),
      calls: num(r.calls),
    };
  });

  // Top tickets: one row per (ticket, model) so each model's rate applies,
  // folded per ticket in TS; runs are distinct per ticket, so their own query.
  const topParams: unknown[] = [];
  const topRows = (
    await q(
      `SELECT u.ticket_key, u.engagement_id, u.model, ${USAGE_SUM_SQL}
       FROM app.run_token_usage u ${FOLD} AND u.ticket_key <> '' ${where(f, 'u.created_at', 'u.engagement_id', topParams)}
       GROUP BY u.ticket_key, u.engagement_id, u.model`,
      topParams,
    )
  ).rows;
  const byTicket = new Map<string, { key: string; engagementId: string; tokens: number; cost: CostRollup }>();
  for (const r of topRows) {
    const key = str(r.ticket_key);
    const model = str(r.model);
    const { totals, unpriced } = usageSums(r);
    const t = byTicket.get(key) ?? { key, engagementId: str(r.engagement_id), tokens: 0, cost: emptyRollup() };
    t.tokens += totals.input + totals.output;
    addSliceCost(t.cost, model, sliceCost({ model, recordedUsd: totals.costUsd, unpriced }, rates));
    byTicket.set(key, t);
  }
  const top = [...byTicket.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 8);
  const topMeta = new Map<string, { title: string; runs: number }>();
  if (top.length > 0) {
    const keys = top.map((t) => t.key);
    const marks = keys.map((_, i) => `$${i + 1}`).join(',');
    const runsParamsTop: unknown[] = [...keys];
    for (const r of (
      await q(
        `SELECT u.ticket_key, COUNT(DISTINCT CASE WHEN u.source = 'harness' THEN u.task_id ELSE NULL END)::int AS runs
         FROM app.run_token_usage u ${FOLD} AND u.ticket_key IN (${marks}) ${where(f, 'u.created_at', 'u.engagement_id', runsParamsTop)}
         GROUP BY u.ticket_key`,
        runsParamsTop,
      )
    ).rows) {
      topMeta.set(str(r.ticket_key), { title: '', runs: num(r.runs) });
    }
    for (const r of (await q(`SELECT key, title FROM app.tickets WHERE key IN (${marks})`, keys)).rows) {
      const m = topMeta.get(str(r.key)) ?? { title: '', runs: 0 };
      m.title = str(r.title);
      topMeta.set(str(r.key), m);
    }
  }

  // Runs are distinct per (day, model) row, so the window total needs its own count.
  const runsParams: unknown[] = [];
  const runsRow = (
    await q(
      `SELECT COUNT(DISTINCT u.task_id)::int AS runs FROM app.run_token_usage u WHERE u.source = 'harness' ${where(f, 'u.created_at', 'u.engagement_id', runsParams)}`,
      runsParams,
    )
  ).rows[0];

  // Efficiency: done tickets an agent actually worked on (a claimed run
  // exists), bucketed by completion week.
  const effParams: unknown[] = [];
  const effRows = (
    await q(
      `SELECT week, COUNT(*)::int AS tickets, SUM(human_hrs) AS human_hrs, SUM(agent_hrs) AS agent_hrs, SUM(with_actual)::int AS with_actual
       FROM (SELECT to_char(date_trunc('week', t.done_at), 'YYYY-MM-DD') AS week,
                    COALESCE(t.human_est_hours, 0) AS human_hrs,
                    COALESCE(t.actual_hours, t.est_hours, 0) AS agent_hrs,
                    CASE WHEN t.actual_hours IS NULL THEN 0 ELSE 1 END AS with_actual
             FROM app.tickets t
             JOIN (SELECT DISTINCT ticket_key FROM app.agent_tasks WHERE claimed_at IS NOT NULL) a ON a.ticket_key = t.key
             WHERE t.status = 'done' AND t.done_at IS NOT NULL ${where(f, 't.done_at', 't.engagement_id', effParams)}) x
       GROUP BY week ORDER BY week`,
      effParams,
    )
  ).rows;
  const perWeek: MetricsReport['efficiency']['perWeek'] = effRows.map((r) => ({
    week: str(r.week),
    tickets: num(r.tickets),
    agentHrs: round1(num(r.agent_hrs)),
    humanHrs: round1(num(r.human_hrs)),
    withActual: num(r.with_actual),
  }));

  // ---- fold ----
  const status = { backlog: 0, progress: 0, review: 0, deploying: 0, done: 0, proposed: 0 };
  const perProject = new Map<string, MetricsProject>();
  for (const e of engRows) {
    const id = str(e.id);
    perProject.set(id, { id, client: str(e.client), name: str(e.name), health: str(e.health), open: 0, review: 0, done: 0, proposed: 0, total: 0, doneInRange: 0 });
  }
  for (const t of tickets) {
    if (t.status in status) status[t.status as keyof typeof status]++;
    const p = perProject.get(t.engagementId);
    if (!p) continue;
    p.total++;
    if (t.status === 'backlog' || t.status === 'progress') p.open++;
    else if (t.status === 'review' || t.status === 'deploying') p.review++;
    else if (t.status === 'done') {
      p.done++;
      if (t.doneAt && (!since || new Date(t.doneAt) >= since)) p.doneInRange++;
    } else if (t.status === 'proposed') p.proposed++;
  }

  const cycle = cycleTimes(tickets, since);
  const totals = perDay.reduce(
    (a, r) => ({
      input: a.input + r.input,
      output: a.output + r.output,
      cacheRead: a.cacheRead + r.cacheRead,
      cacheCreate: a.cacheCreate + r.cacheCreate,
      tokens: a.tokens + r.tokens,
      controlPlaneCalls: a.controlPlaneCalls + r.calls,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, tokens: 0, controlPlaneCalls: 0 },
  );
  const bySource = perDay.reduce(
    (a, r) => (r.source === 'harness' ? { ...a, harness: a.harness + r.tokens } : { ...a, controlPlane: a.controlPlane + r.tokens }),
    { harness: 0, controlPlane: 0 },
  );
  const cacheDenom = totals.input + totals.cacheRead;

  return {
    range,
    since: since ? since.toISOString() : null,
    engagement,
    generatedAt: now.toISOString(),
    projects: [...perProject.values()],
    velocity: {
      doneByWeek,
      cycleByWeek: cycle.byWeek,
      cycle: cycle.summary,
      flow: flowSeries(tickets, since, now),
      status,
    },
    tokens: {
      perDay,
      topTickets: top.map((t) => ({
        key: t.key,
        title: topMeta.get(t.key)?.title ?? '',
        engagementId: t.engagementId,
        tokens: t.tokens,
        cost: t.cost.usd,
        costEstimated: t.cost.estimated,
        unpriced: t.cost.unpricedModels.length > 0,
        runs: topMeta.get(t.key)?.runs ?? 0,
      })),
      totals: { ...totals, cost: windowCost.usd, costEstimated: windowCost.estimated, unpricedModels: windowCost.unpricedModels, runs: num(runsRow?.runs) },
      bySource,
      cacheHitRatio: cacheDenom > 0 ? Math.round((totals.cacheRead / cacheDenom) * 100_000) / 100_000 : null,
    },
    efficiency: {
      perWeek,
      totals: perWeek.reduce(
        (a, w) => ({ tickets: a.tickets + w.tickets, agentHrs: round1(a.agentHrs + w.agentHrs), humanHrs: round1(a.humanHrs + w.humanHrs), withActual: a.withActual + w.withActual }),
        { tickets: 0, agentHrs: 0, humanHrs: 0, withActual: 0 },
      ),
    },
  };
}

export function setupMetricsRoutes(app: express.Application, q: Query): void {
  app.get('/api/metrics', async (req, res) => {
    try {
      const range = parseRange(req.query.range);
      const engRaw = typeof req.query.engagement === 'string' ? req.query.engagement.trim() : '';
      const engagement = engRaw && engRaw !== 'all' ? engRaw.slice(0, 120) : null;
      res.json(await loadMetrics(q, range, engagement, new Date(), await loadEffectiveRates(q)));
    } catch (err) {
      console.error('metrics failed:', err);
      res.status(500).json({ error: 'Failed to load metrics' });
    }
  });
}
