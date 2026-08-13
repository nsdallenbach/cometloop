import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import type { AgentsOverview, AgentsOverviewProject, ProjectAgent, ProjectAgentType } from '../types';
import { HEALTH_COLOR, mono } from '../util';
import { agentBrand, HARNESS_DEFAULT_PROVIDER, HARNESS_OPTIONS, PROVIDER_OPTIONS } from './AgentLogos';

/**
 * /agents — the agent architecture map. Every project renders as a central
 * hub node with its agents as spokes around it: real runner history (from the
 * work queue) and configured-but-not-yet-rolled-out agents from the deploy
 * flow. The diagram is read-only apart from the scaffolded "Deploy agent"
 * entry point on each project hub. Future node kinds (model serving
 * endpoints, AgentBricks, Foundry agents) render as a dashed placeholder
 * spoke until real data exists for them.
 */

// Cluster geometry: one fixed-size tile per project, spokes on an ellipse.
/**
 * Cluster geometry scales with spoke count — a fixed orbit crammed 10 nodes
 * of 124px into overlap. Crowded orbits (7+) also stagger alternate spokes
 * outward so neighbors clear each other.
 */
interface ClusterGeom {
  w: number;
  h: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  stagger: boolean;
}

function clusterGeometry(count: number): ClusterGeom {
  const rx = Math.max(150, 27 * count);
  const ry = Math.max(112, 20 * count);
  const stagger = count > 6;
  const pad = stagger ? 1.16 : 1;
  const w = 2 * (rx * pad + 80);
  const h = 2 * (ry * pad + 66);
  return { w, h, cx: w / 2, cy: h / 2, rx, ry, stagger };
}

const FUTURE_LABEL: Record<string, string> = {
  'serving-endpoint': 'SERVING ENDPOINT',
  agentbricks: 'AGENTBRICKS',
  foundry: 'FOUNDRY AGENT',
};

/** Spoke positions: first node at 12 o'clock, then evenly around the ellipse. */
function spokeXY(i: number, count: number, g: ClusterGeom): { x: number; y: number } {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
  const r = g.stagger && i % 2 === 1 ? 1.16 : 1;
  return { x: g.cx + g.rx * r * Math.cos(a), y: g.cy + g.ry * r * Math.sin(a) };
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** Ghost spoke advertising the future node kinds on every project cluster. */
function FutureSpoke({ x, y }: { x: number; y: number }) {
  return (
    <div
      title="Model serving endpoints, AgentBricks and Foundry agents created for this project will appear here — coming soon"
      style={{ position: 'absolute', left: x - 62, top: y - 30, width: 124, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: 0.75 }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          borderRadius: 9,
          border: '1px dashed var(--line2)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--tx3)',
          fontSize: 15,
        }}
      >
        ◇
      </div>
      <div style={{ ...mono(500, 8.5), color: 'var(--tx3)', letterSpacing: '.06em', textAlign: 'center' }}>
        ENDPOINTS · BRICKS · FOUNDRY
      </div>
      <div style={{ ...mono(400, 8), color: 'var(--tx3)', letterSpacing: '.08em' }}>COMING SOON</div>
    </div>
  );
}

