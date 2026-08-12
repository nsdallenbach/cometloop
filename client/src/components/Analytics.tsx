import { useEffect, useMemo, useState } from 'react';
import type { CommitDay, Engagement, EngagementDetail, VelocityReport } from '../types';
import { api } from '../api';
import { deliveredByDay } from '../lib/delivered-by-day';
import { mono } from '../util';
import { AreaChart } from './charts/area-chart';
import { Area } from './charts/area';
import { Grid } from './charts/grid';
import { XAxis } from './charts/x-axis';
import { BarChart } from './charts/bar-chart';
import { Bar } from './charts/bar';
import { BarXAxis } from './charts/bar-x-axis';
import { BarYAxis } from './charts/bar-y-axis';
import { ChartTooltip } from './charts/tooltip';

const DELIVERED_DAYS = 14;

/** The delivered card pairs ticket volume with agent effort:
 *  tickets done = --chart-1 (brand red), agent hours = --chart-2 (periwinkle). */
const TICKETS_COLOR = 'var(--chart-1)';
const HOURS_COLOR = 'var(--chart-2)';

const STATUS_ORDER: [string, string][] = [
  ['proposed', 'PROPOSED'],
  ['backlog', 'BACKLOG'],
  ['progress', 'IN PROGRESS'],
  ['review', 'REVIEW'],
  ['done', 'DONE'],
];

function Card({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>{title}</span>
        {caption && <span style={{ fontSize: 11.5, color: 'var(--tx2)', marginLeft: 10 }}>{caption}</span>}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  );
}

function LegendRow({ items }: { items: { label: string; color: string; n?: number }[] }) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 4 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...mono(400, 10), color: 'var(--tx2)', letterSpacing: '.06em' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color }} />
          {it.label}
          {it.n != null && <b style={{ color: 'var(--tx)' }}>{it.n}</b>}
        </span>
      ))}
    </div>
  );
}

