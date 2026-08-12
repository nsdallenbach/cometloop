import { useEffect, useMemo, useState } from 'react';
import NumberFlow from '@number-flow/react';
import type { BurndownDay, Engagement, EngagementDetail } from '../types';
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
import { RingChart } from './charts/ring-chart';
import { Ring } from './charts/ring';
import { RingCenter } from './charts/ring-center';
import { ChartTooltip } from './charts/tooltip';

const DELIVERED_DAYS = 14;

/** Series colors follow the entity everywhere on this tab:
 *  team = --chart-1 (brand red), agent = --chart-2 (periwinkle).
 *  The delivered card pairs ticket volume with agent effort on the same pair:
 *  tickets done = --chart-1, agent hours = --chart-2. The burndown card
 *  carries its own two-entity legend likewise:
 *  open remaining = --chart-1, done = --chart-2. */
const TEAM_COLOR = 'var(--chart-1)';
const AGENT_COLOR = 'var(--chart-2)';
const TICKETS_COLOR = 'var(--chart-1)';
const HOURS_COLOR = 'var(--chart-2)';
const OPEN_COLOR = 'var(--chart-1)';
const DONE_COLOR = 'var(--chart-2)';

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

function Kpi({ label, value, suffix, sub, color }: { label: string; value: number; suffix?: string; sub: string; color?: string }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '12px 14px' }}>
      <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: color ?? 'var(--tx)', lineHeight: 1 }}>
        <NumberFlow value={value} />
        {suffix && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--tx2)', marginLeft: 2 }}>{suffix}</span>}
      </div>
      <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 6 }}>{sub}</div>
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
  const [burndown, setBurndown] = useState<BurndownDay[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .burndown(eng.id)
      .then((days) => alive && setBurndown(days))
      .catch(() => alive && setBurndown([]));
    return () => {
      alive = false;
    };
  }, [eng.id, tickets]);
  const board = useMemo(() => tickets.filter((t) => t.status !== 'proposed' && t.status !== 'dismissed'), [tickets]);
  const done = board.filter((t) => t.status === 'done').length;
  const blocked = board.filter((t) => t.blocked).length;
  const agentOwned = board.filter((t) => t.agent).length;
  const agentShare = board.length ? Math.round((agentOwned / board.length) * 100) : 0;
  const burnDelta = eng.burn - eng.plan;
  const burnColor = eng.burn > eng.plan + 5 ? 'var(--bad)' : eng.burn > eng.plan ? 'var(--warn)' : 'var(--ok)';

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>DELIVERY ANALYTICS</span>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', animation: 'eec-pulse 2.4s infinite' }} />
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>LIVE — SYNCED WITH THE BOARD</span>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
        <Kpi label="TICKETS DONE" value={done} suffix={`/ ${board.length}`} sub={`${board.length ? Math.round((done / board.length) * 100) : 0}% OF BOARD`} />
        <Kpi label="AGENT SHARE" value={agentShare} suffix="%" sub={`${agentOwned} OF ${board.length} TICKETS AGENT-OWNED`} />
        <Kpi label="BLOCKED" value={blocked} sub="ON BOARD NOW" color={blocked > 0 ? 'var(--warn)' : undefined} />
        <Kpi
          label="BURN VS PLAN"
          value={eng.burn}
          suffix={`% · ${burnDelta >= 0 ? '+' : ''}${burnDelta}pp`}
          sub={`PLAN ${eng.plan}% AT THIS POINT`}
          color={burnColor}
        />
      </div>

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

      {/* Burndown — remaining open tickets by day, replayed from the status event trail */}
      <div style={{ marginBottom: 14 }}>
        <Card
          title="BURNDOWN — OPEN TICKETS BY DAY"
          caption={
            burndown == null
              ? 'Loading…'
              : burndown.length === 0
                ? 'No ticket history yet — the trail starts with the first ticket.'
                : burndown.length < 2
                  ? `${burndown[burndown.length - 1].open} open of ${burndown[burndown.length - 1].total} on board — history builds from today.`
                  : `${burndown[burndown.length - 1].open} open of ${burndown[burndown.length - 1].total} on board`
          }
        >
          {burndown != null && burndown.length >= 2 ? (
            <>
              <LegendRow
                items={[
                  { label: 'OPEN', color: OPEN_COLOR, n: burndown[burndown.length - 1].open },
                  { label: 'DONE', color: DONE_COLOR, n: burndown[burndown.length - 1].done },
                ]}
              />
              <AreaChart data={burndown} xDataKey="date" aspectRatio="3.4 / 1" margin={{ top: 16, right: 16, bottom: 28, left: 30 }}>
                <Grid horizontal numTicksRows={4} />
                <Area dataKey="open" fill={OPEN_COLOR} fillOpacity={0.25} />
                <Area dataKey="done" fill={DONE_COLOR} fillOpacity={0.25} />
                <XAxis numTicks={5} />
                <ChartTooltip />
              </AreaChart>
            </>
          ) : (
            <div style={{ ...mono(400, 10), color: 'var(--tx3)', padding: '14px 0', textAlign: 'center' }}>
              {burndown == null ? 'LOADING BURNDOWN…' : 'THE CHART DRAWS ITSELF ONCE THERE ARE TWO DAYS OF HISTORY.'}
            </div>
          )}
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, alignItems: 'start' }}>
        {/* Ticket pipeline */}
        <Card title="TICKETS BY STATUS" caption="Everything on this engagement, proposed through done.">
          <BarChart data={statusData} xDataKey="name" aspectRatio="2.2 / 1" barGap={0.35} margin={{ top: 16, right: 16, bottom: 28, left: 30 }}>
            <Grid horizontal numTicksRows={4} />
            <Bar dataKey="count" fill="var(--chart-3)" lineCap={3} />
            <BarXAxis />
            <BarYAxis />
            <ChartTooltip showDatePill={false} showCrosshair={false} />
          </BarChart>
        </Card>

        {/* Delivery split */}
        <Card
          title="DELIVERY SPLIT"
          caption={board.length ? `Agent owns ${agentShare}% of the board.` : undefined}
        >
          <LegendRow
            items={[
              { label: 'TEAM', color: TEAM_COLOR, n: board.length - agentOwned },
              { label: 'AGENT', color: AGENT_COLOR, n: agentOwned },
            ]}
          />
          <div style={{ display: 'grid', placeItems: 'center', padding: '6px 0 2px' }}>
            <RingChart
              size={190}
              strokeWidth={13}
              ringGap={5}
              baseInnerRadius={56}
              data={[
                { label: 'TEAM', value: board.length - agentOwned, maxValue: Math.max(1, board.length), color: TEAM_COLOR },
                { label: 'AGENT', value: agentOwned, maxValue: Math.max(1, board.length), color: AGENT_COLOR },
              ]}
            >
              <Ring index={0} />
              <Ring index={1} />
              <RingCenter defaultLabel="Tickets" />
            </RingChart>
          </div>
        </Card>
      </div>
    </div>
  );
}
