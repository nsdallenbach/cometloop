import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { animate as anime, stagger } from 'animejs';
import { api } from '../api';
import type { Engagement, EngagementDetail, RoadmapSettings, Ticket } from '../types';
import { STATUS_LABEL, fmtD, mono, pct, todayIso } from '../util';

const DEFAULT_ROADMAP_SETTINGS: RoadmapSettings = { hoursPerDay: 6, bufferPct: 20, workdaysPerWeek: 5 };

const STATUS_DOT: Record<string, string> = {
  backlog: 'var(--tx3)',
  progress: 'var(--warn)',
  review: 'var(--agent)',
  done: 'var(--ok)',
};

/** Effort of a ticket in agent-hours. Falls back to legacy est strings ('6h', '3d'). */
function hoursOf(t: Ticket, hoursPerDay: number): number {
  if (t.estHours != null) return t.estHours;
  const h = /^(\d+(?:\.\d+)?)\s*h$/i.exec(t.est.trim());
  if (h) return Number(h[1]);
  const d = /^(\d+(?:\.\d+)?)\s*d$/i.exec(t.est.trim());
  if (d) return Number(d[1]) * hoursPerDay;
  return 0;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.ceil(days));
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((+new Date(`${b}T00:00:00Z`) - +new Date(`${a}T00:00:00Z`)) / 86400000);
}

interface RoadmapItemView {
  name: string;
  s: string;
  e: string;
  /** Live completion 0-100 — from linked ticket effort when available, else the stored phase pct. */
  livePct: number;
  tickets: Ticket[];
  totalHours: number;
  doneHours: number;
  unsized: number;
  /** Data-driven finish date, null when there is no linked effort to project from. */
  projectedEnd: string | null;
  /** Days late (+) or early (-) vs the planned end; null without a projection. */
  deltaDays: number | null;
  lane: number;
}