export function Analytics({ eng, detail }: { eng: Engagement; detail: EngagementDetail }) {
  const tickets = detail.tickets;

  // Done tickets bucketed per day for the trailing window: agent hours + count.
  const delivered = useMemo(() => deliveredByDay(tickets, DELIVERED_DAYS), [tickets]);
  const deliveredTotals = useMemo(
    () =>
      delivered.reduce(
        (a, b) => ({ hours: Math.round((a.hours + b.hours) * 10) / 10, tickets: a.tickets + b.tickets }),
        { hours: 0, tickets: 0 },
      ),
    [delivered],
  );

  const statusData = useMemo(
    () =>
      STATUS_ORDER.map(([key, name]) => ({ name, count: tickets.filter((t) => t.status === key).length })).filter(
        (d) => d.count > 0 || ['BACKLOG', 'REVIEW', 'DONE'].includes(d.name),
      ),
    [tickets],
  );

  if (tickets.length === 0) {
    return (
      <div className="tab-pane" style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
        <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '44px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Nothing to chart yet</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)' }}>Analytics builds itself from board tickets and the status feed as work starts.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-pane" style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
      {/* Cap the column: aspect-ratio charts turn into skyscrapers on wide screens. */}
      <div style={{ maxWidth: 1360, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>DELIVERY ANALYTICS</span>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', animation: 'eec-pulse 2.4s infinite' }} />
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>LIVE — SYNCED WITH THE BOARD</span>
      </div>

      {/* Org velocity is the headline: idea → production, decision latency, savings. */}
      <VelocitySection engId={eng.id} ticketCount={tickets.length} />

      {/* Delivery over time — agent hours (left y-scale) vs tickets done (right y-scale) */}
      <div style={{ marginBottom: 14 }}>
        <Card
          title={`DELIVERED — LAST ${DELIVERED_DAYS} DAYS`}
          caption={
            deliveredTotals.tickets === 0
              ? 'No tickets done in this window yet.'
              : `${deliveredTotals.hours}h agent hours across ${deliveredTotals.tickets} done ticket${deliveredTotals.tickets === 1 ? '' : 's'}`
          }
        >
          <LegendRow
            items={[
              { label: 'AGENT HOURS', color: HOURS_COLOR, n: deliveredTotals.hours },
              { label: 'TICKETS DONE', color: TICKETS_COLOR, n: deliveredTotals.tickets },
            ]}
          />
          <AreaChart data={delivered} xDataKey="date" aspectRatio="3.4 / 1" margin={{ top: 16, right: 16, bottom: 28, left: 30 }}>
            <Grid horizontal numTicksRows={4} />
            <Area dataKey="hours" fill={HOURS_COLOR} fillOpacity={0.25} />
            <Area dataKey="tickets" fill={TICKETS_COLOR} fillOpacity={0.25} yAxisId="right" />
            <XAxis numTicks={5} />
            <ChartTooltip />
          </AreaChart>
        </Card>
      </div>

      {/* Commit activity — synced repo commits per day, GitHub-style. */}
      <div style={{ marginBottom: 14 }}>
        <CommitActivityCard engId={eng.id} />
      </div>

      {/* Ticket pipeline — the raw counts, parked at the bottom for reference. */}
      <Card title="TICKETS BY STATUS" caption="Everything on this engagement, proposed through done.">
        <BarChart data={statusData} xDataKey="name" aspectRatio="4.5 / 1" barGap={0.35} margin={{ top: 16, right: 16, bottom: 28, left: 30 }}>
          <Grid horizontal numTicksRows={4} />
          <Bar dataKey="count" fill="var(--chart-3)" lineCap={3} />
          <BarXAxis />
          <BarYAxis />
          <ChartTooltip showDatePill={false} showCrosshair={false} />
        </BarChart>
      </Card>
      </div>
    </div>
  );
}

/** Commits per day for the trailing 8 weeks, zero-filled (DAT-197). */
function CommitActivityCard({ engId }: { engId: string }) {
  const [days, setDays] = useState<CommitDay[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .commitActivity(engId)
      .then((d) => alive && setDays(d))
      .catch(() => alive && setDays([]));
    return () => {
      alive = false;
    };
  }, [engId]);

  const filled = useMemo(() => {
    const byDate = new Map((days ?? []).map((d) => [d.date, d]));
    const out: CommitDay[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = 55; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      out.push(byDate.get(iso) ?? { date: iso, commits: 0, authors: 0 });
    }
    return out;
  }, [days]);

  const total = useMemo(() => (days ?? []).reduce((a, d) => a + d.commits, 0), [days]);
  const busiest = useMemo(
    () => (days ?? []).reduce<CommitDay | null>((a, d) => (a === null || d.commits > a.commits ? d : a), null),
    [days],
  );
  const authors = useMemo(() => Math.max(0, ...(days ?? []).map((d) => d.authors)), [days]);

  return (
    <Card
      title="COMMIT ACTIVITY — LAST 8 WEEKS"
      caption={
        days === null
          ? 'Loading…'
          : total === 0
            ? 'No synced commits in the window — connect a repo or wait for the next sync.'
            : `${total} commits · up to ${authors} authors in a day · busiest ${busiest?.date.slice(5)} (${busiest?.commits})`
      }
    >
      {days !== null && total > 0 ? (
        <BarChart data={filled} xDataKey="date" aspectRatio="6 / 1" barGap={0.25} margin={{ top: 12, right: 16, bottom: 26, left: 30 }}>
          <Grid horizontal numTicksRows={3} />
          <Bar dataKey="commits" fill="var(--chart-2)" lineCap={2} />
          <BarXAxis />
          <BarYAxis />
          <ChartTooltip showDatePill={false} showCrosshair={false} />
        </BarChart>
      ) : (
        <div style={{ ...mono(400, 10), color: 'var(--tx3)', padding: '14px 0', textAlign: 'center' }}>
          {days === null ? 'LOADING…' : 'NO COMMITS SYNCED YET'}
        </div>
      )}
    </Card>
  );
}

// ---------- org velocity (DAT-193) ----------

