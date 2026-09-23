import type { MetricsReport } from '../../types';

/**
 * Pure derivations for the Metrics page — everything the page computes from
 * the server payload lives here so the formulas are unit-tested and printed
 * in one place (the page's footnote quotes them).
 */

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Hours saved = human estimate − agent hours (actual, else agent estimate); negative on an overrun, the page clamps only the headline. */
export const hoursSaved = (humanHrs: number, agentHrs: number): number => round1(humanHrs - agentHrs);

/** Leverage = human hours / agent hours; null when there is no agent time to divide by. */
export const leverage = (humanHrs: number, agentHrs: number): number | null =>
  agentHrs > 0 ? Math.round((humanHrs / agentHrs) * 10) / 10 : null;

/** Cost per saved hour = model spend / hours saved; null without spend or without savings. */
export const costPerSavedHour = (costUsd: number | null, savedHrs: number): number | null =>
  costUsd == null || savedHrs <= 0 ? null : Math.round((costUsd / savedHrs) * 100) / 100;

export interface EfficiencyWeek {
  week: string;
  tickets: number;
  agentHrs: number;
  humanHrs: number;
  savedHrs: number;
  cumulativeSaved: number;
}

/** Per-week saved hours plus the running total, oldest first. */
export function efficiencyWeeks<T extends { week: string; tickets: number; agentHrs: number; humanHrs: number }>(perWeek: T[]): EfficiencyWeek[] {
  let cumulative = 0;
  return [...perWeek]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((w) => {
      const savedHrs = hoursSaved(w.humanHrs, w.agentHrs);
      cumulative = round1(cumulative + savedHrs);
      return { week: w.week, tickets: w.tickets, agentHrs: w.agentHrs, humanHrs: w.humanHrs, savedHrs, cumulativeSaved: cumulative };
    });
}

export interface ModelSeries {
  /** Chart data key (`m0`…`m3`, `other`). */
  key: string;
  /** Display name; '' becomes "unknown model". */
  label: string;
  /** Who served it ('' when the row predates provider tracking; mixed for "other"). */
  provider: string;
  /** input + output over the window */
  tokens: number;
  cost: number | null;
  /** Some of `cost` was estimated from model rates rather than recorded. */
  costEstimated: boolean;
  runs: number;
  share: number;
}

export interface ModelPivot {
  models: ModelSeries[];
  /** One row per day with a column per model key; days with no usage are absent. */
  rows: Record<string, string | number>[];
  costPerDay: { date: string; cost: number }[];
}

export const MODEL_LABEL = (model: string): string => (model === '' ? 'unknown model' : model);

/** Slots for the top N models by tokens; the tail folds into `other`. */
const MAX_MODEL_SLOTS = 4;

/** A model is identified by who served it and what it is called. */
const modelId = (r: { provider: string; model: string }): string => `${r.provider}\u0000${r.model}`;

/**
 * Pivot the per-(day, provider, model) rows into one row per day with a
 * column per model, ranked by tokens over the window. Ranking is fixed for
 * the payload, so a model keeps its column (and colour) from chart to chart
 * on the page.
 */
export function pivotByModel(perDay: MetricsReport['tokens']['perDay'], maxSlots = MAX_MODEL_SLOTS): ModelPivot {
  const byModel = new Map<string, { provider: string; model: string; tokens: number; cost: number | null; costEstimated: boolean; runs: number }>();
  for (const r of perDay) {
    const id = modelId(r);
    const m = byModel.get(id) ?? { provider: r.provider, model: r.model, tokens: 0, cost: null, costEstimated: false, runs: 0 };
    m.tokens += r.tokens;
    if (r.cost != null) m.cost = (m.cost ?? 0) + r.cost;
    if (r.costEstimated) m.costEstimated = true;
    m.runs += r.runs;
    byModel.set(id, m);
  }
  const ranked = [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]));
  const total = ranked.reduce((a, [, m]) => a + m.tokens, 0);
  const slotOf = new Map<string, string>();
  const models: ModelSeries[] = [];
  // When everything fits, every model gets its own slot; otherwise the last
  // slot is "other" so the tail never spills into a generated colour.
  const own = ranked.length <= maxSlots ? ranked.length : maxSlots - 1;
  ranked.forEach(([id, m], i) => {
    if (i < own) {
      const key = `m${i}`;
      slotOf.set(id, key);
      models.push({ key, label: MODEL_LABEL(m.model), provider: m.provider, tokens: m.tokens, cost: m.cost, costEstimated: m.costEstimated, runs: m.runs, share: total > 0 ? m.tokens / total : 0 });
    } else {
      slotOf.set(id, 'other');
      let other = models.find((s) => s.key === 'other');
      if (!other) {
        other = { key: 'other', label: 'other models', provider: '', tokens: 0, cost: null, costEstimated: false, runs: 0, share: 0 };
        models.push(other);
      }
      other.tokens += m.tokens;
      if (m.cost != null) other.cost = (other.cost ?? 0) + m.cost;
      if (m.costEstimated) other.costEstimated = true;
      other.runs += m.runs;
      other.share = total > 0 ? other.tokens / total : 0;
    }
  });

  const days = new Map<string, Record<string, string | number>>();
  const cost = new Map<string, number>();
  for (const r of perDay) {
    const row = days.get(r.date) ?? { date: r.date };
    const key = slotOf.get(modelId(r)) ?? 'other';
    row[key] = Number(row[key] ?? 0) + r.tokens;
    days.set(r.date, row);
    if (r.cost != null) cost.set(r.date, (cost.get(r.date) ?? 0) + r.cost);
  }
  const rows = [...days.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // Every model column exists on every row so stacked bars never see undefined.
  for (const row of rows) for (const m of models) if (row[m.key] === undefined) row[m.key] = 0;
  return {
    models,
    rows,
    costPerDay: [...cost.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, c]) => ({ date, cost: Math.round(c * 100) / 100 })),
  };
}

/**
 * Zero-fill a weekly series between its first week and the week containing
 * `until` so a quiet week reads as a gap, not a missing bar.
 */
export function fillWeeks<T extends { week: string }>(rows: T[], until: Date, make: (week: string) => T): T[] {
  if (rows.length === 0) return [];
  const byWeek = new Map(rows.map((r) => [r.week, r]));
  const start = new Date(`${[...byWeek.keys()].sort()[0]}T00:00:00Z`);
  const day = (until.getUTCDay() + 6) % 7;
  const last = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate() - day));
  const out: T[] = [];
  for (let d = start; d <= last; d = new Date(d.getTime() + 7 * 86_400_000)) {
    const week = d.toISOString().slice(0, 10);
    out.push(byWeek.get(week) ?? make(week));
  }
  return out;
}

/** Sum of a series' completions divided by the number of weeks it spans. */
export function perWeekAverage(doneByWeek: { week: string; done: number }[]): number | null {
  if (doneByWeek.length === 0) return null;
  const total = doneByWeek.reduce((a, w) => a + w.done, 0);
  return round1(total / doneByWeek.length);
}

/** "12.4K" style compact figure for tiles and axes. */
export function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1_000)}K`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
