import { useEffect, useMemo, useState } from 'react';
import type { Engagement, MetricsRange, MetricsReport } from '../types';
import { api } from '../api';
import { fmtHours, HEALTH_COLOR, HEALTH_LABEL, mono } from '../util';
import { fmtCost, fmtCostLabel } from '../lib/usage-format';
import { AreaChart } from './charts/area-chart';
import { Area } from './charts/area';
import { Grid } from './charts/grid';
import { XAxis } from './charts/x-axis';
import { BarChart } from './charts/bar-chart';
import { Bar } from './charts/bar';
import { BarXAxis } from './charts/bar-x-axis';
import { ChartTooltip } from './charts/tooltip';
import { Card, Empty, HBars, Kpi, LegendRow, SectionHead } from './metrics/primitives';
import { td, th } from './metrics/table-styles';
import { compact, costPerSavedHour, efficiencyWeeks, fillWeeks, hoursSaved, leverage, perWeekAverage, pivotByModel } from './metrics/derive';

/**
 * Metrics (/metrics): the cross-project view of velocity & status, token
 * consumption and efficiency gains. One payload from `GET /api/metrics`,
 * scoped by the filter row (project × range) that every chart below shares.
 * Same chart components, tokens and card idioms as a project's Analytics tab;
 * the desktop reaches it through the embedded webview.
 */

const RANGES: { key: MetricsRange; label: string }[] = [
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: 'all', label: 'All' },
];

// Colour by entity, fixed for the page: tickets/done = brand red, agent
// effort = periwinkle, human/estimate/open = the neutral gray.
const C_DONE = 'var(--chart-1)';
const C_AGENT = 'var(--chart-2)';
const C_NEUTRAL = 'var(--chart-3)';
const C_REVIEW = 'var(--chart-2)';
const C_OPEN = 'var(--chart-4)';
/** Model slots in rank order; the fifth is always "other". */
const MODEL_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

const MARGIN = { top: 16, right: 16, bottom: 28, left: 34 };
const KPI_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 14 } as const;
const CHART_GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 14, marginBottom: 14 } as const;

const weekLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const pctLabel = (ratio: number | null) => (ratio == null ? '—' : `${(ratio * 100).toFixed(ratio >= 0.999 ? 3 : 1)}%`);
/** Every hour figure on this page is hours, never days (36m, 18.7h, 505.7h, 1,240h). */
const hrs = (h: number | null | undefined) => fmtHours(h);
/** Area charts parse `date` with `new Date()`; noon UTC keeps the calendar day stable in every timezone. */
const noon = (iso: string) => `${iso}T12:00:00Z`;