/** Hours for display: sub-2-day values in hours, longer in days. */
function fmtHrs(h: number | null): string {
  if (h == null) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round((h / 24) * 10) / 10}d`;
}

/** Lower-is-better delta caption vs the prior window. */
function trendSub(m: { current: number | null; previous: number | null }, windowDays: number): { sub: string; color?: string } {
  if (m.current == null) return { sub: 'NO COMPLETIONS IN WINDOW YET' };
  if (m.previous == null || m.previous === 0) return { sub: `TRAILING ${windowDays}D · NO PRIOR WINDOW` };
  const pct = Math.round(((m.current - m.previous) / m.previous) * 100);
  if (pct === 0) return { sub: `FLAT VS PRIOR ${windowDays}D` };
  return {
    sub: `${pct < 0 ? '▼' : '▲'} ${Math.abs(pct)}% VS PRIOR ${windowDays}D (${fmtHrs(m.previous)})`,
    color: pct < 0 ? 'var(--ok)' : 'var(--warn)',
  };
}

function VKpi({ label, display, sub, color }: { label: string; display: string; sub: string; color?: string }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '12px 14px' }}>
      <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--tx)', lineHeight: 1 }}>{display}</div>
      <div style={{ ...mono(400, 10), color: color ?? 'var(--tx3)', marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function VelocitySection({ engId, ticketCount }: { engId: string; ticketCount: number }) {
  const [report, setReport] = useState<VelocityReport | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .velocity(engId)
      .then((r) => alive && setReport(r))
      .catch(() => alive && setReport(null));
    return () => {
      alive = false;
    };
  }, [engId, ticketCount]);

  if (report == null) return null;
  const { windowDays } = report;
  const lead = trendSub(report.leadTimeHrs, windowDays);
  const cycle = trendSub(report.cycleTimeHrs, windowDays);
  const decision = trendSub(report.decisionTimeHrs, windowDays);

  const backlogNow = report.backlog.length > 0 ? report.backlog[report.backlog.length - 1].open : 0;
  const backlogCaption =
    report.backlogDelta == null
      ? 'History builds from the first status change.'
      : report.backlogDelta < 0
        ? `Shrinking — ${Math.abs(report.backlogDelta)} fewer open than ${windowDays} days ago.`
        : report.backlogDelta === 0
          ? `Flat over the last ${windowDays} days.`
          : `Growing — ${report.backlogDelta} more open than ${windowDays} days ago.`;

  const slowest = report.stages.reduce<(typeof report.stages)[number] | null>(
    (a, s) => (s.medianHrs != null && (a?.medianHrs == null || s.medianHrs > a.medianHrs) ? s : a),
    null,
  );
  const stageCaption =
    slowest == null
      ? 'Stage timings appear as tickets move.'
      : slowest.key === 'review' && (report.reviewPassRate ?? 0) >= 80
        ? `Review is the longest wait (${fmtHrs(slowest.medianHrs)}) and ${report.reviewPassRate}% of reviews pass straight through — a fast-track lane for small changes could remove this step.`
        : `Longest wait: ${slowest.label.toLowerCase()} at ${fmtHrs(slowest.medianHrs)} median.`;

  const weeklyData = report.weekly.map((w) => ({ ...w, leadTimeHrs: w.leadTimeHrs ?? 0, cycleTimeHrs: w.cycleTimeHrs ?? 0 }));
  const stageData = report.stages.map((s) => ({ name: s.key.toUpperCase(), hours: s.medianHrs ?? 0 }));

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>ORG VELOCITY — IDEA TO PRODUCTION</span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>MEDIANS OVER THE TRAILING {windowDays} DAYS, DELTAS VS THE {windowDays} BEFORE</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 14 }}>
        <VKpi label="IDEA → DONE" display={fmtHrs(report.leadTimeHrs.current)} sub={lead.sub} color={lead.color} />
        <VKpi label="CYCLE TIME (WORK START → DONE)" display={fmtHrs(report.cycleTimeHrs.current)} sub={cycle.sub} color={cycle.color} />
        <VKpi label="DECISION TIME (IN REVIEW)" display={fmtHrs(report.decisionTimeHrs.current)} sub={decision.sub} color={decision.color} />
        <VKpi
          label="HUMAN DEV HOURS SAVED"
          display={`${report.humanHoursSaved.window}h`}
          sub={`${report.humanHoursSaved.total}H ALL-TIME · ${report.humanHoursSaved.agentHoursSpent}H AGENT TIME SPENT`}
          color="var(--ok)"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, alignItems: 'start', marginBottom: 14 }}>
        <Card
          title="GETTING FASTER? — WEEKLY MEDIANS"
          caption={
            report.weekly.length < 2
              ? 'The trend draws itself after two weeks of completions.'
              : `Lead and cycle time per completion week — down and to the right is the goal.`
          }
        >
          {report.weekly.length >= 2 ? (
            <>
              <LegendRow
                items={[
                  { label: 'IDEA → DONE (H)', color: 'var(--chart-1)' },
                  { label: 'CYCLE (H)', color: 'var(--chart-2)' },
                ]}
              />
              <AreaChart data={weeklyData} xDataKey="week" aspectRatio="3 / 1" margin={{ top: 16, right: 16, bottom: 28, left: 30 }}>
                <Grid horizontal numTicksRows={4} />
                <Area dataKey="leadTimeHrs" fill="var(--chart-1)" fillOpacity={0.25} />
                <Area dataKey="cycleTimeHrs" fill="var(--chart-2)" fillOpacity={0.25} />
                <XAxis numTicks={Math.min(8, report.weekly.length)} />
                <ChartTooltip />
              </AreaChart>
            </>
          ) : (
            <div style={{ ...mono(400, 10), color: 'var(--tx3)', padding: '14px 0', textAlign: 'center' }}>NOT ENOUGH WEEKS YET</div>
          )}
        </Card>

        <Card title="WHERE WORK WAITS" caption={stageCaption}>
          <BarChart data={stageData} xDataKey="name" aspectRatio="1.6 / 1" barGap={0.35} margin={{ top: 16, right: 16, bottom: 28, left: 34 }}>
            <Grid horizontal numTicksRows={4} />
            <Bar dataKey="hours" fill="var(--chart-3)" lineCap={3} />
            <BarXAxis />
            <BarYAxis />
            <ChartTooltip showDatePill={false} showCrosshair={false} />
          </BarChart>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, alignItems: 'start' }}>
        <Card title={`BACKLOG TRAJECTORY — OPEN TICKETS`} caption={backlogCaption}>
          {report.backlog.length >= 2 ? (
            <AreaChart data={report.backlog} xDataKey="date" aspectRatio="3 / 1" margin={{ top: 16, right: 16, bottom: 28, left: 30 }}>
              <Grid horizontal numTicksRows={4} />
              <Area dataKey="open" fill={report.backlogDelta != null && report.backlogDelta > 0 ? 'var(--chart-1)' : 'var(--chart-2)'} fillOpacity={0.25} />
              <XAxis numTicks={6} />
              <ChartTooltip />
            </AreaChart>
          ) : (
            <div style={{ ...mono(400, 10), color: 'var(--tx3)', padding: '14px 0', textAlign: 'center' }}>{`OPEN NOW: ${backlogNow}`}</div>
          )}
        </Card>

        <Card
          title="WEEK OVER WEEK"
          caption={report.weekly.length === 0 ? 'Fills in as completion weeks accumulate.' : 'Per completion week — latest emphasized.'}
        >
          {report.weekly.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <thead>
                <tr>
                  {['WEEK', 'DONE', 'IDEA → DONE', 'HRS SAVED'].map((h, i) => (
                    <th
                      key={h}
                      style={{ textAlign: i === 0 ? 'left' : 'right', ...mono(500, 9.5), color: 'var(--tx3)', letterSpacing: '.08em', padding: '4px 2px', fontWeight: 500 }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.weekly.slice(-5).map((w, i, arr) => {
                  const latest = i === arr.length - 1;
                  const cell = {
                    padding: '5px 2px',
                    textAlign: 'right' as const,
                    color: latest ? 'var(--tx)' : 'var(--tx3)',
                    fontWeight: latest ? 600 : 400,
                    fontVariantNumeric: 'tabular-nums' as const,
                  };
                  return (
                    <tr key={w.week}>
                      <td style={{ padding: '5px 2px', color: latest ? 'var(--tx)' : 'var(--tx2)', fontWeight: latest ? 600 : 400 }}>
                        {w.week.slice(5)}
                      </td>
                      <td style={cell}>{w.doneCount}</td>
                      <td style={cell}>{fmtHrs(w.leadTimeHrs)}</td>
                      <td style={cell}>{w.humanHoursSaved}h</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ ...mono(400, 10), color: 'var(--tx3)', padding: '14px 0', textAlign: 'center' }}>HISTORY BUILDS WEEKLY</div>
          )}
        </Card>
      </div>
    </>
  );
}
