import { useEffect, useMemo, useRef, useState } from 'react';
import { mono } from '../util';
import { MapViewport } from './MapViewport';
import type { View } from '../lib/map-zoom';
import { orthoPath, routeLink, worldSize, type Box, type Point } from '../lib/canvas-layout';
import {
  addNode,
  autoLayout,
  connect,
  KIND_META,
  NODE_H,
  NODE_W,
  parseWorkflow,
  removeNode,
  sampleWorkflow,
  type NodeKind,
  type WfNode,
  type Workflow,
} from '../lib/workflow-graph';

/**
 * Workflows (DAT-284): a placeholder builder for n8n-style automations drawn
 * as a DAG — triggers, agent steps, conditions and actions on the pan/zoom
 * canvas first built for the ticket board. You can move nodes, add and remove
 * them, connect them (loops refused) and auto-layout the graph. Nothing
 * executes yet and the draft lives in this browser only; the page says so.
 */

const STORAGE_KEY = 'eec-workflow-draft';
const GRID = 24;
const KINDS: NodeKind[] = ['trigger', 'agent', 'condition', 'action'];

const loadDraft = (): Workflow => {
  try {
    return parseWorkflow(localStorage.getItem(STORAGE_KEY)) ?? sampleWorkflow();
  } catch {
    return sampleWorkflow();
  }
};

/** Midpoint along a polyline, for an edge label. */
function routeMid(pts: Point[]): Point {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (walked + seg >= total / 2 && seg > 0) {
      const t = (total / 2 - walked) / seg;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    walked += seg;
  }
  return pts[0];
}