function AgentSpoke({ agent, x, y, onSelect }: { agent: ProjectAgent; x: number; y: number; onSelect: (agent: ProjectAgent) => void }) {
  const brand = agentBrand(agent);
  const future = agent.agentType !== 'runner';
  // Table rows with live status (synced runners, READY serving endpoints)
  // are not "staged" — dashed treatment is only for rollout-pending configs.
  const staged = agent.source === 'configured' && !['active', 'idle'].includes(agent.status);
  const statusColor = agent.status === 'active' ? 'var(--ok)' : staged ? 'var(--warn)' : 'var(--tx3)';
  const sub = future
    ? (FUTURE_LABEL[agent.agentType] ?? agent.agentType.toUpperCase())
    : (brand?.label ?? agent.modelProvider ?? 'Runner');
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.05 }}
      transition={{ type: 'spring', visualDuration: 0.3, bounce: 0.25 }}
      title={`${agent.name} — click for details`}
      onClick={() => onSelect(agent)}
      style={{ position: 'absolute', left: x - 62, top: y - 30, width: 124, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer' }}
    >
      <div
        style={{
          position: 'relative',
          width: 38,
          height: 38,
          borderRadius: 9,
          background: 'var(--bg3)',
          border: staged ? '1px dashed var(--warn)' : '1px solid var(--line2)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {brand ? (
          brand.mark(22)
        ) : (
          <span style={{ ...mono(700, 15), color: 'var(--agent)' }}>{(agent.harness ?? agent.modelProvider ?? agent.name).charAt(0).toUpperCase()}</span>
        )}
        <span
          style={{
            position: 'absolute',
            right: -3,
            top: -3,
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: statusColor,
            border: '2px solid var(--bg)',
            animation: agent.status === 'active' ? 'eec-pulse 2.4s infinite' : undefined,
          }}
        />
      </div>
      <div
        style={{
          ...mono(500, 9),
          color: 'var(--tx)',
          letterSpacing: '.04em',
          maxWidth: 124,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {agent.name}
      </div>
      <div style={{ ...mono(400, 8), color: 'var(--tx3)', letterSpacing: '.08em', textTransform: 'uppercase' }}>
        {sub}
        {staged ? ' · STAGED' : ` · ${agent.status.toUpperCase()}`}
      </div>
    </motion.div>
  );
}

function ProjectCluster({
  project,
  agents,
  lead,
  onDeploy,
  onSelectAgent,
}: {
  project: AgentsOverviewProject;
  agents: ProjectAgent[];
  lead: boolean;
  onDeploy: () => void;
  onSelectAgent: (agent: ProjectAgent) => void;
}) {
  // Spokes: every agent plus one dashed placeholder for the future node kinds.
  const count = agents.length + 1;
  const geom = clusterGeometry(count);
  const spots = Array.from({ length: count }, (_, i) => spokeXY(i, count, geom));
  return (
    <div style={{ position: 'relative', width: geom.w, height: geom.h, flex: 'none' }}>
      <svg width={geom.w} height={geom.h} aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
        {spots.map((p, i) => {
          const agent = agents[i];
          const ghost = !agent;
          const staged = agent?.source === 'configured' && !['active', 'idle'].includes(agent?.status ?? '');
          const active = agent?.status === 'active';
          return (
            <line
              key={agent?.id ?? 'future'}
              x1={geom.cx}
              y1={geom.cy}
              x2={p.x}
              y2={p.y}
              stroke={active ? 'var(--agent)' : staged ? 'var(--warn)' : 'var(--line2)'}
              strokeWidth={active ? 1.6 : 1.1}
              strokeDasharray={ghost || staged ? '4 4' : undefined}
              opacity={ghost ? 0.55 : 0.9}
            />
          );
        })}
      </svg>
      {spots.map((p, i) =>
        agents[i] ? (
          <AgentSpoke key={agents[i].id} agent={agents[i]} x={p.x} y={p.y} onSelect={onSelectAgent} />
        ) : (
          <FutureSpoke key="future" x={p.x} y={p.y} />
        ),
      )}
      {/* Hub */}
      <div
        style={{
          position: 'absolute',
          left: geom.cx - 78,
          top: geom.cy - 44,
          width: 156,
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 6,
          padding: '10px 12px 9px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          boxShadow: '0 4px 18px rgba(0,0,0,.18)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: HEALTH_COLOR[project.health], flex: 'none' }} />
          <span style={{ ...mono(700, 11), letterSpacing: '.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {project.client}
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--tx2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</div>
        <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.08em' }}>
          {agents.length} AGENT{agents.length === 1 ? '' : 'S'}
          {agents.some((a) => a.status === 'active') ? ' · LIVE' : ''}
        </div>
        {lead && (
          <button
            className="hv-border"
            onClick={onDeploy}
            style={{
              ...mono(500, 9),
              marginTop: 3,
              background: 'none',
              border: '1px solid var(--agent)',
              color: 'var(--agent)',
              borderRadius: 3,
              padding: '4px 8px',
              cursor: 'pointer',
              letterSpacing: '.08em',
            }}
          >
            + DEPLOY AGENT
          </button>
        )}
      </div>
    </div>
  );
}

const FIELD: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--line2)',
  borderRadius: 3,
  color: 'var(--tx)',
  fontSize: 12,
  padding: '7px 9px',
};

const LABEL: React.CSSProperties = { ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 4 };

function DeployModal({
  project,
  onClose,
  onDeployed,
  toast,
}: {
  project: AgentsOverviewProject;
  onClose: () => void;
  onDeployed: () => void;
  toast: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [agentType, setAgentType] = useState<ProjectAgentType>('runner');
  const [harness, setHarness] = useState('claude-code');
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (!name.trim()) {
      toast('Give the agent a name');
      return;
    }
    if (!harness && !provider) {
      toast('Pick a harness or a model provider');
      return;
    }
    setBusy(true);
    api
      .deployAgent(project.id, {
        name: name.trim(),
        agentType,
        harness: harness || undefined,
        modelProvider: provider || undefined,
        model: model.trim() || undefined,
        notes: notes.trim() || undefined,
      })
      .then(() => {
        toast(`${name.trim()} configured for ${project.client} — rollout pending`);
        onDeployed();
      })
      .catch((e: Error) => {
        setBusy(false);
        toast(`Deploy failed — ${e.message}`);
      });
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 54 }} />
      <motion.div
        initial={{ opacity: 0, transform: 'translate(-50%, -46%) scale(0.97)' }}
        animate={{ opacity: 1, transform: 'translate(-50%, -50%) scale(1)' }}
        transition={{ type: 'spring', visualDuration: 0.25, bounce: 0.2 }}
        style={{
          position: 'fixed',
          left: '50%',
          top: '50%',
          width: 430,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 60px)',
          overflowY: 'auto',
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 6,
          padding: 18,
          zIndex: 55,
          boxShadow: '0 12px 40px rgba(0,0,0,.5)',
        }}
      >
        <div style={{ ...mono(500, 11), letterSpacing: '.1em', marginBottom: 2 }}>DEPLOY AGENT — {project.client.toUpperCase()}</div>
        <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 14 }}>
          Scaffolded flow: the configuration is saved and staged; actual rollout to a runner is a future feature.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={LABEL}>NAME</div>
            <input style={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. acme-runner-2" maxLength={80} autoFocus />
          </div>
          <div>
            <div style={LABEL}>TYPE</div>
            <select style={FIELD} value={agentType} onChange={(e) => setAgentType(e.target.value as ProjectAgentType)}>
              <option value="runner">Agent runner (harness)</option>
              <option value="serving-endpoint" disabled>
                Model serving endpoint — coming soon
              </option>
              <option value="agentbricks" disabled>
                AgentBricks — coming soon
              </option>
              <option value="foundry" disabled>
                Foundry agent — coming soon
              </option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={LABEL}>HARNESS</div>
              <select
                style={FIELD}
                value={harness}
                onChange={(e) => {
                  const h = e.target.value;
                  setHarness(h);
                  if (h) setProvider(HARNESS_DEFAULT_PROVIDER[h] ?? '');
                }}
              >
                {HARNESS_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
                <option value="">None — provider only</option>
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <div style={LABEL}>MODEL PROVIDER</div>
              <select style={FIELD} value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDER_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
                <option value="">Other / unset</option>
              </select>
            </div>
          </div>
          <div>
            <div style={LABEL}>MODEL (OPTIONAL)</div>
            <input style={FIELD} value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-sonnet-5" maxLength={80} />
          </div>
          <div>
            <div style={LABEL}>CONFIGURATION NOTES (OPTIONAL)</div>
            <textarea
              style={{ ...FIELD, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the rollout needs — repo scope, schedule, constraints…"
              maxLength={2000}
            />
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            className="hv-tx2"
            onClick={onClose}
            style={{ ...mono(500, 10), background: 'none', border: '1px solid var(--line2)', color: 'var(--tx3)', borderRadius: 3, padding: '6px 12px', cursor: 'pointer', letterSpacing: '.06em' }}
          >
            CANCEL
          </button>
          <button
            onClick={submit}
            disabled={busy}
            style={{
              ...mono(500, 10),
              background: 'var(--agent)',
              border: '1px solid var(--agent)',
              color: '#fff',
              borderRadius: 3,
              padding: '6px 14px',
              cursor: busy ? 'wait' : 'pointer',
              letterSpacing: '.06em',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? 'SAVING…' : 'STAGE DEPLOY'}
          </button>
        </div>
      </motion.div>
    </>
  );
}

/** Click-through detail for any node on the map (DAT-197 follow-up). */
function AgentDetailModal({ agent, projectName, onClose }: { agent: ProjectAgent; projectName: string; onClose: () => void }) {
  const brand = agentBrand(agent);
  const staged = agent.source === 'configured' && !['active', 'idle'].includes(agent.status);
  const statusColor = agent.status === 'active' ? 'var(--ok)' : staged ? 'var(--warn)' : 'var(--tx3)';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const rows: [string, string][] = [
    ['PROJECT', projectName],
    ['TYPE', agent.agentType === 'runner' ? 'Runner (devbox harness)' : (FUTURE_LABEL[agent.agentType] ?? agent.agentType)],
    ['HARNESS', brand?.label ?? agent.harness ?? '—'],
    ['MODEL PROVIDER', agent.modelProvider ?? '—'],
    ['MODEL', agent.model ?? '—'],
    ['SOURCE', agent.source === 'observed' ? 'Observed — real runner from task history' : staged ? 'Configured — rollout pending' : 'Stored record · live status synced'],
    ['TASKS WORKED', agent.source === 'observed' ? `${agent.tasks} total · ${agent.activeTasks} active now` : '—'],
    ['LAST SEEN', agent.lastSeen ? relTime(agent.lastSeen) : '—'],
    ['FIRST SEEN', agent.createdAt ? relTime(agent.createdAt) : '—'],
  ];
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 40 }}
      />
      <motion.div
        initial={{ opacity: 0, transform: 'translate(-50%,-50%) scale(0.97) translateY(6px)' }}
        animate={{ opacity: 1, transform: 'translate(-50%,-50%) scale(1) translateY(0px)' }}
        exit={{ opacity: 0, transform: 'translate(-50%,-50%) scale(0.98) translateY(4px)' }}
        transition={{ type: 'spring', visualDuration: 0.25, bounce: 0.15 }}
        role="dialog"
        aria-label={`Agent details: ${agent.name}`}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          width: 400,
          maxWidth: 'calc(100vw - 40px)',
          background: 'var(--bg2)',
          border: '1px solid var(--line)',
          borderRadius: 4,
          zIndex: 41,
          boxShadow: '0 12px 40px rgba(0,0,0,.45)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--line)' }}>
          <div
            style={{
              position: 'relative',
              width: 34,
              height: 34,
              borderRadius: 8,
              background: 'var(--bg3)',
              border: staged ? '1px dashed var(--warn)' : '1px solid var(--line2)',
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
            }}
          >
            {brand ? brand.mark(20) : <span style={{ ...mono(700, 14), color: 'var(--agent)' }}>{agent.name.charAt(0).toUpperCase()}</span>}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...mono(600, 12), letterSpacing: '.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, ...mono(400, 9), color: statusColor, letterSpacing: '.08em' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, animation: agent.status === 'active' ? 'eec-pulse 2.4s infinite' : undefined }} />
              {staged ? 'STAGED' : agent.status.toUpperCase()}
            </div>
          </div>
          <button
            className="hv-tx"
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 16, cursor: 'pointer', padding: '2px 6px' }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '12px 16px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <span style={{ ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.08em', width: 118, flex: 'none' }}>{label}</span>
              <span style={{ fontSize: 12.5, color: 'var(--tx)', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
            </div>
          ))}
        </div>
      </motion.div>
    </>
  );
}