export function Roadmap({
  eng,
  detail,
  lead,
  openTicket,
  toast,
  onEngagementChanged,
}: {
  eng: Engagement;
  detail: EngagementDetail;
  lead: boolean;
  openTicket: (key: string) => void;
  toast: (msg: string) => void;
  onEngagementChanged: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const settings = eng.roadmapSettings ?? DEFAULT_ROADMAP_SETTINGS;
  const today = todayIso();

  const boardTickets = useMemo(
    () => detail.tickets.filter((t) => t.status !== 'dismissed' && t.status !== 'proposed'),
    [detail.tickets],
  );
  const unscheduled = useMemo(() => boardTickets.filter((t) => !t.roadmapItem), [boardTickets]);

  const items = useMemo<RoadmapItemView[]>(() => {
    if (!eng.phases) return [];
    const views = eng.phases.map((p) => {
      const linked = boardTickets.filter((t) => t.roadmapItem === p.name);
      const totalHours = linked.reduce((a, t) => a + hoursOf(t, settings.hoursPerDay), 0);
      const doneHours = linked.filter((t) => t.status === 'done').reduce((a, t) => a + hoursOf(t, settings.hoursPerDay), 0);
      const unsized = linked.filter((t) => hoursOf(t, settings.hoursPerDay) === 0).length;
      const livePct = totalHours > 0 ? Math.round((doneHours / totalHours) * 100) : (p.pct ?? 0);
      let projectedEnd: string | null = null;
      let deltaDays: number | null = null;
      if (totalHours > 0 && doneHours < totalHours) {
        // Remaining effort flows from today (or the planned start if the item
        // hasn't begun), through hours/day and the buffer, into calendar days.
        const remaining = totalHours - doneHours;
        const workDays = (remaining / settings.hoursPerDay) * (1 + settings.bufferPct / 100);
        const calendarDays = workDays * (7 / settings.workdaysPerWeek);
        projectedEnd = addDays(p.s > today ? p.s : today, calendarDays);
        deltaDays = daysBetween(p.e, projectedEnd);
      } else if (totalHours > 0) {
        projectedEnd = today < p.e ? today : p.e;
        deltaDays = daysBetween(p.e, projectedEnd);
      }
      return { name: p.name, s: p.s, e: p.e, livePct, tickets: linked, totalHours, doneHours, unsized, projectedEnd, deltaDays, lane: 0 };
    });
    // Lane packing: concurrent items stack; sequential items share a lane.
    const laneEnds: string[] = [];
    for (const v of [...views].sort((a, b) => a.s.localeCompare(b.s))) {
      const visualEnd = v.projectedEnd && v.projectedEnd > v.e ? v.projectedEnd : v.e;
      let lane = laneEnds.findIndex((end) => v.s > end);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = visualEnd;
      v.lane = lane;
    }
    return views;
  }, [eng.phases, boardTickets, settings, today]);

  const laneCount = items.reduce((m, v) => Math.max(m, v.lane + 1), 1);

  // Timeline window: the planned range, stretched to hold today and any overrun.
  const [winS, winE] = useMemo(() => {
    let s = eng.rmStart ?? eng.phases?.[0]?.s ?? today;
    let e = eng.rmEnd ?? eng.phases?.[eng.phases.length - 1]?.e ?? today;
    for (const v of items) if (v.projectedEnd && v.projectedEnd > e) e = v.projectedEnd;
    if (today < s) s = today;
    if (today > e) e = today;
    return [s, addDays(e, Math.max(4, daysBetween(s, e) * 0.03))];
  }, [eng.rmStart, eng.rmEnd, eng.phases, items, today]);

  const months = useMemo(() => {
    // Iterate in UTC: date-only strings parse as UTC, so local-time month math
    // would duplicate the first tick in negative-offset timezones.
    const out: { label: string; l: number }[] = [];
    const end = new Date(`${winE}T00:00:00Z`);
    let d = new Date(`${winS}T00:00:00Z`);
    d.setUTCDate(1);
    while (d < end) {
      const iso = d.toISOString().slice(0, 10);
      if (iso >= winS) {
        out.push({
          label:
            d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }).toUpperCase() +
            (d.getUTCMonth() === 0 ? ` ${String(d.getUTCFullYear()).slice(2)}` : ''),
          l: pct(winS, winE, iso),
        });
      }
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    return out;
  }, [winS, winE]);

  // Entrance choreography (anime.js): bars grow from their start edge, fills
  // sweep in, the today line draws down, milestones pop. Runs once per engagement.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    anime(root.querySelectorAll('.rm-bar'), {
      scaleX: [0, 1],
      opacity: [0, 1],
      duration: 550,
      delay: stagger(70),
      ease: 'outQuart',
    });
    anime(root.querySelectorAll('.rm-fill'), {
      scaleX: [0, 1],
      duration: 700,
      delay: stagger(70, { start: 250 }),
      ease: 'outQuart',
    });
    anime(root.querySelectorAll('.rm-today'), {
      scaleY: [0, 1],
      duration: 500,
      delay: 350,
      ease: 'outQuad',
    });
    anime(root.querySelectorAll('.rm-milestone'), {
      scale: [0, 1],
      duration: 400,
      delay: stagger(50, { start: 500 }),
      ease: 'outBack(2)',
    });
  }, [eng.id]);

  const selectedItem = items.find((v) => v.name === selected) ?? null;
  const todayL = Math.max(1, Math.min(99, pct(winS, winE, today)));
  const LANE_H = 40;

  if (!eng.phases || eng.phases.length === 0) {
    return (
      <div className="tab-pane" style={{ flex: 1, overflow: 'auto', padding: 22 }}>
        <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '44px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No roadmap yet</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)' }}>Engagements created from a SOW or brief get a phase schedule; this one has none captured.</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="tab-pane" style={{ flex: 1, overflow: 'auto', padding: 22 }}>
      <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '20px 24px 26px' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Roadmap</span>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', animation: 'eec-pulse 2.4s infinite' }} />
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>
            LIVING VIEW — UPDATES FROM THE BOARD
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>
            {settings.hoursPerDay}H / DAY · +{settings.bufferPct}% BUFFER · {settings.workdaysPerWeek}D WEEK
          </span>
          {lead && (
            <button
              className="hv-border-bg"
              onClick={() => setSettingsOpen((o) => !o)}
              title="Configure how ticket effort translates to roadmap days"
              style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '4px 10px', ...mono(500, 10), letterSpacing: '.06em', cursor: 'pointer' }}
            >
              SETTINGS
            </button>
          )}
        </div>
        <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em', marginBottom: 18 }}>
          {eng.sowStatus === 'BRIEF' ? 'BASELINE FROM PROJECT BRIEF' : 'BASELINE FROM SOW'} · SOLID = PLANNED · TINTED EXTENSION = DATA-DRIVEN PROJECTION
        </div>

        <AnimatePresence>
          {settingsOpen && (
            <RoadmapSettingsPanel
              key="rm-settings"
              engId={eng.id}
              current={settings}
              onSaved={() => {
                onEngagementChanged();
                setSettingsOpen(false);
                toast('Roadmap settings saved');
              }}
              onError={(m) => toast(`Save failed — ${m}`)}
            />
          )}
        </AnimatePresence>

        {/* timeline */}
        <div style={{ position: 'relative' }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', paddingBottom: 6, position: 'relative' }}>
            {months.map((m) => (
              <div key={m.label + m.l} style={{ position: 'absolute', left: `${m.l}%`, ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
                {m.label}
              </div>
            ))}
            <div style={{ height: 14 }} />
          </div>
          <div style={{ position: 'relative', height: laneCount * LANE_H + 10, marginTop: 8 }}>
            {months.map((m) => (
              <div key={`l${m.l}`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${m.l}%`, width: 1, background: 'var(--line)' }} />
            ))}
            {/* today line */}
            <div
              className="rm-today"
              style={{ position: 'absolute', top: -28, bottom: 0, left: `${todayL}%`, width: 1.5, background: 'var(--acc)', transformOrigin: 'top', zIndex: 2 }}
            />
            <div
              style={{
                position: 'absolute',
                top: -28,
                left: `${todayL}%`,
                transform: 'translateX(-50%)',
                background: 'var(--acc)',
                color: '#fff',
                ...mono(500, 9),
                padding: '1px 6px',
                borderRadius: 2,
                letterSpacing: '.06em',
                zIndex: 2,
              }}
            >
              TODAY
            </div>

            {items.map((v) => {
              const l = pct(winS, winE, v.s);
              const w = Math.max(1.5, pct(winS, winE, v.e) - l);
              const over = v.projectedEnd && v.projectedEnd > v.e;
              const overW = over ? Math.max(0.5, pct(winS, winE, v.projectedEnd as string) - pct(winS, winE, v.e)) : 0;
              const done = v.livePct === 100;
              const late = (v.deltaDays ?? 0) > 2;
              const isSel = selected === v.name;
              return (
                <motion.button
                  key={v.name}
                  className="rm-bar"
                  layout
                  onClick={() => setSelected(isSel ? null : v.name)}
                  whileHover={{ transform: 'translateY(-1px)' }}
                  title={`${v.name} · ${fmtD(v.s)} – ${fmtD(v.e)}`}
                  style={{
                    position: 'absolute',
                    left: `${l}%`,
                    width: `${w + overW}%`,
                    top: v.lane * LANE_H + 4,
                    height: 28,
                    padding: 0,
                    border: 'none',
                    background: 'none',
                    cursor: 'pointer',
                    transformOrigin: 'left center',
                    zIndex: isSel ? 3 : 1,
                    textAlign: 'left',
                  }}
                >
                  {/* planned span */}
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      right: over ? `${(overW / (w + overW)) * 100}%` : 0,
                      background: 'var(--bg3)',
                      border: `1px solid ${isSel ? 'var(--acc)' : done ? 'var(--line2)' : v.livePct > 0 ? 'var(--acc)' : 'var(--line2)'}`,
                      borderRadius: 3,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      className="rm-fill bar-anim"
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        left: 0,
                        width: `${v.livePct}%`,
                        background: done ? 'var(--line2)' : 'var(--accsoft)',
                        transformOrigin: 'left center',
                      }}
                    />
                    <span
                      style={{
                        position: 'absolute',
                        left: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: done ? 'var(--tx2)' : 'var(--tx)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        maxWidth: 'calc(100% - 48px)',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {v.name}
                    </span>
                    <span
                      style={{
                        position: 'absolute',
                        right: 7,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        ...mono(500, 9),
                        color: done ? 'var(--ok)' : v.livePct > 0 ? 'var(--acc)' : 'var(--tx3)',
                        letterSpacing: '.05em',
                      }}
                    >
                      {done ? '✓' : `${v.livePct}%`}
                    </span>
                  </div>
                  {/* projected overrun extension */}
                  {over && (
                    <div
                      style={{
                        position: 'absolute',
                        top: 3,
                        bottom: 3,
                        right: 0,
                        width: `${(overW / (w + overW)) * 100}%`,
                        background: late ? 'var(--accsoft)' : 'var(--agentsoft)',
                        border: `1px dashed ${late ? 'var(--bad)' : 'var(--warn)'}`,
                        borderLeft: 'none',
                        borderRadius: '0 3px 3px 0',
                      }}
                      title={`Projected to ${fmtD(v.projectedEnd as string)} (${v.deltaDays} days past plan)`}
                    />
                  )}
                </motion.button>
              );
            })}
          </div>

          {/* milestones — collision-aware lanes so clustered dates stagger */}
          {eng.milestones && eng.milestones.length > 0 && (
            <MilestoneLanes milestones={eng.milestones} winS={winS} winE={winE} />
          )}
        </div>

        {/* selected item drill-down */}
        <AnimatePresence>
          {selectedItem && (
            <motion.div
              key={selectedItem.name}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: 'easeOut' }}
              style={{ overflow: 'hidden' }}
            >
              <ItemDetail item={selectedItem} settings={settings} openTicket={openTicket} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* unscheduled work */}
      {unscheduled.length > 0 && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '12px 16px', marginTop: 14 }}>
          <span style={{ ...mono(500, 10), color: 'var(--warn)', letterSpacing: '.08em' }}>
            UNSCHEDULED — {unscheduled.length} TICKET{unscheduled.length > 1 ? 'S' : ''} NOT LINKED TO A ROADMAP ITEM
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {unscheduled.map((t) => (
              <TicketChip key={t.key} t={t} onClick={() => openTicket(t.key)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MilestoneLanes({ milestones, winS, winE }: { milestones: NonNullable<Engagement['milestones']>; winS: string; winE: string }) {
  const MIN_GAP = 15;
  const LANE_H = 46;
  const laneEnd: number[] = [];
  const placed = milestones
    .map((ms) => ({ ms, p: Math.max(1, Math.min(99, pct(winS, winE, ms.d))) }))
    .sort((a, b) => a.p - b.p)
    .map((x) => {
      let lane = laneEnd.findIndex((end) => x.p - end >= MIN_GAP);
      if (lane === -1) lane = laneEnd.length;
      laneEnd[lane] = x.p;
      return { ...x, lane };
    });
  return (
    <div style={{ marginTop: 20, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 10 }}>MILESTONES</div>
      <div style={{ height: Math.max(1, laneEnd.length) * LANE_H + 4, position: 'relative' }}>
        {placed.map(({ ms, p, lane }) => {
          const nearRight = p > 85;
          const nearLeft = p < 8;
          const align = nearRight ? 'flex-end' : nearLeft ? 'flex-start' : 'center';
          const tx = nearRight ? 'translateX(-100%)' : nearLeft ? 'none' : 'translateX(-50%)';
          return (
            <div
              key={ms.label + ms.d}
              title={`${ms.label} · ${fmtD(ms.d)}`}
              style={{ position: 'absolute', left: `${p}%`, top: lane * LANE_H, transform: tx, display: 'flex', flexDirection: 'column', alignItems: align, gap: 4, maxWidth: 240 }}
            >
              <div
                className="rm-milestone"
                style={{
                  width: 9,
                  height: 9,
                  flex: 'none',
                  transform: 'rotate(45deg)',
                  background: ms.done ? 'var(--ok)' : 'var(--bg2)',
                  border: `1.5px solid ${ms.done ? 'var(--ok)' : 'var(--tx3)'}`,
                }}
              />
              <div style={{ ...mono(400, 9), color: ms.done ? 'var(--tx2)' : 'var(--tx)', whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {ms.label.toUpperCase()}
              </div>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)' }}>{fmtD(ms.d)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ItemDetail({ item, settings, openTicket }: { item: RoadmapItemView; settings: RoadmapSettings; openTicket: (key: string) => void }) {
  const remaining = item.totalHours - item.doneHours;
  const projection =
    item.projectedEnd == null
      ? 'No sized tickets linked yet — the bar shows the planned baseline.'
      : item.livePct === 100
        ? 'All linked work is done.'
        : (item.deltaDays ?? 0) > 2
          ? `Projected to ${fmtD(item.projectedEnd)} — ${item.deltaDays} days past plan.`
          : (item.deltaDays ?? 0) < -2
            ? `Projected to ${fmtD(item.projectedEnd)} — ${Math.abs(item.deltaDays ?? 0)} days ahead of plan.`
            : `Projected to ${fmtD(item.projectedEnd)} — on plan.`;
  const projColor = item.projectedEnd == null ? 'var(--tx3)' : (item.deltaDays ?? 0) > 2 ? 'var(--bad)' : (item.deltaDays ?? 0) < -2 ? 'var(--ok)' : 'var(--tx2)';
  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{item.name}</span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
          PLAN {fmtD(item.s)} – {fmtD(item.e)}
        </span>
        <span style={{ ...mono(400, 10), color: 'var(--tx2)' }}>
          {item.doneHours}H DONE / {item.totalHours}H LINKED{remaining > 0 ? ` · ${remaining}H (≈${Math.ceil((remaining / settings.hoursPerDay) * (1 + settings.bufferPct / 100))} DAYS) REMAINING` : ''}
          {item.unsized > 0 ? ` · ${item.unsized} UNSIZED` : ''}
        </span>
        <span style={{ fontSize: 11.5, color: projColor }}>{projection}</span>
      </div>
      {item.tickets.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--tx3)', marginTop: 10 }}>No board tickets linked to this item yet — new tickets are linked automatically at creation.</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {item.tickets.map((t) => (
            <TicketChip key={t.key} t={t} onClick={() => openTicket(t.key)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TicketChip({ t, onClick }: { t: Ticket; onClick: () => void }) {
  return (
    <motion.button
      className="hv-border-bg"
      onClick={onClick}
      whileHover={{ transform: 'translateY(-1px)' }}
      title={`${t.title} · ${STATUS_LABEL[t.status] ?? t.status}${t.estHours != null ? ` · ${t.estHours}h` : ''}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        border: '1px solid var(--line2)',
        background: 'var(--bg2)',
        borderRadius: 3,
        padding: '4px 9px',
        cursor: 'pointer',
        color: 'var(--tx)',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_DOT[t.status] ?? 'var(--tx3)', flex: 'none' }} />
      <span style={{ ...mono(500, 10.5) }}>{t.key}</span>
      <span style={{ fontSize: 11.5, color: 'var(--tx2)', maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
      {t.estHours != null && <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{t.estHours}h</span>}
    </motion.button>
  );
}

function RoadmapSettingsPanel({
  engId,
  current,
  onSaved,
  onError,
}: {
  engId: string;
  current: RoadmapSettings;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [hoursPerDay, setHoursPerDay] = useState(String(current.hoursPerDay));
  const [bufferPct, setBufferPct] = useState(String(current.bufferPct));
  const [workdaysPerWeek, setWorkdaysPerWeek] = useState(String(current.workdaysPerWeek));
  const [saving, setSaving] = useState(false);

  const save = () => {
    const parsed: RoadmapSettings = {
      hoursPerDay: Number(hoursPerDay),
      bufferPct: Number(bufferPct),
      workdaysPerWeek: Number(workdaysPerWeek),
    };
    if (!Number.isFinite(parsed.hoursPerDay) || parsed.hoursPerDay <= 0 || !Number.isFinite(parsed.bufferPct) || parsed.bufferPct < 0 || !Number.isFinite(parsed.workdaysPerWeek) || parsed.workdaysPerWeek < 1 || parsed.workdaysPerWeek > 7) {
      onError('enter valid numbers');
      return;
    }
    setSaving(true);
    api
      .saveRoadmapSettings(engId, parsed)
      .then(onSaved)
      .catch((e: Error) => onError(e.message))
      .finally(() => setSaving(false));
  };

  const field = (label: string, hint: string, value: string, set: (v: string) => void) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ ...mono(500, 9.5), color: 'var(--tx3)', letterSpacing: '.08em' }}>{label}</span>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        inputMode="decimal"
        style={{ width: 90, background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 3, color: 'var(--tx)', padding: '6px 9px', fontSize: 12.5 }}
      />
      <span style={{ fontSize: 10.5, color: 'var(--tx3)' }}>{hint}</span>
    </label>
  );

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{ overflow: 'hidden' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap', border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg)', padding: '12px 16px', marginBottom: 18 }}>
        {field('AGENT-HOURS PER DAY', 'Effort hours that land in one working day', hoursPerDay, setHoursPerDay)}
        {field('BUFFER %', 'Schedule slack on top of translated days', bufferPct, setBufferPct)}
        {field('WORKDAYS / WEEK', 'Converts working days to calendar days', workdaysPerWeek, setWorkdaysPerWeek)}
        <div style={{ flex: 1 }} />
        <button
          onClick={save}
          disabled={saving}
          style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: saving ? 0.5 : 1 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </motion.div>
  );
}