export function Metrics({ engagements }: { engagements: Engagement[] }) {
  const [range, setRange] = useState<MetricsRange>('30d');
  const [engagement, setEngagement] = useState<string | null>(null);
  const [report, setReport] = useState<MetricsReport | null>(null);
  // Which filter the last answer (or failure) was for; loading = it is not the current one.
  const [answered, setAnswered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterKey = `${range}|${engagement ?? 'all'}`;
  const loading = answered !== filterKey;

  useEffect(() => {
    let stale = false;
    api
      .metrics(range, engagement)
      .then((r) => {
        if (stale) return;
        setReport(r);
        setError(null);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      })
      .finally(() => {
        if (!stale) setAnswered(filterKey);
      });
    return () => {
      stale = true;
    };
  }, [range, engagement, filterKey]);

  const now = useMemo(() => (report ? new Date(report.generatedAt) : new Date()), [report]);
  const rangeCaption = range === 'all' ? 'ALL TIME' : `TRAILING ${range.toUpperCase()}`;
  const scopeCaption = engagement ? (engagements.find((e) => e.id === engagement)?.client ?? engagement).toUpperCase() : 'ALL PROJECTS';

  const nothing = report !== null && report.projects.every((p) => p.total === 0) && report.tokens.perDay.length === 0;

  return (
    <div className="tab-pane" style={{ flex: 1, overflow: 'auto', padding: '18px 22px 40px' }}>
      <div style={{ maxWidth: 1360, margin: '0 auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 14px', marginBottom: 12 }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Metrics</h1>
          <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>
            {scopeCaption} · {rangeCaption}
          </span>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', animation: 'eec-pulse 2.4s infinite', alignSelf: 'center' }} />
          <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>LIVE — SYNCED WITH THE BOARDS</span>
        </div>

        {/* One filter row scopes everything below it. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 6px', marginBottom: 6 }}>
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>RANGE</span>
          {RANGES.map((r) => {
            const active = r.key === range;
            return (
              <button
                key={r.key}
                className="hv-border"
                onClick={() => setRange(r.key)}
                style={{
                  border: `1px solid ${active ? 'var(--tx3)' : 'var(--line)'}`,
                  background: active ? 'var(--bg3)' : 'transparent',
                  color: active ? 'var(--tx)' : 'var(--tx2)',
                  borderRadius: 3,
                  padding: '4px 9px',
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                {r.label}
              </button>
            );
          })}
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginLeft: 10 }}>PROJECT</span>
          <select
            value={engagement ?? 'all'}
            onChange={(e) => setEngagement(e.target.value === 'all' ? null : e.target.value)}
            style={{ fontSize: 11, padding: '4px 8px', minWidth: 140 }}
          >
            <option value="all">All projects</option>
            {engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.client} — {e.name}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', margin: '12px 0', border: '1px solid var(--bad)', borderRadius: 4, color: 'var(--bad)', ...mono(400, 11) }}>
            COULDN’T LOAD METRICS: {error}
          </div>
        )}

        {nothing ? (
          <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '44px 20px', textAlign: 'center', marginTop: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Nothing to chart yet</div>
            <div style={{ fontSize: 12, color: 'var(--tx2)' }}>Metrics build themselves from board tickets, agent runs and token usage as work starts.</div>
          </div>
        ) : (
          // Refetch keeps the frame: the previous render dims instead of flashing a skeleton.
          <div style={{ opacity: loading && report ? 0.55 : 1, transition: 'opacity .2s' }}>
            <VelocitySection report={report} now={now} range={range} />
            <TokensSection report={report} />
            <EfficiencySection report={report} now={now} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 1. velocity & status ----------

function VelocitySection({ report, now, range }: { report: MetricsReport | null; now: Date; range: MetricsRange }) {
  const v = report?.velocity;
  const loading = report === null;

  const doneWeeks = useMemo(
    () => (v ? fillWeeks(v.doneByWeek, now, (week) => ({ week, done: 0 })).map((w) => ({ ...w, label: weekLabel(w.week) })) : []),
    [v, now],
  );
  // Only weeks with completions: a quiet week has no cycle time, not a 0h one.
  const cycleWeeks = useMemo(
    () => (v ? v.cycleByWeek.map((w) => ({ date: noon(w.week), median: w.medianHrs ?? 0, p90: w.p90Hrs ?? 0, samples: w.samples })) : []),
    [v],
  );
  const statusRows = useMemo(
    () =>
      (report?.projects ?? [])
        .filter((p) => p.total > 0)
        .map((p) => ({ name: p.client, Open: p.open, 'In review': p.review, Done: p.done })),
    [report],
  );

  const doneTotal = v ? v.doneByWeek.reduce((a, w) => a + w.done, 0) : 0;
  const perWeek = v ? perWeekAverage(doneWeeks) : null;
  const openNow = v ? v.status.backlog + v.status.progress : 0;
  const onTrack = report ? report.projects.filter((p) => p.health === 'ok').length : 0;
  const atRisk = report ? report.projects.filter((p) => p.health === 'risk').length : 0;
  const offTrack = report ? report.projects.filter((p) => p.health === 'off').length : 0;
  const flow = useMemo(() => (v ? v.flow.map((d) => ({ ...d, date: noon(d.date) })) : []), [v]);
  const flowLast = v && v.flow.length > 0 ? v.flow[v.flow.length - 1] : null;
  const flowFirst = v && v.flow.length > 0 ? v.flow[0] : null;
  const flowDelta = flowLast && flowFirst ? flowLast.open - flowFirst.open : null;

  return (
    <>
      <SectionHead title="VELOCITY & STATUS" caption={`COMPLETIONS BY ISO WEEK · CYCLE TIME = CREATED → DONE · ${range === 'all' ? 'ALL TIME' : `TRAILING ${range.toUpperCase()}`}`} />
      <div style={KPI_GRID}>
        <Kpi label="TICKETS DONE" value={loading ? '—' : String(doneTotal)} sub={perWeek == null ? 'NO COMPLETIONS IN RANGE' : `≈ ${perWeek} PER WEEK`} />
        <Kpi
          label="CYCLE TIME · MEDIAN"
          value={loading ? '—' : hrs(v?.cycle.medianHrs)}
          sub={v && v.cycle.samples > 0 ? `P90 ${hrs(v.cycle.p90Hrs).toUpperCase()} · ${v.cycle.samples} SAMPLES` : 'CREATED → DONE'}
        />
        <Kpi
          label="OPEN NOW"
          value={loading ? '—' : String(openNow)}
          sub={v ? `${v.status.review} IN REVIEW · ${v.status.deploying} DEPLOYING · ${v.status.proposed} PROPOSED` : undefined}
          color={flowDelta != null && flowDelta > 0 ? 'var(--warn)' : undefined}
        />
        <Kpi
          label="PROJECTS ON TRACK"
          value={loading ? '—' : `${onTrack} / ${report?.projects.length ?? 0}`}
          sub={report ? `${atRisk} AT RISK · ${offTrack} OFF TRACK` : undefined}
          color={offTrack > 0 ? 'var(--bad)' : atRisk > 0 ? 'var(--warn)' : 'var(--ok)'}
        />
      </div>

      <div style={CHART_GRID}>
        <Card title="TICKETS DONE PER WEEK" caption={doneTotal === 0 && !loading ? 'No completions in this window yet.' : 'Moved to Done, by the ISO week it happened.'}>
          {loading || doneWeeks.length > 0 ? (
            <BarChart data={doneWeeks} xDataKey="label" aspectRatio="2.6 / 1" barGap={0.35} barWidth={doneWeeks.length < 4 ? 40 : undefined} margin={MARGIN} status={loading ? 'loading' : 'ready'}>
              <Grid horizontal numTicksRows={4} />
              <Bar dataKey="done" fill={C_DONE} lineCap={3} />
              <BarXAxis maxLabels={8} />
              <ChartTooltip showDatePill={false} showCrosshair={false} rows={(p) => [{ color: C_DONE, label: 'Done', value: Number(p.done ?? 0) }]} />
            </BarChart>
          ) : (
            <Empty>NO TICKETS DONE IN THIS WINDOW</Empty>
          )}
        </Card>

        <Card
          title="CYCLE TIME — CREATED → DONE"
          caption={v && v.cycle.samples > 0 ? 'Median and p90 hours per completion week — down and to the right is the goal.' : 'Draws itself from completions.'}
        >
          {loading || cycleWeeks.length >= 2 ? (
            <>
              <LegendRow
                items={[
                  { label: 'MEDIAN', color: C_AGENT, n: v ? hrs(v.cycle.medianHrs) : undefined },
                  { label: 'P90', color: C_NEUTRAL, n: v ? hrs(v.cycle.p90Hrs) : undefined },
                ]}
              />
              <AreaChart data={cycleWeeks} xDataKey="date" aspectRatio="2.6 / 1" margin={MARGIN} status={loading ? 'loading' : 'ready'} loadingLabel="Loading">
                <Grid horizontal numTicksRows={4} />
                <Area dataKey="p90" fill={C_NEUTRAL} fillOpacity={0.12} />
                <Area dataKey="median" fill={C_AGENT} fillOpacity={0.25} />
                <XAxis numTicks={Math.min(6, Math.max(2, cycleWeeks.length))} />
                <ChartTooltip
                  rows={(p) => [
                    { color: C_AGENT, label: 'Median', value: hrs(Number(p.median ?? 0)) },
                    { color: C_NEUTRAL, label: 'p90', value: hrs(Number(p.p90 ?? 0)) },
                    { color: 'var(--tx3)', label: 'Samples', value: Number(p.samples ?? 0) },
                  ]}
                />
              </AreaChart>
            </>
          ) : (
            <Empty>{cycleWeeks.length === 1 ? `ONE COMPLETION WEEK — MEDIAN ${hrs(v?.cycle.medianHrs).toUpperCase()} · P90 ${hrs(v?.cycle.p90Hrs).toUpperCase()}` : 'NO COMPLETIONS TO TIME YET'}</Empty>
          )}
        </Card>
      </div>

      <div style={CHART_GRID}>
        <Card
          title="THROUGHPUT VS OPEN"
          caption={
            flowDelta == null
              ? 'Open tickets at the end of each day against that day’s completions.'
              : flowDelta < 0
                ? `Open count shrinking — ${Math.abs(flowDelta)} fewer than at the start of the window.`
                : flowDelta === 0
                  ? 'Open count flat over the window.'
                  : `Open count growing — ${flowDelta} more than at the start of the window.`
          }
        >
          {loading || (v && v.flow.length >= 2) ? (
            <>
              <LegendRow
                items={[
                  { label: 'OPEN', color: C_OPEN, n: flowLast?.open },
                  { label: 'DONE THAT DAY', color: C_DONE },
                ]}
              />
              <AreaChart data={flow} xDataKey="date" aspectRatio="2.6 / 1" margin={MARGIN} status={loading ? 'loading' : 'ready'} loadingLabel="Loading">
                <Grid horizontal numTicksRows={4} />
                <Area dataKey="open" fill={C_OPEN} fillOpacity={0.25} />
                <Area dataKey="done" fill={C_DONE} fillOpacity={0.25} />
                <XAxis numTicks={6} />
                <ChartTooltip
                  rows={(p) => [
                    { color: C_OPEN, label: 'Open', value: Number(p.open ?? 0) },
                    { color: C_DONE, label: 'Done', value: Number(p.done ?? 0) },
                  ]}
                />
              </AreaChart>
            </>
          ) : (
            <Empty>{flowLast ? `OPEN NOW: ${flowLast.open}` : 'HISTORY BUILDS FROM THE FIRST STATUS CHANGE'}</Empty>
          )}
        </Card>

        <Card title="STATUS BY PROJECT" caption="Everything on each board today — open, in review or deploying, done.">
          {loading || statusRows.length > 0 ? (
            <>
              <LegendRow
                items={[
                  { label: 'OPEN', color: C_OPEN, n: v ? v.status.backlog + v.status.progress : undefined },
                  { label: 'IN REVIEW', color: C_REVIEW, n: v ? v.status.review + v.status.deploying : undefined },
                  { label: 'DONE', color: C_DONE, n: v?.status.done },
                ]}
              />
              <BarChart data={statusRows} xDataKey="name" aspectRatio="2.6 / 1" barGap={0.4} barWidth={statusRows.length < 4 ? 56 : undefined} stacked stackGap={2} margin={MARGIN} status={loading ? 'loading' : 'ready'}>
                <Grid horizontal numTicksRows={4} />
                <Bar dataKey="Open" fill={C_OPEN} lineCap={2} />
                <Bar dataKey="In review" fill={C_REVIEW} lineCap={2} />
                <Bar dataKey="Done" fill={C_DONE} lineCap={2} />
                <BarXAxis maxLabels={8} />
                <ChartTooltip showDatePill={false} showCrosshair={false} />
              </BarChart>
            </>
          ) : (
            <Empty>NO TICKETS ON ANY BOARD</Empty>
          )}
        </Card>
      </div>

      <div style={{ marginBottom: 14 }}>
        <Card title="PROJECTS" caption="Health as set on the portfolio; counts are today’s board.">
          {report && report.projects.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 520 }}>
                <thead>
                  <tr>
                    <th style={th()}>PROJECT</th>
                    <th style={th()}>HEALTH</th>
                    <th style={th('right')}>OPEN</th>
                    <th style={th('right')}>IN REVIEW</th>
                    <th style={th('right')}>DONE</th>
                    <th style={th('right')}>DONE IN RANGE</th>
                    <th style={th('right')}>TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  {report.projects.map((p) => {
                    const health = p.health === 'ok' || p.health === 'risk' || p.health === 'off' ? p.health : 'ok';
                    return (
                      <tr key={p.id}>
                        <td style={td()}>
                          <span style={{ color: 'var(--tx)', fontWeight: 600 }}>{p.client}</span>
                          <span style={{ color: 'var(--tx3)', marginLeft: 8, fontSize: 11.5 }}>{p.name}</span>
                        </td>
                        <td style={td()}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...mono(500, 10), letterSpacing: '.06em', color: HEALTH_COLOR[health] }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: HEALTH_COLOR[health] }} />
                            {HEALTH_LABEL[health]}
                          </span>
                        </td>
                        <td style={td('right')}>{p.open}</td>
                        <td style={td('right')}>{p.review}</td>
                        <td style={td('right')}>{p.done}</td>
                        <td style={td('right')}>{p.doneInRange}</td>
                        <td style={td('right')}>{p.total}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{loading ? 'LOADING…' : 'NO PROJECTS IN SCOPE'}</Empty>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------- 2. token consumption ----------

function TokensSection({ report }: { report: MetricsReport | null }) {
  const t = report?.tokens;
  const loading = report === null;
  const pivot = useMemo(() => pivotByModel(t?.perDay ?? []), [t]);
  const tokenRows = useMemo(() => pivot.rows.map((r) => ({ ...r, label: dayLabel(String(r.date)) })), [pivot]);
  const costRows = useMemo(() => pivot.costPerDay.map((d) => ({ ...d, date: noon(d.date) })), [pivot]);
  const colorOf = (key: string) => (key === 'other' ? MODEL_COLORS[4] : MODEL_COLORS[Number(key.slice(1))] ?? MODEL_COLORS[4]);
  const modelLabel = (m: { label: string; provider: string }) => (m.provider ? `${m.label} · ${m.provider}` : m.label);
  const hasUsage = !!t && t.perDay.length > 0;
  const hasCost = !!t && t.totals.cost != null;

  return (
    <>
      <SectionHead title="TOKEN CONSUMPTION" caption="EVERY MODEL CALL METERED — AGENT HARNESSES AND THE CONTROL PLANE'S OWN PLANNING, ESTIMATE AND REVIEW CALLS" />
      <div style={KPI_GRID}>
        <Kpi
          label="TOKENS · IN + OUT"
          value={loading ? '—' : compact(t?.totals.tokens ?? 0)}
          sub={t ? `HARNESS ${compact(t.bySource.harness)} · CONTROL PLANE ${compact(t.bySource.controlPlane)}` : undefined}
        />
        <Kpi
          label="MODEL SPEND"
          value={loading ? '—' : !t || t.totals.cost == null ? (t?.totals.unpricedModels.length ? 'est. —' : '—') : fmtCostLabel({ usd: t.totals.cost, estimated: t.totals.costEstimated, unpriced: [] })}
          sub={
            t
              ? `${t.totals.runs} RUN${t.totals.runs === 1 ? '' : 'S'} · ${t.totals.controlPlaneCalls} CONTROL-PLANE CALL${t.totals.controlPlaneCalls === 1 ? '' : 'S'}${t.totals.costEstimated ? ' · EST. FROM MODEL RATES' : ''}${t.totals.unpricedModels.length ? ` · NO RATE FOR ${t.totals.unpricedModels.join(', ').toUpperCase()}` : ''}`
              : undefined
          }
        />
        <Kpi label="CACHE HIT RATIO" value={loading ? '—' : pctLabel(t?.cacheHitRatio ?? null)} sub="CACHE READ ÷ (INPUT + CACHE READ)" />
        <Kpi
          label="OUTPUT TOKENS"
          value={loading ? '—' : compact(t?.totals.output ?? 0)}
          sub={t ? `INPUT ${compact(t.totals.input)} · CACHE ${compact(t.totals.cacheRead)} READ · ${compact(t.totals.cacheCreate)} WRITTEN` : undefined}
        />
      </div>

      <div style={CHART_GRID}>
        <Card title="TOKENS PER DAY — BY MODEL" caption={hasUsage ? 'Input and output tokens stacked by the model that spent them; cache traffic is reported, not counted.' : 'Fills in as runs report usage.'}>
          {loading || tokenRows.length > 0 ? (
            <>
              <LegendRow items={pivot.models.map((m) => ({ label: modelLabel(m).toUpperCase(), color: colorOf(m.key), n: compact(m.tokens) }))} />
              <BarChart data={tokenRows} xDataKey="label" aspectRatio="2.6 / 1" barGap={0.35} barWidth={tokenRows.length < 5 ? 40 : undefined} stacked stackGap={2} margin={{ ...MARGIN, left: 44 }} status={loading ? 'loading' : 'ready'}>
                <Grid horizontal numTicksRows={4} />
                {pivot.models.map((m) => (
                  <Bar key={m.key} dataKey={m.key} fill={colorOf(m.key)} lineCap={2} />
                ))}
                <BarXAxis maxLabels={8} />
                <ChartTooltip
                  showDatePill={false}
                  showCrosshair={false}
                  rows={(p) => pivot.models.map((m) => ({ color: colorOf(m.key), label: modelLabel(m), value: compact(Number(p[m.key] ?? 0)) }))}
                />
              </BarChart>
            </>
          ) : (
            <Empty>NO USAGE REPORTED IN THIS WINDOW</Empty>
          )}
        </Card>

        <Card title="COST PER DAY" caption={hasCost ? (t.totals.costEstimated ? 'USD as the harness recorded it where it did; the rest estimated at the workspace’s model rates (est.).' : 'USD as reported by the harness on each finished run.') : 'Fills in as usage is priced — recorded by the harness, or estimated from the model rates under Admin.'}>
          {loading || costRows.length >= 2 ? (
            <AreaChart data={costRows} xDataKey="date" aspectRatio="2.6 / 1" margin={{ ...MARGIN, left: 44 }} status={loading ? 'loading' : 'ready'} loadingLabel="Loading">
              <Grid horizontal numTicksRows={4} />
              <Area dataKey="cost" fill={C_AGENT} fillOpacity={0.25} />
              <XAxis numTicks={Math.min(6, Math.max(2, costRows.length))} />
              <ChartTooltip rows={(p) => [{ color: C_AGENT, label: 'Cost', value: fmtCost(Number(p.cost ?? 0)) }]} />
            </AreaChart>
          ) : costRows.length === 1 ? (
            <Empty>{`ONE DAY WITH COST — ${fmtCost(pivot.costPerDay[0].cost)} ON ${dayLabel(pivot.costPerDay[0].date).toUpperCase()}`}</Empty>
          ) : (
            <Empty>{hasUsage ? 'NO COST REPORTED — RUNS IN THIS WINDOW NEVER SENT A FINAL SAMPLE' : 'NO USAGE REPORTED IN THIS WINDOW'}</Empty>
          )}
        </Card>
      </div>

      <div style={CHART_GRID}>
        <Card title="SHARE BY MODEL" caption="Tokens per model over the window, then by who spent them.">
          {pivot.models.length > 0 ? (
            <>
              <HBars
                rows={pivot.models.map((m) => ({
                  key: m.key,
                  label: m.label,
                  sub: m.provider ? m.provider.toUpperCase() : undefined,
                  value: m.tokens,
                  display: `${compact(m.tokens)} · ${Math.round(m.share * 100)}%${m.cost != null ? ` · ${m.costEstimated ? 'est. ' : ''}${fmtCost(m.cost)}` : ''}`,
                  color: colorOf(m.key),
                }))}
              />
              <div style={{ borderTop: '1px solid var(--line)', marginTop: 12, paddingTop: 12 }}>
                <HBars
                  rows={[
                    { key: 'harness', label: 'Agent harnesses', value: t?.bySource.harness ?? 0, display: compact(t?.bySource.harness ?? 0), color: C_AGENT },
                    { key: 'cp', label: 'Control plane', value: t?.bySource.controlPlane ?? 0, display: compact(t?.bySource.controlPlane ?? 0), color: C_NEUTRAL },
                  ]}
                />
              </div>
            </>
          ) : (
            <Empty>{loading ? 'LOADING…' : 'NO USAGE REPORTED IN THIS WINDOW'}</Empty>
          )}
        </Card>

        <Card title="TOP TICKETS BY SPEND" caption="Largest token consumers in the window, every run and control-plane call included.">
          {t && t.topTickets.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr>
                    <th style={th()}>KEY</th>
                    <th style={th()}>TITLE</th>
                    <th style={th('right')}>RUNS</th>
                    <th style={th('right')}>TOKENS</th>
                    <th style={th('right')}>COST</th>
                  </tr>
                </thead>
                <tbody>
                  {t.topTickets.map((row) => (
                    <tr key={row.key}>
                      <td style={{ ...td(), whiteSpace: 'nowrap' }}>
                        <a href={`/tickets/${encodeURIComponent(row.key)}`} style={{ ...mono(500, 11), color: 'var(--tx)', textDecoration: 'none' }}>
                          {row.key}
                        </a>
                      </td>
                      <td style={{ ...td(), maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.title}>
                        {row.title || '—'}
                      </td>
                      <td style={td('right')}>{row.runs}</td>
                      <td style={td('right')}>{compact(row.tokens)}</td>
                      <td
                        style={td('right')}
                        title={row.unpriced ? 'A model this ticket used has no rate — set one under Admin → Model prices' : row.costEstimated ? 'Estimated at the workspace’s model rates' : undefined}
                      >
                        {row.cost == null ? (row.unpriced ? 'est. —' : '—') : `${row.costEstimated ? 'est. ' : ''}${fmtCost(row.cost)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{loading ? 'LOADING…' : 'NO TICKET HAS REPORTED USAGE IN THIS WINDOW'}</Empty>
          )}
        </Card>
      </div>
    </>
  );
}

// ---------- 3. efficiency gains ----------

function EfficiencySection({ report, now }: { report: MetricsReport | null; now: Date }) {
  const e = report?.efficiency;
  const loading = report === null;
  // Zero-fill quiet weeks, then run the cumulative total over the filled
  // series so a gap week carries the total forward instead of dropping to 0.
  const cumulative = useMemo(() => {
    if (!e) return [];
    const filled = fillWeeks(efficiencyWeeks(e.perWeek), now, (week) => ({ week, tickets: 0, agentHrs: 0, humanHrs: 0, savedHrs: 0, cumulativeSaved: 0 }));
    return efficiencyWeeks(filled).map((w) => ({ ...w, label: weekLabel(w.week), date: noon(w.week) }));
  }, [e, now]);

  const saved = e ? hoursSaved(e.totals.humanHrs, e.totals.agentHrs) : 0;
  const cost = report?.tokens.totals.cost ?? null;
  const est = report?.tokens.totals.costEstimated ? 'est. ' : '';
  const lev = e ? leverage(e.totals.humanHrs, e.totals.agentHrs) : null;
  const perHour = e ? costPerSavedHour(cost, saved) : null;
  const hasWork = !!e && e.totals.tickets > 0;

  return (
    <>
      <SectionHead title="EFFICIENCY GAINS" caption="AGENT HOURS AGAINST THE HUMAN-DEVELOPER ESTIMATE FOR THE SAME SCOPE, OVER DONE TICKETS AN AGENT DELIVERED" />
      <div style={{ ...KPI_GRID, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))' }}>
        <Kpi
          big
          label="HEADLINE"
          value={loading ? '—' : hasWork ? `${hrs(Math.max(0, saved))} saved · ${cost == null ? 'no spend priced' : `${est}${fmtCost(cost)} model spend`} · ${lev == null ? '—' : `${lev}×`} leverage` : 'No agent-delivered tickets in this window'}
          sub={e ? `${e.totals.tickets} DONE TICKET${e.totals.tickets === 1 ? '' : 'S'} WITH AN AGENT RUN · ${e.totals.withActual} WITH MEASURED AGENT TIME, ${e.totals.tickets - e.totals.withActual} ON THE AGENT ESTIMATE` : undefined}
          color="var(--ok)"
        />
      </div>
      <div style={KPI_GRID}>
        <Kpi label="HOURS SAVED" value={loading ? '—' : hasWork ? hrs(Math.max(0, saved)) : '—'} sub={e ? `HUMAN EST ${hrs(e.totals.humanHrs).toUpperCase()} − AGENT ${hrs(e.totals.agentHrs).toUpperCase()}` : undefined} color="var(--ok)" />
        <Kpi label="AGENT HOURS" value={loading ? '—' : hasWork ? hrs(e?.totals.agentHrs) : '—'} sub="ACTUAL RUN TIME, ELSE THE AGENT ESTIMATE" />
        <Kpi label="LEVERAGE" value={loading ? '—' : lev == null ? '—' : `${lev}×`} sub="HUMAN HOURS ÷ AGENT HOURS" />
        <Kpi label="COST PER SAVED HOUR" value={loading ? '—' : perHour == null ? '—' : `${est}${fmtCost(perHour)}`} sub={cost == null ? 'NO MODEL SPEND PRICED IN RANGE' : `MODEL SPEND ÷ HOURS SAVED${est ? ' · EST. FROM MODEL RATES' : ''}`} />
      </div>

      <div style={CHART_GRID}>
        <Card title="AGENT HOURS VS HUMAN ESTIMATE — PER WEEK" caption={hasWork ? 'Paired by completion week; the gap is the time saved.' : 'Fills in as agent-delivered tickets reach Done.'}>
          {loading || cumulative.length > 0 ? (
            <>
              <LegendRow
                items={[
                  { label: 'AGENT HOURS', color: C_AGENT, n: e ? hrs(e.totals.agentHrs) : undefined },
                  { label: 'HUMAN ESTIMATE', color: C_NEUTRAL, n: e ? hrs(e.totals.humanHrs) : undefined },
                ]}
              />
              <BarChart data={cumulative} xDataKey="label" aspectRatio="2.6 / 1" barGap={0.3} margin={MARGIN} status={loading ? 'loading' : 'ready'}>
                <Grid horizontal numTicksRows={4} />
                <Bar dataKey="agentHrs" fill={C_AGENT} lineCap={2} />
                <Bar dataKey="humanHrs" fill={C_NEUTRAL} lineCap={2} />
                <BarXAxis maxLabels={8} />
                <ChartTooltip
                  showDatePill={false}
                  showCrosshair={false}
                  rows={(p) => [
                    { color: C_AGENT, label: 'Agent', value: hrs(Number(p.agentHrs ?? 0)) },
                    { color: C_NEUTRAL, label: 'Human est', value: hrs(Number(p.humanHrs ?? 0)) },
                    { color: 'var(--ok)', label: 'Saved', value: hrs(Math.max(0, Number(p.savedHrs ?? 0))) },
                    { color: 'var(--tx3)', label: 'Tickets', value: Number(p.tickets ?? 0) },
                  ]}
                />
              </BarChart>
            </>
          ) : (
            <Empty>NO AGENT-DELIVERED TICKETS DONE IN THIS WINDOW</Empty>
          )}
        </Card>

        <Card title="CUMULATIVE HOURS SAVED" caption={hasWork ? 'Running total of human-estimate hours minus agent hours.' : 'Accumulates with each agent-delivered completion.'}>
          {loading || cumulative.length > 0 ? (
            <AreaChart data={cumulative} xDataKey="date" aspectRatio="2.6 / 1" margin={MARGIN} status={loading ? 'loading' : 'ready'} loadingLabel="Loading">
              <Grid horizontal numTicksRows={4} />
              <Area dataKey="cumulativeSaved" fill="var(--ok)" fillOpacity={0.22} />
              <XAxis numTicks={Math.min(6, Math.max(2, cumulative.length))} />
              <ChartTooltip rows={(p) => [{ color: 'var(--ok)', label: 'Saved to date', value: hrs(Number(p.cumulativeSaved ?? 0)) }]} />
            </AreaChart>
          ) : (
            <Empty>NOTHING SAVED YET IN THIS WINDOW</Empty>
          )}
        </Card>
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '10px 14px', fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.6 }}>
        <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 4 }}>HOW THESE ARE COMPUTED</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <b>Scope</b> — done tickets whose <code>done_at</code> is inside the range and that had at least one claimed agent run. Purely human work is excluded; status counts and the projects table are today’s boards regardless of range.
          </li>
          <li>
            <b>Agent hours</b> — the ticket’s measured agent run time (<code>actual_hours</code>, logged when it reached Review) when a run was measured; otherwise the calibrated agent estimate (<code>est_hours</code>).
          </li>
          <li>
            <b>Human hours</b> — the model’s independent human-developer estimate for the same scope (<code>human_est_hours</code>).
          </li>
          <li>
            <b>Hours saved</b> = human hours − agent hours, summed per completion week; the headline clamps a net overrun at zero.
            <b> Leverage</b> = human hours ÷ agent hours. <b>Cost per saved hour</b> = model spend in the range ÷ hours saved.
          </li>
          <li>
            <b>Model spend</b> — USD as the harness recorded it on a finished run’s final sample where it sent one; every other row (per-turn samples, control-plane calls, harnesses that do not price themselves) is estimated as input × in + output × out + cache read × cr + cache write × cw at the workspace’s model rates (Admin → Model prices: published defaults, per-workspace overrides) and labelled <i>est.</i> A model with no rate adds nothing and is named instead of counted as $0.
          </li>
          <li>
            <b>Cycle time</b> — hours from a ticket’s first status event (creation) to <code>done_at</code>; median is interpolated, p90 is nearest-rank. <b>Tokens</b> = input + output; cache reads and writes are shown beside it, never counted. <b>Cache hit ratio</b> = cache-read tokens ÷ (input + cache-read).
          </li>
        </ul>
      </div>
    </>
  );
}
