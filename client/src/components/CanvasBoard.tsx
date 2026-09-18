import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, useMotionValue } from 'motion/react';
import { api } from '../api';
import type { AgentTask, CanvasData, CanvasTraffic, CanvasZone, Ticket, TicketStatus } from '../types';
import { fmtDuration, initials, mono, STATUS_LABEL } from '../util';
import { runnerBrand } from './RunnerLogo';
import { MapViewport } from './MapViewport';
import type { View } from '../lib/map-zoom';
import { needsEstimate } from '../lib/ticket-hours';
import { PLANNING_REVIEW_LABEL, planningReviewTitle } from '../lib/planning-review';
import {
  assignZones,
  CARD_W,
  curvePath,
  layoutLoose,
  layoutZone,
  MAX_COLS,
  MIN_COLS,
  nextZoneOrigin,
  orthoPath,
  routeLink,
  worldSize,
  ZONE_HEAD,
  type Box,
} from '../lib/canvas-layout';

/**
 * The canvas board (DAT-281). Tags are zones on a pan/zoom surface; a zone lays
 * its cards out in dependency layers (blockers left of, or above, what they
 * block); links draw between cards as orthogonal routed lines; agent
 * coordination traffic draws as flowing curves between the cards the agents
 * are working. Done tickets leave the canvas for the Completed rail.
 *
 * Zones are the only state the canvas owns (per engagement, on the server).
 * Card positions are always derived, so the board is never out of date with
 * the tickets — dragging a card into a zone changes its tags, not a position.
 */

const POLL_MS = 8000;
const MARGIN = 40;
const PR_STATE_COLOR: Record<string, string> = { open: 'var(--warn)', merged: 'var(--ok)', closed: 'var(--tx3)' };
const STATUS_COLOR: Record<TicketStatus, string> = {
  backlog: 'var(--tx3)',
  progress: 'var(--agent)',
  review: 'var(--warn)',
  deploying: 'var(--acc)',
  done: 'var(--ok)',
  proposed: 'var(--agent)',
  dismissed: 'var(--tx3)',
};
const LINK_STYLE = {
  blocks: { stroke: 'var(--bad)', dash: undefined, width: 1.4, marker: 'url(#eec-arrow-bad)' },
  relates: { stroke: 'var(--line2)', dash: undefined, width: 1.2, marker: undefined },
  mention: { stroke: 'var(--line2)', dash: '4 4', width: 1.1, marker: undefined },
} as const;
const SPRING = { type: 'spring', stiffness: 420, damping: 34 } as const;

const readPref = (key: string, fallback: boolean): boolean => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};
const writePref = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, v ? '1' : '0');
  } catch {
    /* private mode: the toggle still works for this page */
  }
};

