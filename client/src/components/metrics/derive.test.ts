import { describe, expect, it } from 'vitest';
import { compact, costPerSavedHour, efficiencyWeeks, fillWeeks, hoursSaved, leverage, perWeekAverage, pivotByModel } from './derive';

describe('efficiency formulas', () => {
  it('hours saved = human estimate − agent hours', () => {
    expect(hoursSaved(8, 1.5)).toBe(6.5);
    expect(hoursSaved(2, 3)).toBe(-1); // an overrun stays visible, not clamped
  });

  it('leverage = human / agent, null without agent time', () => {
    expect(leverage(8, 2)).toBe(4);
    expect(leverage(7, 3)).toBe(2.3);
    expect(leverage(8, 0)).toBeNull();
  });

  it('cost per saved hour = spend / saved, null without spend or savings', () => {
    expect(costPerSavedHour(7.97, 6.5)).toBe(1.23);
    expect(costPerSavedHour(null, 6.5)).toBeNull();
    expect(costPerSavedHour(5, 0)).toBeNull();
  });

  it('accumulates saved hours per completion week, oldest first', () => {
    const weeks = efficiencyWeeks([
      { week: '2026-08-10', tickets: 2, agentHrs: 1, humanHrs: 9, withActual: 1 },
      { week: '2026-08-03', tickets: 1, agentHrs: 0.5, humanHrs: 4, withActual: 0 },
    ]);
    expect(weeks.map((w) => w.week)).toEqual(['2026-08-03', '2026-08-10']);
    expect(weeks.map((w) => w.savedHrs)).toEqual([3.5, 8]);
    expect(weeks.map((w) => w.cumulativeSaved)).toEqual([3.5, 11.5]);
  });
});

describe('pivotByModel', () => {
  const day = (date: string, model: string, tokens: number, cost: number | null = null, provider = 'anthropic') => ({
    date,
    source: 'harness' as const,
    provider,
    model,
    tokens,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    cost,
    costEstimated: false,
    runs: 1,
    calls: 0,
  });

  it('gives every model its own column when they fit, ranked by tokens', () => {
    const p = pivotByModel([day('2026-09-01', 'b', 10, 1), day('2026-09-01', 'a', 30, 2), day('2026-09-02', 'a', 5)]);
    expect(p.models.map((m) => [m.key, m.label, m.provider, m.tokens])).toEqual([
      ['m0', 'a', 'anthropic', 35],
      ['m1', 'b', 'anthropic', 10],
    ]);
    expect(p.rows).toEqual([
      { date: '2026-09-01', m0: 30, m1: 10 },
      { date: '2026-09-02', m0: 5, m1: 0 },
    ]);
    expect(p.costPerDay).toEqual([{ date: '2026-09-01', cost: 3 }]);
    expect(p.models[0].share).toBeCloseTo(35 / 45);
  });

  it('folds the tail past the slot count into "other" and names the empty model', () => {
    const rows = ['', 'b', 'c', 'd', 'e'].map((m, i) => day('2026-09-01', m, 100 - i * 10));
    const p = pivotByModel(rows, 3);
    expect(p.models.map((m) => m.key)).toEqual(['m0', 'm1', 'other']);
    expect(p.models[0].label).toBe('unknown model');
    expect(p.models[2]).toMatchObject({ label: 'other models', tokens: 80 + 70 + 60, runs: 3 });
    expect(p.rows[0]).toEqual({ date: '2026-09-01', m0: 100, m1: 90, other: 210 });
  });

  it('keeps the same model name apart per provider', () => {
    const p = pivotByModel([day('2026-09-01', 'x', 10, null, 'openai'), day('2026-09-01', 'x', 5, null, 'azure')]);
    expect(p.models.map((m) => [m.label, m.provider, m.tokens])).toEqual([
      ['x', 'openai', 10],
      ['x', 'azure', 5],
    ]);
  });

  it('is empty on no usage', () => {
    expect(pivotByModel([])).toEqual({ models: [], rows: [], costPerDay: [] });
  });
});

describe('series helpers', () => {
  it('zero-fills weeks up to the week containing the end date', () => {
    const out = fillWeeks([{ week: '2026-08-31', done: 2 }], new Date('2026-09-16T12:00:00Z'), (week) => ({ week, done: 0 }));
    expect(out).toEqual([
      { week: '2026-08-31', done: 2 },
      { week: '2026-09-07', done: 0 },
      { week: '2026-09-14', done: 0 },
    ]);
    expect(fillWeeks([], new Date(), (week) => ({ week }))).toEqual([]);
  });

  it('averages completions over the weeks present', () => {
    expect(perWeekAverage([])).toBeNull();
    expect(perWeekAverage([{ week: 'a', done: 3 }, { week: 'b', done: 0 }])).toBe(1.5);
  });

  it('compacts figures for tiles', () => {
    expect(compact(950)).toBe('950');
    expect(compact(1234)).toBe('1.2K');
    expect(compact(12_400)).toBe('12K');
    expect(compact(11_370_000)).toBe('11.4M');
    expect(compact(2.25)).toBe('2.3');
  });
});
