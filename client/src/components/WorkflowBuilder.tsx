import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../api';
import { paths, type WorkflowTab } from '../routes';
import { mono } from '../util';
import { MapViewport } from './MapViewport';
import type { View } from '../lib/map-zoom';
import { orthoPath, routeLink, worldSize, type Box, type Point } from '../lib/canvas-layout';
import { CATALOG, TICKET_STATUSES, conditionOutcomes, nodeProblem, type CatalogEntry, type FieldDef, type NodeConfig, type TriggerDef } from '../../../shared/workflows/catalog';
import {
  addNode,
  autoLayout,
  configure,
  connect,
  KIND_META,
  NODE_H,
  NODE_W,
  relabel,
  removeEdge,
  removeNode,
  type NodeKind,
  type WfNode,
  type Workflow,
} from '../lib/workflow-graph';
import { Toggle } from './Workflows';
import { WorkflowRunsPanel } from './WorkflowRuns';

/**
 * The builder (DAT-284 / DAT-288): one workflow on the pan/zoom canvas —
 * triggers, agent steps, conditions and actions as nodes, connections
 * between them, loops refused — with an inspector that turns the selected
 * node's catalog entry into a form, the on/off switch, Run now, and a Runs
 * tab for this workflow's history. Edits autosave; a save over someone
 * else's newer version is refused and reloaded.
 */

const AUTOSAVE_MS = 700;
const GRID = 24;
const KINDS: NodeKind[] = ['trigger', 'condition', 'action', 'agent'];
const EMPTY: Workflow = { nodes: [], edges: [] };

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

const toolBtn: CSSProperties = { border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' };
const field: CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--line2)', background: 'var(--bg)', color: 'var(--tx)', borderRadius: 3, padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' };
const label: CSSProperties = { ...mono(500, 9.5), letterSpacing: '.08em', color: 'var(--tx3)', display: 'block', marginBottom: 4 };
const help: CSSProperties = { fontSize: 10.5, color: 'var(--tx3)', marginTop: 3, lineHeight: 1.4 };

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

function FieldInput({ def, value, onChange, engagements }: { def: FieldDef; value: string | number | undefined; onChange: (v: string | number) => void; engagements: { id: string; name: string }[] }) {
  const v = value === undefined ? '' : String(value);
  switch (def.type) {
    case 'textarea':
    case 'choices':
      return <textarea value={v} placeholder={def.placeholder} rows={def.type === 'choices' ? 4 : 3} onChange={(e) => onChange(e.target.value)} style={{ ...field, ...mono(400, 11), resize: 'vertical', lineHeight: 1.45 }} />;
    case 'number':
      return <input type="number" value={v} min={def.min} max={def.max} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} style={field} />;
    case 'select':
      return (
        <select value={v} onChange={(e) => onChange(e.target.value)} style={field}>
          {(def.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'status':
      return (
        <select value={v} onChange={(e) => onChange(e.target.value)} style={field}>
          <option value="">Any lane</option>
          {TICKET_STATUSES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'project':
      return (
        <select value={v} onChange={(e) => onChange(e.target.value)} style={field}>
          <option value="">Every project</option>
          {engagements.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.id})
            </option>
          ))}
          {v && !engagements.some((e) => e.id === v) && <option value={v}>{v}</option>}
        </select>
      );
    default:
      return <input value={v} placeholder={def.placeholder} onChange={(e) => onChange(e.target.value)} style={field} />;
  }
}