/** Relative age; re-evaluated with every board poll, which is what keeps it honest. */
const ago = (iso: string | null) => {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

type TrafficPair = { key: string; from: string; to: string; latest: CanvasTraffic; messages: CanvasTraffic[] };

export function CanvasBoard({
  engId,
  tickets,
  agentTasks,
  lead,
  fleetDown,
  active,
  openTicket,
  setTicket,
  onAssign,
  onDeploy,
  onNewTicket,
  toast,
}: {
  engId: string;
  tickets: Ticket[];
  agentTasks: AgentTask[];
  lead: boolean;
  fleetDown: boolean;
  /** Whether the board is the visible tab — polling pauses otherwise. */
  active: boolean;
  openTicket: (key: string) => void;
  setTicket: (key: string, patch: { status?: TicketStatus; assignee?: string; tags?: string[] }) => void;
  /** Opens the assign popover at a screen position (owned by the workspace). */
  onAssign: (key: string, x: number, y: number) => void;
  onDeploy: (key: string) => void;
  onNewTicket: () => void;
  toast: (msg: string) => void;
}) {
  const [data, setData] = useState<CanvasData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Zones as the board shows them: the server's list, with in-flight moves
  // applied on top so a drag never snaps back before its save lands.
  const [zones, setZones] = useState<CanvasZone[]>([]);
  const [showLinks, setShowLinks] = useState(() => readPref('eec-canvas-links', true));
  const [showTraffic, setShowTraffic] = useState(() => readPref('eec-canvas-traffic', true));
  const [completedOpen, setCompletedOpen] = useState(() => readPref('eec-canvas-completed', false));
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [zonePanel, setZonePanel] = useState(false);
  const [zoneTag, setZoneTag] = useState('');
  const [hoverPair, setHoverPair] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overZone, setOverZone] = useState<number | null>(null);
  const [draggingZone, setDraggingZone] = useState<number | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const busyRef = useRef(false); // a drag is in flight: hold the poll
  const suppressClick = useRef(false);
  const ghostX = useMotionValue(0);
  const ghostY = useMotionValue(0);
  const reduced = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const load = useCallback(() => {
    api
      .canvas(engId)
      .then((d) => {
        setData(d);
        setLoadError(null);
        if (!busyRef.current) setZones(d.zones);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [engId]);

  // The workspace remounts the board per engagement (`key={eng.id}`), so a
  // first load is all the mount needs; there is no stale state to clear.
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => {
      if (!busyRef.current) load();
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [active, load]);

  // ---- what is on the board ----

  const agentTaskByTicket = useMemo(() => {
    const map = new Map<string, AgentTask>();
    for (const t of agentTasks) if (!map.has(t.ticketKey)) map.set(t.ticketKey, t);
    return map;
  }, [agentTasks]);
  const queuePosition = useMemo(() => {
    const queued = agentTasks.filter((a) => a.state === 'queued').sort((a, b) => b.priority - a.priority || a.id - b.id);
    return new Map(queued.map((a, i) => [a.ticketKey, i + 1]));
  }, [agentTasks]);

  const matchesFilter = useCallback(
    (t: Ticket): boolean =>
      (filterAssignee === '' || (filterAssignee === '—' ? t.assignee === '' || t.assignee === '—' : t.assignee === filterAssignee)) &&
      (filterTag === '' || t.tags.includes(filterTag)),
    [filterAssignee, filterTag],
  );
  const onBoard = useMemo(
    () => tickets.filter((t) => t.status !== 'proposed' && t.status !== 'dismissed' && t.status !== 'done' && matchesFilter(t)),
    [tickets, matchesFilter],
  );
  const completed = useMemo(
    () =>
      tickets
        .filter((t) => t.status === 'done')
        .sort((a, b) => (b.doneAt ? Date.parse(b.doneAt) : 0) - (a.doneAt ? Date.parse(a.doneAt) : 0)),
    [tickets],
  );
  const filterAssignees = useMemo(() => [...new Set(tickets.map((t) => t.assignee).filter((a) => a && a !== '—'))].sort(), [tickets]);
  const allTags = useMemo(() => [...new Set(tickets.flatMap((t) => t.tags))].sort(), [tickets]);
  const unzonedTags = useMemo(() => allTags.filter((tag) => !zones.some((z) => z.tag === tag)), [allTags, zones]);
  const filterActive = filterAssignee !== '' || filterTag !== '';

  // ---- geometry ----

  const layout = useMemo(() => {
    const blocks = (data?.links ?? []).filter((l) => l.type === 'blocks');
    const { byZone, loose } = assignZones(onBoard, zones);
    const zoneBoxes = new Map<number, Box>();
    const cards = new Map<string, Box>();
    const owner = new Map<string, CanvasZone>();
    for (const z of zones) {
      const keys = byZone.get(z.id) ?? [];
      const laid = layoutZone(z, keys, blocks);
      zoneBoxes.set(z.id, laid.box);
      for (const [k, b] of laid.cards) {
        cards.set(k, b);
        owner.set(k, z);
      }
    }
    const boxes = [...zoneBoxes.values()];
    const looseOrigin = nextZoneOrigin(boxes, MARGIN);
    const looseY = zones.length > 0 ? looseOrigin.y + ZONE_HEAD : MARGIN;
    for (const [k, b] of layoutLoose(loose, MARGIN, looseY)) cards.set(k, b);
    const world = worldSize([...boxes, ...cards.values()], MARGIN);
    return { zoneBoxes, cards, owner, loose, looseY, world: { w: Math.max(world.w, 900), h: Math.max(world.h, 600) } };
  }, [data?.links, onBoard, zones]);

  const routedLinks = useMemo(() => {
    if (!showLinks || !data) return [];
    const obstacles = [...layout.cards.values()];
    return data.links.flatMap((l) => {
      const a = layout.cards.get(l.from);
      const b = layout.cards.get(l.to);
      if (!a || !b) return [];
      return [{ ...l, d: orthoPath(routeLink(a, b, obstacles)) }];
    });
  }, [data, layout.cards, showLinks]);

  const trafficPairs = useMemo((): TrafficPair[] => {
    if (!showTraffic || !data) return [];
    const pairs = new Map<string, TrafficPair>();
    for (const m of data.traffic) {
      if (!m.from || !m.to || m.from === m.to) continue;
      if (!layout.cards.has(m.from) || !layout.cards.has(m.to)) continue;
      const key = [m.from, m.to].sort().join('|');
      const p = pairs.get(key);
      if (p) p.messages.push(m);
      else pairs.set(key, { key, from: m.from, to: m.to, latest: m, messages: [m] });
    }
    return [...pairs.values()];
  }, [data, layout.cards, showTraffic]);
  /** Cards with recent traffic whose other end is off this board: a pulse, not a line. */
  const pulseKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!showTraffic || !data) return keys;
    for (const m of data.traffic) {
      if (m.from && !m.to) keys.add(m.from);
      if (m.to && !m.from) keys.add(m.to);
    }
    return keys;
  }, [data, showTraffic]);

  // ---- pointer → world ----

  const worldPoint = (clientX: number, clientY: number) => {
    const host = hostRef.current;
    const r = host ? host.getBoundingClientRect() : { left: 0, top: 0 };
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.scale, y: (clientY - r.top - v.y) / v.scale };
  };
  const zoneAt = (p: { x: number; y: number }): CanvasZone | null => {
    for (const z of zones) {
      const b = layout.zoneBoxes.get(z.id);
      if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return z;
    }
    return null;
  };

  /** Card drag: the card rides the cursor; dropping it in a zone retags it. */
  const beginCardDrag = (e: React.PointerEvent, t: Ticket) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button,a,select,input,textarea')) return;
    e.stopPropagation(); // the viewport must not pan
    const box = layout.cards.get(t.key);
    if (!box) return;
    const start = { x: e.clientX, y: e.clientY };
    let started = false;
    let over: CanvasZone | null = null;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        started = true;
        busyRef.current = true;
        suppressClick.current = true;
        document.body.style.userSelect = 'none';
        setDragKey(t.key);
      }
      const scale = viewRef.current.scale;
      ghostX.set(box.x + (ev.clientX - start.x) / scale);
      ghostY.set(box.y + (ev.clientY - start.y) / scale);
      const z = zoneAt(worldPoint(ev.clientX, ev.clientY));
      if (z?.id !== over?.id) {
        over = z;
        setOverZone(z?.id ?? null);
      }
    };
    const finish = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      document.body.style.userSelect = '';
      if (!started) return;
      busyRef.current = false;
      setDragKey(null);
      setOverZone(null);
      setTimeout(() => (suppressClick.current = false), 0);
      if (!drop) return;
      const was = layout.owner.get(t.key) ?? null;
      if (over?.id === was?.id) return;
      const tags = t.tags.filter((g) => g !== was?.tag);
      if (over && !tags.includes(over.tag)) tags.push(over.tag);
      setTicket(t.key, { tags });
      toast(over ? `${t.key} moved into ${over.tag}` : was ? `${t.key} left ${was.tag}` : `${t.key} unchanged`);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  /** Zone drag from its header: optimistic move, saved on release. */
  const beginZoneDrag = (e: React.PointerEvent, z: CanvasZone) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button,a,input')) return;
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, zx: z.x, zy: z.y };
    let frame = 0;
    let next = { x: z.x, y: z.y };
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        started = true;
        busyRef.current = true;
        setDraggingZone(z.id);
      }
      const scale = viewRef.current.scale;
      next = { x: Math.max(0, Math.round(start.zx + (ev.clientX - start.x) / scale)), y: Math.max(0, Math.round(start.zy + (ev.clientY - start.y) / scale)) };
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setZones((zs) => zs.map((x) => (x.id === z.id ? { ...x, ...next } : x)));
        });
      }
    };
    const finish = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (frame !== 0) cancelAnimationFrame(frame);
      if (!started) return;
      busyRef.current = false;
      setDraggingZone(null);
      setZones((zs) => zs.map((x) => (x.id === z.id ? { ...x, ...next } : x)));
      if (!drop) return;
      api.updateZone(engId, z.id, next).catch((e: Error) => {
        toast(`Zone move failed — ${e.message}`);
        load();
      });
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const setCols = (z: CanvasZone, cols: number) => {
    const c = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
    if (c === z.cols) return;
    setZones((zs) => zs.map((x) => (x.id === z.id ? { ...x, cols: c } : x)));
    api.updateZone(engId, z.id, { cols: c }).catch((e: Error) => {
      toast(`Zone resize failed — ${e.message}`);
      load();
    });
  };
  const removeZone = (z: CanvasZone) => {
    setZones((zs) => zs.filter((x) => x.id !== z.id));
    api
      .deleteZone(engId, z.id)
      .then(() => toast(`Zone ${z.tag} removed — its tickets keep the tag`))
      .catch((e: Error) => {
        toast(`Remove failed — ${e.message}`);
        load();
      });
  };
  const createZone = (tagRaw: string) => {
    const tag = tagRaw.trim();
    if (!tag) return;
    if (zones.some((z) => z.tag.toLowerCase() === tag.toLowerCase())) {
      toast(`There is already a zone for ${tag}`);
      return;
    }
    // Under the other zones only: loose cards always reflow beneath the zones.
    const at = nextZoneOrigin([...layout.zoneBoxes.values()], MARGIN);
    setZonePanel(false);
    setZoneTag('');
    api
      .createZone(engId, tag, at)
      .then((z) => {
        setZones((zs) => [...zs, z]);
        toast(`Zone ${z.tag} added`);
      })
      .catch((e: Error) => toast(`Zone failed — ${e.message}`));
  };

  // ---- render ----

  const ticketByKey = useMemo(() => new Map(tickets.map((t) => [t.key, t])), [tickets]);
  const runnerFor = (t: Ticket): string | null => {
    const at = agentTaskByTicket.get(t.key);
    return at?.agent != null && at.agent !== '' && at.agent === t.assignee ? at.agent : null;
  };

  const card = (t: Ticket, box: Box, ghost = false) => (
    <TicketCard
      ticket={t}
      task={agentTaskByTicket.get(t.key) ?? null}
      queuePos={queuePosition.get(t.key) ?? null}
      runner={runnerFor(t)}
      zoneTag={layout.owner.get(t.key)?.tag ?? null}
      lead={lead}
      fleetDown={fleetDown}
      pulse={pulseKeys.has(t.key)}
      ghost={ghost}
      onPointerDown={(e) => beginCardDrag(e, t)}
      onClick={() => {
        if (!suppressClick.current) openTicket(t.key);
      }}
      onAssign={(x, y) => onAssign(t.key, x, y)}
      onDeploy={() => onDeploy(t.key)}
      box={box}
    />
  );

  const dragged = dragKey ? ticketByKey.get(dragKey) : undefined;
  const hovered = hoverPair ? trafficPairs.find((p) => p.key === hoverPair) : undefined;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* toolbar */}
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 22px', flexWrap: 'wrap' }}>
        <button
          className="hv-border"
          onClick={onNewTicket}
          title="Shortcut: N"
          style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
        >
          + New ticket
        </button>
        <div style={{ position: 'relative' }}>
          <button
            className="hv-border"
            onClick={() => setZonePanel((v) => !v)}
            style={{
              border: `1px solid ${zonePanel ? 'var(--tx3)' : 'var(--line2)'}`,
              background: zonePanel ? 'var(--bg3)' : 'none',
              color: 'var(--tx)',
              borderRadius: 3,
              padding: '5px 12px',
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            + New zone
          </button>
          {zonePanel && (
            <NewZonePanel
              suggestions={unzonedTags}
              value={zoneTag}
              onChange={setZoneTag}
              onCreate={() => createZone(zoneTag)}
              onClose={() => setZonePanel(false)}
            />
          )}
        </div>
        <div style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 2px' }} />
        <span style={{ ...mono(500, 9.5), color: 'var(--tx3)', letterSpacing: '.1em' }}>FILTER</span>
        <select value={filterAssignee} onChange={(e) => setFilterAssignee(e.target.value)} style={filterSelect(filterAssignee !== '')}>
          <option value="">Everyone</option>
          <option value="—">Unassigned</option>
          {filterAssignees.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} style={filterSelect(filterTag !== '')}>
          <option value="">Any tag</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {filterActive && (
          <button
            onClick={() => {
              setFilterAssignee('');
              setFilterTag('');
            }}
            style={{ border: 'none', background: 'none', color: 'var(--acc)', ...mono(500, 10), cursor: 'pointer', letterSpacing: '.06em', padding: 0 }}
          >
            ✕ CLEAR
          </button>
        )}
        <div style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 2px' }} />
        <Toggle
          label="Links"
          on={showLinks}
          onChange={(v) => {
            setShowLinks(v);
            writePref('eec-canvas-links', v);
          }}
        />
        <Toggle
          label="Agent traffic"
          on={showTraffic}
          onChange={(v) => {
            setShowTraffic(v);
            writePref('eec-canvas-traffic', v);
          }}
        />
        <div style={{ flex: 1 }} />
        {loadError && (
          <span style={{ ...mono(400, 10), color: 'var(--bad)' }} title={loadError}>
            CANVAS OFFLINE — SHOWING TICKETS ONLY
          </span>
        )}
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
          {onBoard.length} ON THE CANVAS · {zones.length} {zones.length === 1 ? 'ZONE' : 'ZONES'}
          {layout.loose.length > 0 ? ` · ${layout.loose.length} LOOSE` : ''}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', margin: '0 22px 16px', border: '1px solid var(--line)', borderRadius: 5, overflow: 'hidden' }}>
        <div ref={hostRef} style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex' }}>
          <MapViewport
            ariaLabel="Canvas board — scroll or pinch to zoom, drag to pan, 0 to reset"
            hint={null}
            frameless
            controls="bottom-right"
            contentSize={layout.world}
            minHeight={0}
            onViewChange={(v) => {
              viewRef.current = v;
            }}
          >
            {/* dot grid: the surface reads as a canvas, not a page */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
                backgroundPosition: '12px 12px',
                pointerEvents: 'none',
              }}
            />

            {zones.map((z) => {
              const b = layout.zoneBoxes.get(z.id);
              if (!b) return null;
              const hot = overZone === z.id;
              const count = onBoard.filter((t) => layout.owner.get(t.key)?.id === z.id).length;
              return (
                <div
                  key={z.id}
                  style={{
                    position: 'absolute',
                    left: b.x,
                    top: b.y,
                    width: b.w,
                    height: b.h,
                    boxSizing: 'border-box',
                    border: `1px ${hot ? 'solid var(--agent)' : 'dashed var(--line2)'}`,
                    background: hot ? 'var(--agentsoft)' : 'transparent',
                    borderRadius: 6,
                    opacity: draggingZone === z.id ? 0.85 : 1,
                    transition: 'border-color .15s ease, background-color .15s ease',
                  }}
                >
                  <div
                    onPointerDown={(e) => beginZoneDrag(e, z)}
                    style={{
                      position: 'absolute',
                      left: 10,
                      top: -11,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      background: 'var(--bg)',
                      padding: '0 6px',
                      cursor: draggingZone === z.id ? 'grabbing' : 'grab',
                      userSelect: 'none',
                    }}
                  >
                    <span style={{ ...mono(500, 11), color: 'var(--tx3)', lineHeight: 1 }} aria-hidden="true">
                      ⠿
                    </span>
                    <span style={{ ...mono(500, 10), color: 'var(--tx2)', border: '1px solid var(--line2)', borderRadius: 2, padding: '2px 7px' }}>{z.tag}</span>
                    <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{count}</span>
                    <span style={{ display: 'inline-flex', gap: 2, marginLeft: 4 }}>
                      <ZoneBtn label="Fewer columns" onClick={() => setCols(z, z.cols - 1)} disabled={z.cols <= MIN_COLS}>
                        −
                      </ZoneBtn>
                      <ZoneBtn label="More columns" onClick={() => setCols(z, z.cols + 1)} disabled={z.cols >= MAX_COLS}>
                        +
                      </ZoneBtn>
                      <ZoneBtn label={`Remove zone ${z.tag}`} onClick={() => removeZone(z)} danger>
                        ✕
                      </ZoneBtn>
                    </span>
                  </div>
                </div>
              );
            })}

            {layout.loose.length > 0 && zones.length > 0 && (
              <div style={{ position: 'absolute', left: MARGIN, top: layout.looseY - 20, ...mono(500, 10), letterSpacing: '.1em', color: 'var(--tx3)' }}>
                NO ZONE · DRAG INTO ONE TO TAG
              </div>
            )}

            <svg
              width={layout.world.w}
              height={layout.world.h}
              style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}
              aria-hidden="true"
            >
              <defs>
                <marker id="eec-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--bad)" />
                </marker>
                <marker id="eec-arrow-agent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--agent)" />
                </marker>
                <filter id="eec-glow" x="-20%" y="-20%" width="140%" height="140%">
                  <feGaussianBlur stdDeviation="3.5" />
                </filter>
              </defs>
              {routedLinks.map((l) => {
                const s = LINK_STYLE[l.type];
                return (
                  <path
                    key={`${l.type}-${l.from}-${l.to}`}
                    d={l.d}
                    fill="none"
                    stroke={s.stroke}
                    strokeWidth={s.width}
                    strokeDasharray={s.dash}
                    markerEnd={s.marker}
                    opacity={0.9}
                  />
                );
              })}
              {trafficPairs.map((p, i) => {
                const a = layout.cards.get(p.latest.from ?? '');
                const b = layout.cards.get(p.latest.to ?? '');
                if (!a || !b) return null;
                const { d } = curvePath(a, b, 24);
                const id = `eec-traffic-${i}`;
                return (
                  <g key={p.key}>
                    <path id={id} d={d} fill="none" stroke="var(--agent)" strokeWidth={7} opacity={0.28} filter="url(#eec-glow)" />
                    <path d={d} fill="none" stroke="var(--agent)" strokeWidth={1.6} opacity={0.9} markerEnd="url(#eec-arrow-agent)" />
                    <path className="eec-flow" d={d} fill="none" stroke="#fff" strokeWidth={1.6} opacity={0.55} strokeDasharray="3 14" strokeLinecap="round" />
                    {!reduced && (
                      <>
                        <circle r={3.2} fill="#fff" opacity={0.95}>
                          <animateMotion dur="2.6s" repeatCount="indefinite">
                            <mpath href={`#${id}`} />
                          </animateMotion>
                        </circle>
                        <circle r={7} fill="var(--agent)" opacity={0.35} filter="url(#eec-glow)">
                          <animateMotion dur="2.6s" repeatCount="indefinite">
                            <mpath href={`#${id}`} />
                          </animateMotion>
                        </circle>
                      </>
                    )}
                  </g>
                );
              })}
            </svg>

            {onBoard.map((t) => {
              const box = layout.cards.get(t.key);
              if (!box) return null;
              return (
                <motion.div
                  key={t.key}
                  initial={false}
                  animate={{ x: box.x, y: box.y }}
                  transition={reduced ? { duration: 0 } : SPRING}
                  style={{ position: 'absolute', left: 0, top: 0, width: CARD_W, opacity: dragKey === t.key ? 0.3 : 1 }}
                >
                  {card(t, box)}
                </motion.div>
              );
            })}

            {/* traffic labels: hover for the thread */}
            {trafficPairs.map((p) => {
              const a = layout.cards.get(p.latest.from ?? '');
              const b = layout.cards.get(p.latest.to ?? '');
              if (!a || !b) return null;
              const { mid } = curvePath(a, b, 24);
              return (
                <div
                  key={`label-${p.key}`}
                  onPointerEnter={() => setHoverPair(p.key)}
                  onPointerLeave={() => setHoverPair((h) => (h === p.key ? null : h))}
                  style={{ position: 'absolute', left: mid[0], top: mid[1], transform: 'translate(-50%,-50%)', zIndex: 3 }}
                >
                  <div
                    style={{
                      ...mono(500, 8.5),
                      letterSpacing: '.07em',
                      color: 'var(--agent)',
                      background: 'var(--bg)',
                      border: '1px solid var(--agent)',
                      borderRadius: 2,
                      padding: '2px 6px',
                      whiteSpace: 'nowrap',
                      cursor: 'default',
                    }}
                  >
                    {p.latest.type.replace(/_/g, ' ').toUpperCase()} → @{p.latest.recipient ?? 'all'} · {ago(p.latest.createdAt)}
                  </div>
                  {hovered?.key === p.key && <TrafficThread pair={p} openTicket={openTicket} />}
                </div>
              );
            })}

            {dragged && layout.cards.get(dragged.key) && (
              <motion.div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  x: ghostX,
                  y: ghostY,
                  width: CARD_W,
                  zIndex: 5,
                  pointerEvents: 'none',
                  filter: 'drop-shadow(0 14px 28px rgba(0,0,0,.35))',
                  rotate: 1.5,
                }}
              >
                {card(dragged, layout.cards.get(dragged.key) as Box, true)}
              </motion.div>
            )}
          </MapViewport>

          {onBoard.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
              <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '16px 18px', fontSize: 12.5, color: 'var(--tx2)' }}>
                {filterActive ? 'No tickets match these filters.' : 'No tickets on the canvas yet.'}
              </div>
            </div>
          )}

          <Legend />
        </div>

        <CompletedRail
          open={completedOpen}
          tickets={completed}
          onToggle={() => {
            setCompletedOpen((v) => {
              writePref('eec-canvas-completed', !v);
              return !v;
            });
          }}
          openTicket={openTicket}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const filterSelect = (on: boolean): React.CSSProperties => ({
  background: 'var(--bg2)',
  border: `1px solid ${on ? 'var(--agent)' : 'var(--line2)'}`,
  borderRadius: 3,
  color: on ? 'var(--agent)' : 'var(--tx2)',
  padding: '4px 8px',
  fontSize: 11.5,
});

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className="hv-border"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        border: `1px solid ${on ? 'var(--tx3)' : 'var(--line)'}`,
        background: on ? 'var(--bg3)' : 'transparent',
        color: on ? 'var(--tx)' : 'var(--tx2)',
        borderRadius: 3,
        padding: '4px 9px 4px 7px',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: on ? 'var(--ok)' : 'var(--tx3)' }} />
      {label}
    </button>
  );
}