export function Workflows({ toast }: { toast: (msg: string) => void }) {
  const [wf, setWf] = useState<Workflow>(loadDraft);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const suppressClick = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wf));
    } catch {
      /* storage unavailable: the draft lasts as long as the page */
    }
  }, [wf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input,textarea,select');
      if (e.key === 'Escape') {
        setConnectFrom(null);
        setAddOpen(false);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !typing) {
        setWf((w) => removeNode(w, selected));
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const boxes = useMemo(() => new Map<string, Box>(wf.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: NODE_W, h: NODE_H }])), [wf.nodes]);
  const world = useMemo(() => {
    const w = worldSize([...boxes.values()], 120);
    return { w: Math.max(w.w, 1200), h: Math.max(w.h, 700) };
  }, [boxes]);
  const edges = useMemo(() => {
    const obstacles = [...boxes.values()];
    return wf.edges.flatMap((e) => {
      const a = boxes.get(e.from);
      const b = boxes.get(e.to);
      if (!a || !b) return [];
      const route = routeLink(a, b, obstacles);
      return [{ ...e, d: orthoPath(route), mid: routeMid(route) }];
    });
  }, [boxes, wf.edges]);

  const beginDrag = (e: React.PointerEvent, n: WfNode) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    e.stopPropagation(); // the viewport must not pan
    const start = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y };
    let started = false;
    let frame = 0;
    let next = { x: n.x, y: n.y };
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        started = true;
        suppressClick.current = true;
        document.body.style.userSelect = 'none';
      }
      const scale = viewRef.current.scale;
      // Snap to the half grid so nodes line up without fuss.
      const snap = (v: number) => Math.max(0, Math.round(v / (GRID / 2)) * (GRID / 2));
      next = { x: snap(start.nx + (ev.clientX - start.x) / scale), y: snap(start.ny + (ev.clientY - start.y) / scale) };
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setWf((w) => ({ ...w, nodes: w.nodes.map((x) => (x.id === n.id ? { ...x, ...next } : x)) }));
        });
      }
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.userSelect = '';
      if (frame !== 0) cancelAnimationFrame(frame);
      if (!started) return;
      setWf((w) => ({ ...w, nodes: w.nodes.map((x) => (x.id === n.id ? { ...x, ...next } : x)) }));
      setTimeout(() => (suppressClick.current = false), 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const clickNode = (n: WfNode) => {
    if (suppressClick.current) return;
    if (connectFrom && connectFrom !== n.id) {
      const r = connect(wf, connectFrom, n.id);
      if (r.error) toast(r.error);
      else setWf(r.wf);
      setConnectFrom(null);
      return;
    }
    setSelected((s) => (s === n.id ? null : n.id));
  };

  const add = (kind: NodeKind) => {
    let i = wf.nodes.length + 1;
    let id = `${kind}-${i}`;
    while (wf.nodes.some((n) => n.id === id)) id = `${kind}-${++i}`;
    setWf((w) => addNode(w, kind, id));
    setSelected(id);
    setAddOpen(false);
  };

  const toolBtn: React.CSSProperties = {
    border: '1px solid var(--line2)',
    background: 'none',
    color: 'var(--tx)',
    borderRadius: 3,
    padding: '5px 12px',
    fontSize: 11.5,
    fontWeight: 600,
    cursor: 'pointer',
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'baseline', gap: 14, padding: '20px 22px 0' }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Workflows</h1>
        <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>
          {wf.nodes.length} NODES · {wf.edges.length} CONNECTIONS
        </span>
        <span style={{ ...mono(500, 9.5), color: 'var(--warn)', border: '1px dashed var(--warn)', borderRadius: 2, padding: '2px 7px', letterSpacing: '.06em' }}>
          PLACEHOLDER — NOTHING RUNS YET · DRAFT SAVED IN THIS BROWSER
        </span>
      </div>

      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '12px 22px 10px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative' }}>
          <button className="hv-border" onClick={() => setAddOpen((v) => !v)} style={{ ...toolBtn, borderColor: addOpen ? 'var(--tx3)' : 'var(--line2)', background: addOpen ? 'var(--bg3)' : 'none' }}>
            + Add node
          </button>
          {addOpen && (
            <>
              <div onClick={() => setAddOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 'calc(100% + 6px)',
                  zIndex: 41,
                  width: 300,
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 6,
                  background: 'var(--bg2)',
                  border: '1px solid var(--line2)',
                  borderRadius: 4,
                  boxShadow: '0 14px 32px rgba(0,0,0,.45)',
                  padding: 8,
                }}
              >
                {KINDS.map((k) => (
                  <button
                    key={k}
                    className="hv-border-bg"
                    onClick={() => add(k)}
                    style={{ display: 'block', textAlign: 'left', border: '1px solid var(--line)', background: 'var(--bg)', borderRadius: 3, padding: '8px 9px', cursor: 'pointer', color: 'var(--tx)' }}
                  >
                    <div style={{ ...mono(500, 10), letterSpacing: '.08em', color: KIND_META[k].color, marginBottom: 4 }}>
                      {KIND_META[k].glyph} {KIND_META[k].label}
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.35, color: 'var(--tx2)' }}>{KIND_META[k].blurb}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <button
          className="hv-border"
          onClick={() => {
            setWf((w) => autoLayout(w));
            toast('Laid out left to right by what feeds what');
          }}
          style={toolBtn}
        >
          Auto-layout
        </button>
        <button
          className="hv-border"
          onClick={() => {
            setWf(sampleWorkflow());
            setSelected(null);
            setConnectFrom(null);
            toast('Back to the sample workflow');
          }}
          style={{ ...toolBtn, color: 'var(--tx2)' }}
        >
          Reset sample
        </button>
        <div style={{ flex: 1 }} />
        <span style={{ ...mono(400, 10), color: connectFrom ? 'var(--agent)' : 'var(--tx3)', letterSpacing: '.06em' }}>
          {connectFrom ? 'CLICK THE NODE TO CONNECT TO · ESC TO CANCEL' : 'DRAG TO MOVE · CLICK TO SELECT · ● TO CONNECT · DEL TO REMOVE'}
        </span>
      </div>

      <div
        ref={hostRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          position: 'relative',
          margin: '0 22px 16px',
          border: '1px solid var(--line)',
          borderRadius: 5,
          overflow: 'hidden',
          backgroundColor: 'var(--bg)',
          backgroundImage: 'radial-gradient(var(--line) 1px, transparent 1px)',
          backgroundSize: `${GRID}px ${GRID}px`,
          backgroundPosition: `${GRID / 2}px ${GRID / 2}px`,
        }}
      >
        <MapViewport
          ariaLabel="Workflow canvas — scroll or pinch to zoom, drag to pan, 0 to reset"
          hint={null}
          frameless
          controls="bottom-right"
          background="transparent"
          contentSize={world}
          minHeight={0}
          onViewChange={(v) => {
            viewRef.current = v;
          }}
          onTransform={(tx, ty, s) => {
            const el = hostRef.current;
            if (!el) return;
            const size = GRID * s;
            el.style.backgroundSize = `${size}px ${size}px`;
            el.style.backgroundPosition = `${tx + size / 2}px ${ty + size / 2}px`;
          }}
        >
          <svg width={world.w} height={world.h} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }} aria-hidden="true">
            <defs>
              <marker id="eec-wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--tx3)" />
              </marker>
            </defs>
            {edges.map((e) => (
              <g key={`${e.from}>${e.to}`}>
                <path d={e.d} fill="none" stroke="var(--tx3)" strokeWidth={1.4} markerEnd="url(#eec-wf-arrow)" opacity={0.9} />
                <path className="eec-flow" d={e.d} fill="none" stroke="var(--agent)" strokeWidth={1.4} opacity={selected === e.from ? 0.9 : 0} strokeDasharray="3 14" strokeLinecap="round" />
              </g>
            ))}
          </svg>

          {edges
            .filter((e) => e.label)
            .map((e) => (
              <div
                key={`label-${e.from}>${e.to}`}
                style={{
                  position: 'absolute',
                  left: e.mid[0],
                  top: e.mid[1],
                  transform: 'translate(-50%,-50%)',
                  ...mono(500, 8.5),
                  letterSpacing: '.07em',
                  color: 'var(--tx2)',
                  background: 'var(--bg)',
                  border: '1px solid var(--line2)',
                  borderRadius: 2,
                  padding: '1px 6px',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none',
                }}
              >
                {e.label?.toUpperCase()}
              </div>
            ))}

          {wf.nodes.map((n) => {
            const meta = KIND_META[n.kind];
            const isSel = selected === n.id;
            const isSource = connectFrom === n.id;
            return (
              <div
                key={n.id}
                onPointerDown={(e) => beginDrag(e, n)}
                onClick={() => clickNode(n)}
                className="hv-border"
                style={{
                  position: 'absolute',
                  left: n.x,
                  top: n.y,
                  width: NODE_W,
                  height: NODE_H,
                  boxSizing: 'border-box',
                  display: 'flex',
                  flexDirection: 'column',
                  border: `1px solid ${isSel || isSource ? meta.color : 'var(--line2)'}`,
                  boxShadow: isSel ? `0 0 0 2px var(--agentsoft)` : undefined,
                  background: 'var(--bg2)',
                  borderRadius: 4,
                  padding: '8px 11px',
                  cursor: connectFrom && !isSource ? 'crosshair' : 'grab',
                  userSelect: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                  <span style={{ ...mono(500, 9.5), letterSpacing: '.09em', color: meta.color }}>
                    {meta.glyph} {meta.label}
                  </span>
                  {isSel && (
                    <button
                      className="hv-bad"
                      aria-label={`Remove ${n.title}`}
                      title="Remove (Del)"
                      onClick={(e) => {
                        e.stopPropagation();
                        setWf((w) => removeNode(w, n.id));
                        setSelected(null);
                      }}
                      style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 11), cursor: 'pointer', padding: 0 }}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</div>
                <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginTop: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.detail}</div>
                {/* out-port: start a connection from here */}
                <button
                  aria-label={`Connect from ${n.title}`}
                  title="Connect to another node"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConnectFrom((c) => (c === n.id ? null : n.id));
                  }}
                  style={{
                    position: 'absolute',
                    right: -7,
                    top: NODE_H / 2 - 7,
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    border: `1px solid ${isSource ? 'var(--agent)' : 'var(--line2)'}`,
                    background: isSource ? 'var(--agent)' : 'var(--bg)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
                {n.kind !== 'trigger' && (
                  <span style={{ position: 'absolute', left: -5, top: NODE_H / 2 - 5, width: 8, height: 8, borderRadius: '50%', border: '1px solid var(--line2)', background: 'var(--bg)' }} />
                )}
              </div>
            );
          })}
        </MapViewport>

        <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6, pointerEvents: 'none' }}>
          {KINDS.map((k) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--line2)', borderRadius: 3, padding: '3px 8px', ...mono(400, 8.5), color: 'var(--tx2)', letterSpacing: '.07em', background: 'var(--bg)' }}>
              <span style={{ color: KIND_META[k].color }}>{KIND_META[k].glyph}</span>
              {KIND_META[k].label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