function Inspector({
  node,
  wf,
  providers,
  engagements,
  onChange,
  onRelabel,
  onRemoveEdge,
  onRemove,
}: {
  node: WfNode;
  wf: Workflow;
  providers: { jev: boolean; databricks: boolean } | null;
  engagements: { id: string; name: string }[];
  onChange: (patch: { type?: string; config?: NodeConfig; title?: string }) => void;
  onRelabel: (to: string, label: string) => void;
  onRemoveEdge: (to: string) => void;
  onRemove: () => void;
}) {
  const meta = KIND_META[node.kind];
  const entries: CatalogEntry[] = CATALOG[node.kind];
  const entry = entries.find((e) => e.id === node.type);
  const problem = nodeProblem(node.kind, node.type, node.config);
  const outgoing = wf.edges.filter((e) => e.from === node.id);
  const outcomes = node.kind === 'condition' ? conditionOutcomes(node.type, node.config) : [];
  const payload = node.kind === 'trigger' ? ((entry as TriggerDef | undefined)?.payload ?? []) : [];
  const availablePayload = useMemo(() => {
    // What a downstream node can reference: the union of every trigger's payload paths.
    const all = new Set<string>(['workflow.name']);
    for (const t of wf.nodes.filter((n) => n.kind === 'trigger')) for (const p of (CATALOG.trigger.find((e) => e.id === t.type) as TriggerDef | undefined)?.payload ?? []) all.add(p);
    return [...all];
  }, [wf.nodes]);

  return (
    <div style={{ width: 320, flex: 'none', borderLeft: '1px solid var(--line)', background: 'var(--bg2)', overflowY: 'auto', padding: '14px 16px 24px', display: 'grid', gap: 14, alignContent: 'start' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...mono(500, 9.5), letterSpacing: '.09em', color: meta.color }}>
          {meta.glyph} {meta.label}
        </span>
        <div style={{ flex: 1 }} />
        <button className="hv-bad" onClick={onRemove} title="Remove this node (Del)" style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(500, 10), cursor: 'pointer', padding: 0 }}>
          REMOVE
        </button>
      </div>
      <div>
        <span style={label}>WHAT</span>
        <select value={node.type} onChange={(e) => onChange({ type: e.target.value })} style={field}>
          {entries.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
        {entry && <div style={help}>{entry.blurb}</div>}
      </div>
      <div>
        <span style={label}>TITLE ON THE CARD</span>
        <input value={node.title} maxLength={120} onChange={(e) => onChange({ title: e.target.value })} style={field} />
      </div>
      {(entry?.fields ?? []).map((f) => (
        <div key={f.key}>
          <span style={label}>{f.label.toUpperCase()}</span>
          <FieldInput def={f} value={node.config[f.key]} engagements={engagements} onChange={(v) => onChange({ config: { ...node.config, [f.key]: v } })} />
          {f.help && <div style={help}>{f.help}</div>}
          {f.key === 'provider' && providers && (
            <div style={help}>
              Reachable here: {providers.jev ? 'Jev' : 'no Jev key'} · {providers.databricks ? 'Databricks ai_decide' : 'no Databricks warehouse'} · the configured model.
            </div>
          )}
        </div>
      ))}
      {problem && <div style={{ fontSize: 11.5, color: 'var(--warn)', lineHeight: 1.4, border: '1px dashed var(--warn)', borderRadius: 3, padding: '6px 8px' }}>{problem}</div>}
      {node.kind === 'condition' && (
        <div>
          <span style={label}>CONNECTIONS OUT · WHICH OUTCOME EACH WAITS FOR</span>
          {outgoing.length === 0 && <div style={help}>Connect this condition to the nodes that should run on each outcome ({outcomes.join(' / ') || 'add choices first'}).</div>}
          <div style={{ display: 'grid', gap: 6 }}>
            {outgoing.map((e) => {
              const target = wf.nodes.find((n) => n.id === e.to);
              return (
                <div key={e.to} style={{ display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {target?.title ?? e.to}</span>
                  <select value={e.label ?? ''} onChange={(ev) => onRelabel(e.to, ev.target.value)} style={{ ...field, padding: '4px 6px' }}>
                    <option value="">always</option>
                    {outcomes.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                    {e.label && !outcomes.some((o) => o.toLowerCase() === e.label?.toLowerCase()) && <option value={e.label}>{e.label} (not an outcome)</option>}
                  </select>
                  <button className="hv-bad" onClick={() => onRemoveEdge(e.to)} title="Disconnect" style={{ border: 'none', background: 'none', color: 'var(--tx3)', cursor: 'pointer', padding: 0, fontSize: 12 }}>
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {node.kind !== 'condition' && outgoing.length > 0 && (
        <div>
          <span style={label}>CONNECTIONS OUT</span>
          <div style={{ display: 'grid', gap: 4 }}>
            {outgoing.map((e) => (
              <div key={e.to} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {wf.nodes.find((n) => n.id === e.to)?.title ?? e.to}</span>
                <button className="hv-bad" onClick={() => onRemoveEdge(e.to)} title="Disconnect" style={{ border: 'none', background: 'none', color: 'var(--tx3)', cursor: 'pointer', padding: 0, fontSize: 12 }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {(payload.length > 0 || node.kind !== 'trigger') && (
        <div>
          <span style={label}>{node.kind === 'trigger' ? 'THIS EVENT CARRIES' : 'FIELDS YOU CAN USE AS {{…}}'}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {(node.kind === 'trigger' ? payload : availablePayload).map((p) => (
              <code key={p} style={{ ...mono(400, 10), color: 'var(--tx2)', border: '1px solid var(--line)', borderRadius: 2, padding: '1px 5px', background: 'var(--bg)' }}>
                {p}
              </code>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function WorkflowBuilder({
  id,
  tab,
  toast,
  navigate,
  engagements,
  canLead,
}: {
  id: number;
  tab: WorkflowTab;
  toast: (msg: string) => void;
  navigate: (path: string) => void;
  engagements: { id: string; name: string }[];
  canLead: boolean;
}) {
  const [current, setCurrent] = useState<{ id: number; updatedAt: string; enabled: boolean } | null>(null);
  const [name, setName] = useState('');
  const [wf, setWfRaw] = useState<Workflow>(EMPTY);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveTick, setSaveTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [providers, setProviders] = useState<{ jev: boolean; databricks: boolean } | null>(null);
  const [runTicket, setRunTicket] = useState('');
  const [running, setRunning] = useState(false);
  const [runsKey, setRunsKey] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const suppressClick = useRef(false);

  // What the next save sends — refs, so the debounced save never reads a stale render.
  const latest = useRef({ wf, name, current });
  useEffect(() => {
    latest.current = { wf, name, current };
  });
  const inFlight = useRef(false);

  /** Every user edit goes through here (or `rename`), so it is marked for autosave. */
  const setWf = useCallback((next: Workflow | ((w: Workflow) => Workflow)) => {
    setWfRaw(next);
    setSaveState('dirty');
  }, []);
  const rename = (v: string) => {
    setName(v);
    setSaveState('dirty');
  };

  const show = useCallback((w: { id: number; name: string; graph: Workflow; updatedAt: string; enabled: boolean }) => {
    setCurrent({ id: w.id, updatedAt: w.updatedAt, enabled: w.enabled });
    setName(w.name);
    setWfRaw(w.graph);
    setSaveState('saved');
    setConnectFrom(null);
    setConfirmDelete(false);
  }, []);

  const open = useCallback(
    () =>
      api
        .workflow(id)
        .then((w) => {
          show(w);
          setLoadError(null);
        })
        .catch((e: Error) => setLoadError(e.message)),
    [id, show],
  );

  useEffect(() => {
    void open();
  }, [open]);
  useEffect(() => {
    api
      .workflowProviders()
      .then(setProviders)
      .catch(() => setProviders(null));
  }, []);

  // Autosave, a moment after the last edit. One save at a time: a save names
  // the version it was based on, so a second one fired before the first lands
  // would conflict with ourselves.
  useEffect(() => {
    if (saveState !== 'dirty' || inFlight.current) return;
    const timer = setTimeout(() => {
      const { wf: graph, name: title, current: cur } = latest.current;
      if (!cur || !title.trim()) return;
      inFlight.current = true;
      setSaveState('saving');
      api
        .saveWorkflow(cur.id, { name: title.trim(), graph, baseUpdatedAt: cur.updatedAt })
        .then((w) => {
          setCurrent({ id: w.id, updatedAt: w.updatedAt, enabled: w.enabled });
          // Edits made while the save was in flight flipped the state back to dirty; leave that.
          setSaveState((st) => (st === 'saving' ? 'saved' : st));
        })
        .catch((e: Error) => {
          if (e instanceof ApiError && e.status === 409) {
            toast(e.message);
            void open();
          } else {
            setSaveState('error');
            toast(`Save failed — ${e.message}`);
          }
        })
        .finally(() => {
          inFlight.current = false;
          setSaveTick((t) => t + 1);
        });
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [saveState, saveTick, open, toast]);

  const setEnabled = (enabled: boolean) => {
    const cur = current;
    if (!cur) return;
    // Flush the draft with the switch, so what turns on is what is on screen.
    api
      .saveWorkflow(cur.id, { name: name.trim() || undefined, graph: wf, enabled, baseUpdatedAt: cur.updatedAt })
      .then((w) => {
        setCurrent({ id: w.id, updatedAt: w.updatedAt, enabled: w.enabled });
        setSaveState('saved');
        toast(enabled ? `“${w.name}” is on — its triggers are live` : `“${w.name}” is off`);
      })
      .catch((e: Error) => {
        if (e instanceof ApiError && e.status === 409) {
          toast(e.message);
          void open();
        } else toast(e instanceof ApiError && e.status === 403 ? 'Only leads and admins switch workflows on' : e.message);
      });
  };

  const runNow = () => {
    if (!current) return;
    setRunning(true);
    api
      .runWorkflow(current.id, runTicket.trim() || undefined)
      .then((r) => {
        toast(r.state === 'succeeded' ? `Ran ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}` : `Run failed — ${r.error}`);
        setRunsKey((k) => k + 1);
        if (tab !== 'runs') navigate(paths.workflow(id, 'runs'));
      })
      .catch((e: Error) => toast(`Couldn’t run — ${e.message}`))
      .finally(() => setRunning(false));
  };

  const removeCurrent = () => {
    const cur = current;
    if (!cur) return;
    api
      .deleteWorkflow(cur.id)
      .then(() => {
        toast(`Deleted “${name}”`);
        navigate(paths.workflows);
      })
      .catch((e: Error) => toast(`Delete failed — ${e.message}`));
  };

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
  }, [selected, setWf]);

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
    let idn = `${kind}-${i}`;
    while (wf.nodes.some((n) => n.id === idn)) idn = `${kind}-${++i}`;
    setWf((w) => addNode(w, kind, idn));
    setSelected(idn);
    setAddOpen(false);
  };

  const selectedNode = selected ? (wf.nodes.find((n) => n.id === selected) ?? null) : null;
  const problems = wf.nodes.map((n) => nodeProblem(n.kind, n.type, n.config)).filter(Boolean).length;
  const enabled = current?.enabled ?? false;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '16px 22px 0', flexWrap: 'wrap' }}>
        <button onClick={() => navigate(paths.workflows)} style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(500, 10.5), letterSpacing: '.06em', cursor: 'pointer', padding: 0 }}>
          ← WORKFLOWS
        </button>
        <input
          value={name}
          onChange={(e) => rename(e.target.value)}
          placeholder="Name this workflow"
          aria-label="Workflow name"
          maxLength={80}
          style={{ flex: '0 1 320px', minWidth: 180, border: '1px solid transparent', background: 'transparent', color: 'var(--tx)', borderRadius: 3, padding: '4px 6px', fontSize: 18, fontWeight: 600, letterSpacing: '-.01em' }}
        />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <Toggle on={enabled} onChange={setEnabled} title={canLead ? (enabled ? 'Switch off' : 'Switch on') : 'Leads and admins switch workflows on'} />
          <span style={{ ...mono(500, 10), letterSpacing: '.08em', color: enabled ? 'var(--ok)' : 'var(--tx3)' }}>{enabled ? 'ON' : 'OFF'}</span>
        </span>
        <div style={{ flex: 1 }} />
        <span
          title={saveState === 'error' ? 'The last save failed; the next edit tries again' : 'Workflows are shared: everyone sees what you save'}
          style={{ ...mono(400, 10), letterSpacing: '.06em', color: saveState === 'error' ? 'var(--bad)' : saveState === 'saved' ? 'var(--ok)' : 'var(--tx3)' }}
        >
          {saveState === 'saved' ? '✓ SAVED FOR EVERYONE' : saveState === 'error' ? '✕ NOT SAVED' : 'SAVING…'}
        </span>
        <input value={runTicket} onChange={(e) => setRunTicket(e.target.value)} placeholder="ticket key (optional)" aria-label="Ticket to run on" style={{ ...field, width: 150, ...mono(400, 11) }} />
        <button className="hv-border" disabled={running || !current || !canLead} onClick={runNow} title={canLead ? 'Run from the manual (or first) trigger now' : 'Leads and admins run workflows'} style={toolBtn}>
          {running ? 'Running…' : '▶ Run now'}
        </button>
        <button
          className="hv-bad"
          onClick={() => (confirmDelete ? removeCurrent() : setConfirmDelete(true))}
          onBlur={() => setConfirmDelete(false)}
          disabled={!current}
          style={{ ...toolBtn, color: confirmDelete ? 'var(--bad)' : 'var(--tx3)', borderColor: confirmDelete ? 'var(--bad)' : 'var(--line2)' }}
        >
          {confirmDelete ? 'Delete for everyone?' : 'Delete'}
        </button>
      </div>

      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2, padding: '10px 22px 0', borderBottom: '1px solid var(--line)', margin: '0 0 0' }}>
        {(['build', 'runs'] as WorkflowTab[]).map((t) => (
          <button
            key={t}
            onClick={() => navigate(paths.workflow(id, t))}
            style={{ border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--acc)' : 'transparent'}`, background: 'none', color: tab === t ? 'var(--tx)' : 'var(--tx2)', ...mono(500, 10.5), letterSpacing: '.08em', padding: '6px 10px', cursor: 'pointer' }}
          >
            {t === 'build' ? 'BUILD' : 'RUNS'}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ ...mono(400, 10), color: problems ? 'var(--warn)' : 'var(--tx3)', letterSpacing: '.06em', paddingBottom: 6 }}>
          {wf.nodes.length} NODES · {wf.edges.length} CONNECTIONS{problems ? ` · ${problems} TO FINISH` : ''}
        </span>
        {loadError && <span style={{ ...mono(400, 10), color: 'var(--bad)', paddingBottom: 6, marginLeft: 12 }}>COULDN’T LOAD: {loadError}</span>}
      </div>

      {tab === 'runs' ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 22px 28px' }}>
          <WorkflowRunsPanel workflowId={id} limit={100} toast={toast} refreshKey={runsKey} title="Runs of this workflow" />
        </div>
      ) : (
        <>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 22px', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative' }}>
              <button className="hv-border" onClick={() => setAddOpen((v) => !v)} style={{ ...toolBtn, borderColor: addOpen ? 'var(--tx3)' : 'var(--line2)', background: addOpen ? 'var(--bg3)' : 'none' }}>
                + Add node
              </button>
              {addOpen && (
                <>
                  <div onClick={() => setAddOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 41, width: 320, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, background: 'var(--bg2)', border: '1px solid var(--line2)', borderRadius: 4, boxShadow: '0 14px 32px rgba(0,0,0,.45)', padding: 8 }}>
                    {KINDS.map((k) => (
                      <button key={k} className="hv-border-bg" onClick={() => add(k)} style={{ display: 'block', textAlign: 'left', border: '1px solid var(--line)', background: 'var(--bg)', borderRadius: 3, padding: '8px 9px', cursor: 'pointer', color: 'var(--tx)' }}>
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
            <div style={{ flex: 1 }} />
            <span style={{ ...mono(400, 10), color: connectFrom ? 'var(--agent)' : 'var(--tx3)', letterSpacing: '.06em' }}>
              {connectFrom ? 'CLICK THE NODE TO CONNECT TO · ESC TO CANCEL' : 'DRAG TO MOVE · CLICK TO EDIT · ● TO CONNECT · DEL TO REMOVE'}
            </span>
          </div>

          <div style={{ flex: 1, minHeight: 0, display: 'flex', margin: '0 22px 16px', border: '1px solid var(--line)', borderRadius: 5, overflow: 'hidden' }}>
            <div
              ref={hostRef}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                position: 'relative',
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
                      style={{ position: 'absolute', left: e.mid[0], top: e.mid[1], transform: 'translate(-50%,-50%)', ...mono(500, 8.5), letterSpacing: '.07em', color: 'var(--tx2)', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 2, padding: '1px 6px', whiteSpace: 'nowrap', pointerEvents: 'none' }}
                    >
                      {e.label?.toUpperCase()}
                    </div>
                  ))}

                {wf.nodes.map((n) => {
                  const meta = KIND_META[n.kind];
                  const isSel = selected === n.id;
                  const isSource = connectFrom === n.id;
                  const incomplete = nodeProblem(n.kind, n.type, n.config) !== null;
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
                        border: `1px solid ${isSel || isSource ? meta.color : incomplete ? 'var(--warn)' : 'var(--line2)'}`,
                        borderStyle: incomplete && !isSel ? 'dashed' : 'solid',
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
                        {incomplete && <span style={{ ...mono(500, 8.5), color: 'var(--warn)', letterSpacing: '.06em' }}>· FINISH</span>}
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
                      <button
                        aria-label={`Connect from ${n.title}`}
                        title="Connect to another node"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConnectFrom((c) => (c === n.id ? null : n.id));
                        }}
                        style={{ position: 'absolute', right: -7, top: NODE_H / 2 - 7, width: 14, height: 14, borderRadius: '50%', border: `1px solid ${isSource ? 'var(--agent)' : 'var(--line2)'}`, background: isSource ? 'var(--agent)' : 'var(--bg)', cursor: 'pointer', padding: 0 }}
                      />
                      {n.kind !== 'trigger' && <span style={{ position: 'absolute', left: -5, top: NODE_H / 2 - 5, width: 8, height: 8, borderRadius: '50%', border: '1px solid var(--line2)', background: 'var(--bg)' }} />}
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

            {selectedNode ? (
              <Inspector
                node={selectedNode}
                wf={wf}
                providers={providers}
                engagements={engagements}
                onChange={(patch) => setWf((w) => configure(w, selectedNode.id, patch))}
                onRelabel={(to, lbl) => setWf((w) => relabel(w, selectedNode.id, to, lbl))}
                onRemoveEdge={(to) => setWf((w) => removeEdge(w, selectedNode.id, to))}
                onRemove={() => {
                  setWf((w) => removeNode(w, selectedNode.id));
                  setSelected(null);
                }}
              />
            ) : (
              <div style={{ width: 320, flex: 'none', borderLeft: '1px solid var(--line)', background: 'var(--bg2)', padding: '14px 16px', color: 'var(--tx3)', fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ ...mono(500, 9.5), letterSpacing: '.08em', marginBottom: 8 }}>INSPECTOR</div>
                Click a node to choose what it does and fill in its fields. Connect nodes with the ● on their right edge; out of a condition, pick which outcome each connection waits for.
                {!enabled && <div style={{ marginTop: 10, color: 'var(--tx2)' }}>This workflow is off: nothing fires until a lead switches it on.</div>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