function ZoneBtn({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      className={danger ? 'hv-bad' : 'hv-tx'}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 18,
        height: 16,
        border: 'none',
        background: 'none',
        color: 'var(--tx3)',
        ...mono(500, 11),
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.35 : 1,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function NewZonePanel({
  suggestions,
  value,
  onChange,
  onCreate,
  onClose,
}: {
  suggestions: string[];
  value: string;
  onChange: (v: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 'calc(100% + 6px)',
          width: 270,
          zIndex: 41,
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 4,
          boxShadow: '0 14px 32px rgba(0,0,0,.45)',
          padding: '10px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ ...mono(500, 10), letterSpacing: '.1em', color: 'var(--tx2)' }}>NEW ZONE</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreate();
              if (e.key === 'Escape') onClose();
            }}
            placeholder="Tag, e.g. board"
            aria-label="Zone tag"
            style={{ flex: 1, minWidth: 0, border: '1px solid var(--line2)', background: 'var(--bg)', color: 'var(--tx)', borderRadius: 3, padding: '5px 9px', fontSize: 12 }}
          />
          <button
            onClick={onCreate}
            disabled={!value.trim()}
            style={{ border: '1px solid var(--tx3)', background: 'var(--bg3)', color: 'var(--tx)', borderRadius: 3, padding: '5px 10px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', opacity: value.trim() ? 1 : 0.5 }}
          >
            Create
          </button>
        </div>
        {suggestions.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <span style={{ ...mono(400, 9.5), color: 'var(--tx3)', letterSpacing: '.08em' }}>ON THE BOARD</span>
            {suggestions.slice(0, 8).map((tag) => (
              <button
                key={tag}
                className="hv-border"
                onClick={() => onChange(tag)}
                style={{ border: `1px solid ${value === tag ? 'var(--tx3)' : 'var(--line)'}`, background: value === tag ? 'var(--bg3)' : 'transparent', color: 'var(--tx2)', borderRadius: 3, padding: '3px 8px', ...mono(500, 9.5), cursor: 'pointer' }}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--tx3)', lineHeight: 1.4 }}>Tickets with this tag move in and auto-organise; new ones land here too.</div>
      </div>
    </>
  );
}

function Legend() {
  const item = (label: string, color: string, dashed = false, glow = false) => (
    <span
      key={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        border: `1px ${dashed ? 'dashed' : 'solid'} var(--line2)`,
        borderRadius: 3,
        padding: '3px 8px',
        ...mono(400, 8.5),
        color: 'var(--tx2)',
        letterSpacing: '.07em',
        background: 'var(--bg)',
      }}
    >
      <span style={{ width: 14, height: 0, borderTop: `1.5px ${dashed ? 'dashed' : 'solid'} ${color}`, boxShadow: glow ? `0 0 6px ${color}` : undefined }} />
      {label}
    </span>
  );
  return (
    <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6, pointerEvents: 'none' }}>
      {item('BLOCKS', 'var(--bad)')}
      {item('RELATES', 'var(--line2)')}
      {item('MENTION', 'var(--line2)', true)}
      {item('AGENT TRAFFIC', 'var(--agent)', false, true)}
    </div>
  );
}

function TrafficThread({ pair, openTicket }: { pair: TrafficPair; openTicket: (key: string) => void }) {
  const msgs = [...pair.messages].sort((a, b) => b.id - a.id).slice(0, 5);
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: '50%',
        top: 'calc(100% + 6px)',
        transform: 'translateX(-50%)',
        width: 340,
        background: 'var(--bg2)',
        border: '1px solid var(--line2)',
        borderRadius: 4,
        boxShadow: '0 14px 32px rgba(0,0,0,.45)',
        padding: '8px 12px 6px',
        zIndex: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <span style={{ ...mono(500, 10), letterSpacing: '.1em', color: 'var(--agent)' }}>◆ AGENT TRAFFIC</span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
          {pair.from} ↔ {pair.to}
        </span>
        <span style={{ marginLeft: 'auto', ...mono(400, 10), color: 'var(--tx3)' }}>{pair.messages.length} RECENT</span>
      </div>
      {msgs.map((m) => (
        <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, ...mono(400, 9.5), color: 'var(--tx3)' }}>
            <span style={{ color: 'var(--tx2)' }}>{m.sender}</span>
            <span>→ {m.recipient ? `@${m.recipient}` : 'all'}</span>
            <span style={{ ...mono(500, 9), color: m.type === 'conflict_warning' ? 'var(--warn)' : 'var(--agent)', border: `1px solid ${m.type === 'conflict_warning' ? 'var(--warn)' : 'var(--agent)'}`, borderRadius: 2, padding: '1px 4px' }}>
              {m.type.replace(/_/g, ' ').toUpperCase()}
            </span>
            <span style={{ marginLeft: 'auto' }}>{ago(m.createdAt)}</span>
          </div>
          {m.body && (
            <div style={{ fontSize: 11.5, lineHeight: 1.45, color: 'var(--tx)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.body}</div>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 7 }}>
        <span style={{ ...mono(400, 9.5), color: 'var(--tx3)' }}>MIRRORED TO THE TICKETS</span>
        <button onClick={() => openTicket(pair.to)} style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--acc)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
          Open {pair.to} →
        </button>
      </div>
    </div>
  );
}

function CompletedRail({ open, tickets, onToggle, openTicket }: { open: boolean; tickets: Ticket[]; onToggle: () => void; openTicket: (key: string) => void }) {
  return (
    <div
      style={{
        flex: 'none',
        width: open ? 260 : 34,
        borderLeft: '1px solid var(--line)',
        background: 'var(--bg2)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        transition: 'width .18s ease',
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={open ? 'Collapse completed' : 'Show completed'}
        style={{
          flex: 'none',
          border: 'none',
          borderBottom: '1px solid var(--line)',
          background: 'none',
          color: 'var(--tx2)',
          padding: open ? '9px 12px' : '9px 0',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          justifyContent: open ? 'flex-start' : 'center',
          ...mono(500, 10),
          letterSpacing: '.1em',
        }}
      >
        {open ? (
          <>
            <span style={{ color: 'var(--ok)' }}>✓ COMPLETED</span>
            <span style={{ color: 'var(--tx3)' }}>{tickets.length}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--tx3)' }}>›</span>
          </>
        ) : (
          <span style={{ writingMode: 'vertical-rl', color: 'var(--ok)' }}>✓ {tickets.length}</span>
        )}
      </button>
      {open && (
        <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {tickets.length === 0 && <div style={{ padding: '18px 12px', fontSize: 11.5, color: 'var(--tx3)', textAlign: 'center' }}>Nothing completed yet.</div>}
          {tickets.map((t) => (
            <button
              key={t.key}
              className="hv-bg"
              onClick={() => openTicket(t.key)}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid var(--line)', background: 'none', color: 'var(--tx)', padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                <span style={{ ...mono(500, 10), color: 'var(--tx3)' }}>{t.key}</span>
                <span style={{ marginLeft: 'auto', ...mono(400, 9.5), color: 'var(--tx3)' }}>{t.doneAt ? `${ago(t.doneAt)} ago` : ''}</span>
              </div>
              <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.title}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The board card, in the console's card anatomy, plus the status label the
 * lanes used to imply. Fixed height so links can anchor to a known box.
 */
function TicketCard({
  ticket: t,
  task: at,
  queuePos,
  runner,
  zoneTag,
  lead,
  fleetDown,
  pulse,
  ghost,
  box,
  onPointerDown,
  onClick,
  onAssign,
  onDeploy,
}: {
  ticket: Ticket;
  task: AgentTask | null;
  queuePos: number | null;
  runner: string | null;
  zoneTag: string | null;
  lead: boolean;
  fleetDown: boolean;
  pulse: boolean;
  ghost: boolean;
  box: Box;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: () => void;
  onAssign: (x: number, y: number) => void;
  onDeploy: () => void;
}) {
  const running = at?.state === 'claimed' || at?.state === 'working';
  const queued = at?.state === 'queued';
  const agentDone = at?.state === 'done' && t.status === 'review';
  const agentFailed = at?.state === 'failed' && t.status === 'backlog';
  const isDone = t.status === 'done';
  const border = t.blocked
    ? 'var(--bad)'
    : isDone
      ? 'var(--ok)'
      : t.status === 'deploying'
        ? 'var(--acc)'
        : t.status === 'review'
          ? 'var(--warn)'
          : running || queued
            ? 'var(--agent)'
            : t.agent
              ? 'var(--line2)'
              : 'var(--line)';
  const tags = t.tags.filter((g) => g !== zoneTag);
  const chip = (text: string, style: React.CSSProperties, title?: string) => (
    <span title={title} style={{ ...mono(500, 9), borderRadius: 2, padding: '1px 4px', whiteSpace: 'nowrap', ...style }}>
      {text}
    </span>
  );
  return (
    <div
      {...(!ghost && { onPointerDown, onClick, className: 'hv-border' })}
      data-tcard={t.key}
      style={{
        width: box.w,
        height: box.h,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: `1px ${queued ? 'dashed' : 'solid'} ${border}`,
        background: running ? 'var(--agentsoft)' : 'var(--bg2)',
        borderRadius: 3,
        padding: '9px 11px',
        cursor: ghost ? 'grabbing' : 'pointer',
        position: 'relative',
      }}
    >
      {pulse && (
        <span
          title="Recent agent traffic with work outside this board"
          style={{ position: 'absolute', right: 8, top: 8, width: 6, height: 6, borderRadius: '50%', background: 'var(--agent)', boxShadow: '0 0 6px var(--agent)', animation: 'eec-pulse 2.4s infinite' }}
        />
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4, minWidth: 0 }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', flex: 'none' }}>{t.key}</span>
        {running &&
          chip(`◆ ${(at?.agent ?? 'AGENT').toUpperCase()} ON IT`, { background: 'var(--agentsoft)', color: 'var(--agent)', animation: 'eec-pulse 2.4s infinite' }, at?.lastNote ?? undefined)}
        {queued &&
          chip(
            `◇ QUEUED${queuePos ? ` ${queuePos}` : ''}`,
            { border: `1px dashed ${fleetDown ? 'var(--bad)' : 'var(--agent)'}`, color: fleetDown ? 'var(--bad)' : 'var(--agent)' },
            fleetDown ? 'Nothing is online to claim this' : 'Waiting for a runner',
          )}
        {!running && !queued && t.agent && chip('◆ AGENT', { background: 'var(--agentsoft)', color: 'var(--agent)' })}
        {t.planningReview &&
          chip(PLANNING_REVIEW_LABEL, { background: 'var(--agentsoft)', color: 'var(--agent)', border: '1px solid var(--agent)', animation: 'eec-pulse 2.4s infinite' }, planningReviewTitle(t.planningReview))}
        {agentDone && chip('◆ READY FOR REVIEW', { color: 'var(--warn)', border: '1px solid var(--warn)' })}
        {agentFailed && chip('✕ AGENT FAILED', { color: 'var(--bad)', border: '1px solid var(--bad)' })}
        {t.blocked && <span style={{ ...mono(500, 9), color: 'var(--bad)' }}>BLOCKED</span>}
        {!isDone && t.escalationStage === 'flagged' && chip('⚠ REVIEW SLA 48H', { color: 'var(--bad)', border: '1px solid var(--bad)' })}
        {!isDone && t.escalationStage === 'pinged' && chip('⏰ REVIEW SLA 24H', { color: 'var(--warn)', border: '1px solid var(--warn)' })}
        {!isDone && t.waitingOn > 0 && chip(`⧗ WAITING ON ${t.waitingOn}`, { color: 'var(--bad)', border: '1px solid var(--bad)' })}
        {!isDone && t.deployState === 'failed' && chip('✕ DEPLOY FAILED', { color: 'var(--bad)', border: '1px solid var(--bad)' })}
        <span style={{ marginLeft: 'auto', ...mono(500, 9), letterSpacing: '.06em', color: STATUS_COLOR[t.status], whiteSpace: 'nowrap', flex: 'none' }}>
          {(STATUS_LABEL[t.status] ?? t.status).toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.title}</div>
      {t.activePr ? (
        <a
          href={t.activePr.url}
          target="_blank"
          rel="noreferrer"
          title={`PR #${t.activePr.number}: ${t.activePr.title} — ${t.activePr.state}`}
          className="hv-border"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, border: '1px solid var(--line)', borderRadius: 2, padding: '3px 7px', background: 'var(--bg)', textDecoration: 'none' }}
        >
          <span style={{ ...mono(500, 8.5), flex: 'none', color: PR_STATE_COLOR[t.activePr.state], border: `1px solid ${PR_STATE_COLOR[t.activePr.state]}`, borderRadius: 2, padding: '0 4px', letterSpacing: '.06em' }}>
            PR {t.activePr.state.toUpperCase()}
          </span>
          <span style={{ ...mono(400, 9.5), color: 'var(--tx2)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>⎇ {t.activePr.branch || `#${t.activePr.number}`}</span>
        </a>
      ) : tags.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'nowrap', gap: 4, marginTop: 7, overflow: 'hidden' }}>
          {tags.slice(0, 3).map((tag) => (
            <span key={tag} style={{ ...mono(500, 9), color: 'var(--tx3)', border: '1px solid var(--line2)', borderRadius: 2, padding: '1px 5px', whiteSpace: 'nowrap' }}>
              {tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span title={tags.slice(3).join(', ')} style={{ ...mono(400, 9), color: 'var(--tx3)', padding: '1px 0' }}>
              +{tags.length - 3}
            </span>
          )}
        </div>
      ) : t.branch ? (
        <div title={t.branch} style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginTop: 7, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          ⎇ {t.branch}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 'auto' }}>
        <span
          className="hv-border"
          title={t.assignee === '—' ? 'Unassigned — click to assign' : runner !== null ? `${t.assignee} (${runnerBrand(runner).label} runner) — click to reassign` : `${t.assignee} — click to reassign`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onAssign(r.left, r.bottom + 4);
          }}
          style={{ width: 20, height: 20, flex: 'none', borderRadius: '50%', background: 'var(--bg3)', border: '1px solid var(--line2)', display: 'grid', placeItems: 'center', ...mono(500, 9), color: 'var(--tx2)', cursor: 'pointer' }}
        >
          {runner !== null ? runnerBrand(runner).mark(12) : initials(t.assignee)}
        </span>
        <span
          title={needsEstimate(t) ? 'No agent estimate yet — tagged needs-estimate-review for backfill' : undefined}
          style={{ ...mono(400, 10), color: needsEstimate(t) ? 'var(--warn)' : 'var(--tx3)' }}
        >
          {needsEstimate(t) ? 'NO EST' : t.estHours != null ? fmtDuration(t.estHours) : t.est}
        </span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)', marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>{t.sources[0]?.type ?? ''}</span>
        {lead && t.status === 'backlog' && !queued && !running && (
          <button
            className="hv-border"
            title="Deploy to agent queue"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDeploy();
            }}
            style={{ ...mono(500, 9), flex: 'none', border: '1px dashed var(--agent)', background: 'none', color: 'var(--agent)', borderRadius: 2, padding: '1px 5px', cursor: 'pointer' }}
          >
            ◇ QUEUE
          </button>
        )}
      </div>
    </div>
  );
}