export function AgentMap({ canLead, toast }: { canLead: (engagementId: string) => boolean; toast: (msg: string) => void }) {
  const [data, setData] = useState<AgentsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deployFor, setDeployFor] = useState<AgentsOverviewProject | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<ProjectAgent | null>(null);

  const load = useCallback(() => {
    return api
      .agentsOverview()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const byProject = useMemo(() => {
    const m = new Map<string, ProjectAgent[]>();
    for (const a of data?.agents ?? []) {
      const list = m.get(a.engagementId) ?? [];
      list.push(a);
      m.set(a.engagementId, list);
    }
    return m;
  }, [data]);

  const totals = useMemo(() => {
    const agents = data?.agents ?? [];
    return { agents: agents.length, live: agents.filter((a) => a.status === 'active').length };
  }, [data]);

  return (
    <div className="tab-pane" style={{ flex: 1, overflowY: 'auto', padding: '18px 22px 30px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ ...mono(700, 13), letterSpacing: '.12em' }}>AGENT MAP</span>
        {data && (
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
            {data.projects.length} PROJECT{data.projects.length === 1 ? '' : 'S'} · {totals.agents} AGENT{totals.agents === 1 ? '' : 'S'}
            {totals.live > 0 ? ` · ${totals.live} LIVE` : ''}
          </span>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
          Read-only architecture view — projects at the center, their agents as spokes.
        </span>
      </div>

      {/* Legend, including the not-yet-live node kinds. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '12px 0 6px' }}>
        {[
          { label: 'RUNNER — LIVE', dot: 'var(--ok)', dashed: false },
          { label: 'RUNNER — IDLE', dot: 'var(--tx3)', dashed: false },
          { label: 'CONFIGURED — ROLLOUT PENDING', dot: 'var(--warn)', dashed: true },
        ].map((l) => (
          <span
            key={l.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px ${l.dashed ? 'dashed' : 'solid'} var(--line2)`, borderRadius: 3, padding: '3px 8px', ...mono(400, 8.5), color: 'var(--tx2)', letterSpacing: '.07em' }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: l.dot }} />
            {l.label}
          </span>
        ))}
        <span
          title="Placeholder node types — created for projects in a future release"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px dashed var(--line2)', borderRadius: 3, padding: '3px 8px', ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.07em' }}
        >
          ◇ SERVING ENDPOINT · AGENTBRICKS · FOUNDRY — COMING SOON
        </span>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', marginTop: 10, border: '1px solid var(--bad)', borderRadius: 4, color: 'var(--bad)', ...mono(400, 10.5) }}>
          COULDN’T LOAD THE AGENT MAP: {error}
          <button
            onClick={() => void load()}
            style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '2px 9px', ...mono(500, 10), cursor: 'pointer', letterSpacing: '.06em' }}
          >
            RETRY
          </button>
        </div>
      )}

      {!data && !error && (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--tx3)', ...mono(400, 11), letterSpacing: '.08em' }}>LOADING…</div>
      )}

      {data && data.projects.length === 0 && (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--tx3)', ...mono(400, 11), letterSpacing: '.06em' }}>
          NO PROJECTS YET — CREATE AN ENGAGEMENT TO PUT AGENTS ON THE MAP
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        {data?.projects.map((p) => (
          <ProjectCluster
            key={p.id}
            project={p}
            agents={byProject.get(p.id) ?? []}
            lead={canLead(p.id)}
            onDeploy={() => setDeployFor(p)}
            onSelectAgent={setSelectedAgent}
          />
        ))}
      </div>

      <AnimatePresence>
        {selectedAgent && (
          <AgentDetailModal
            key={selectedAgent.id}
            agent={selectedAgent}
            projectName={data?.projects.find((p) => p.id === selectedAgent.engagementId)?.name ?? selectedAgent.engagementId}
            onClose={() => setSelectedAgent(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {deployFor && (
          <DeployModal
            key={deployFor.id}
            project={deployFor}
            toast={toast}
            onClose={() => setDeployFor(null)}
            onDeployed={() => {
              setDeployFor(null);
              void load();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
