import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import type { AgentsOverview, AgentsOverviewProject, ProjectAgent, ProjectAgentRole, ProjectAgentType } from '../types';
import { HEALTH_COLOR, mono } from '../util';
import { agentBrand, HARNESS_DEFAULT_PROVIDER, HARNESS_OPTIONS, PROVIDER_OPTIONS } from './AgentLogos';

/**
 * /agents — the agent architecture map. Every project renders as a central hub
 * node with its agents as spokes around it: observed runners (from the work
 * queue), endpoint-backed agents built in AgentBricks or Model Serving and
 * registered here, and staged runner configs awaiting fleet rollout.
 *
 * "New agent" on a hub registers an agent against that project. Endpoint-backed
 * agents are live records — their status comes from the workspace serving API
 * — and an agent given the pr-reviewer role is what the PR review gate invokes.
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

const TYPE_LABEL: Record<string, string> = {
  runner: 'RUNNER',
  'serving-endpoint': 'SERVING ENDPOINT',
  agentbricks: 'AGENT BRICKS',
  foundry: 'FOUNDRY AGENT',
};

const ROLE_LABEL: Record<string, string> = {
  delivery: 'DELIVERY',
  'pr-reviewer': 'PR REVIEWER',
  planning: 'PLANNING',
  other: 'AGENT',
};

/** The console's own MCP server — what an AgentBricks agent attaches to. */
const mcpUrl = () => `${window.location.origin}/api/mcp`;

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

/** Empty-project spoke: a hub with no agents yet still needs somewhere to look. */
function EmptySpoke({ x, y, lead }: { x: number; y: number; lead: boolean }) {
  return (
    <div
      style={{ position: 'absolute', left: x - 62, top: y - 30, width: 124, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: 0.75 }}
    >
      <div style={{ width: 38, height: 38, borderRadius: 9, border: '1px dashed var(--line2)', display: 'grid', placeItems: 'center', color: 'var(--tx3)', fontSize: 15 }}>
        ◇
      </div>
      <div style={{ ...mono(400, 8), color: 'var(--tx3)', letterSpacing: '.08em', textAlign: 'center' }}>
        {lead ? 'NO AGENTS — ADD ONE' : 'NO AGENTS YET'}
      </div>
    </div>
  );
}

/**
 * Dashed = staged (a runner config awaiting rollout) or an unreachable
 * endpoint. 'offline' is amber rather than the neutral grey 'idle' wears: a
 * runner that has stopped polling is a fact worth seeing, not a resting state
 * (DAT-224).
 */
function spokeState(agent: ProjectAgent): { staged: boolean; unreachable: boolean; color: string } {
  const unreachable = agent.status === 'unreachable';
  const staged = agent.source === 'configured' && !['active', 'idle', 'offline', 'unreachable'].includes(agent.status);
  return {
    staged,
    unreachable,
    color: unreachable
      ? 'var(--bad)'
      : agent.status === 'active'
        ? 'var(--ok)'
        : agent.status === 'offline' || staged
          ? 'var(--warn)'
          : 'var(--tx3)',
  };
}

function AgentSpoke({ agent, x, y, onSelect }: { agent: ProjectAgent; x: number; y: number; onSelect: (agent: ProjectAgent) => void }) {
  const brand = agentBrand(agent);
  const { staged, unreachable, color: statusColor } = spokeState(agent);
  const sub =
    agent.role === 'pr-reviewer'
      ? ROLE_LABEL['pr-reviewer']
      : (brand?.label ?? TYPE_LABEL[agent.agentType] ?? agent.modelProvider ?? 'Runner');
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
          border: staged ? '1px dashed var(--warn)' : unreachable ? '1px dashed var(--bad)' : '1px solid var(--line2)',
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

/** Copy-to-clipboard value chip — used for the MCP URL the agent needs. */
function CopyField({ label, value, toast }: { label: string; value: string; toast: (msg: string) => void }) {
  return (
    <div>
      <div style={LABEL}>{label}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input readOnly value={value} style={{ ...FIELD, ...mono(400, 11), flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
        <button
          className="hv-border"
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => toast('Copied'))
              .catch(() => toast('Copy failed — select the text instead'));
          }}
          style={{ ...mono(500, 9), background: 'none', border: '1px solid var(--line2)', color: 'var(--tx2)', borderRadius: 3, padding: '0 10px', cursor: 'pointer', letterSpacing: '.06em' }}
        >
          COPY
        </button>
      </div>
    </div>
  );
}

function ProjectCluster({
  project,
  agents,
  lead,
  onNewAgent,
  onSelectAgent,
}: {
  project: AgentsOverviewProject;
  agents: ProjectAgent[];
  lead: boolean;
  onNewAgent: () => void;
  onSelectAgent: (agent: ProjectAgent) => void;
}) {
  // One spoke per agent; a project with none still gets a single empty slot so
  // the hub reads as "nothing here yet" rather than a bare box.
  const count = Math.max(1, agents.length);
  const geom = clusterGeometry(count);
  const spots = Array.from({ length: count }, (_, i) => spokeXY(i, count, geom));
  return (
    <div style={{ position: 'relative', width: geom.w, height: geom.h, flex: 'none' }}>
      <svg width={geom.w} height={geom.h} aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
        {spots.map((p, i) => {
          const agent = agents[i];
          const empty = !agent;
          const { staged, unreachable } = agent ? spokeState(agent) : { staged: false, unreachable: false };
          const active = agent?.status === 'active';
          return (
            <line
              key={agent?.id ?? 'empty'}
              x1={geom.cx}
              y1={geom.cy}
              x2={p.x}
              y2={p.y}
              stroke={active ? 'var(--agent)' : unreachable ? 'var(--bad)' : staged ? 'var(--warn)' : 'var(--line2)'}
              strokeWidth={active ? 1.6 : 1.1}
              strokeDasharray={empty || staged || unreachable ? '4 4' : undefined}
              opacity={empty ? 0.55 : 0.9}
            />
          );
        })}
      </svg>
      {spots.map((p, i) =>
        agents[i] ? (
          <AgentSpoke key={agents[i].id} agent={agents[i]} x={p.x} y={p.y} onSelect={onSelectAgent} />
        ) : (
          <EmptySpoke key="empty" x={p.x} y={p.y} lead={lead} />
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
            onClick={onNewAgent}
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
            + NEW AGENT
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

function NewAgentModal({
  project,
  onClose,
  onCreated,
  toast,
}: {
  project: AgentsOverviewProject;
  onClose: () => void;
  onCreated: () => void;
  toast: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [agentType, setAgentType] = useState<ProjectAgentType>('agentbricks');
  const [role, setRole] = useState<ProjectAgentRole>('pr-reviewer');
  const [endpointName, setEndpointName] = useState('');
  const [description, setDescription] = useState('');
  const [harness, setHarness] = useState('claude-code');
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const endpointBacked = agentType === 'agentbricks' || agentType === 'serving-endpoint';

  const submit = () => {
    if (!name.trim()) {
      toast('Give the agent a name');
      return;
    }
    if (endpointBacked && !endpointName.trim()) {
      toast('Name the workspace serving endpoint this agent runs on');
      return;
    }
    if (!endpointBacked && !harness && !provider) {
      toast('Pick a harness or a model provider');
      return;
    }
    setBusy(true);
    api
      .createAgent(project.id, {
        name: name.trim(),
        agentType,
        role,
        endpointName: endpointBacked ? endpointName.trim() : undefined,
        description: description.trim() || undefined,
        harness: endpointBacked ? undefined : harness || undefined,
        modelProvider: endpointBacked ? undefined : provider || undefined,
        model: endpointBacked ? undefined : model.trim() || undefined,
        notes: notes.trim() || undefined,
      })
      .then(() => {
        toast(
          endpointBacked
            ? `${name.trim()} registered on ${project.client}`
            : `${name.trim()} configured for ${project.client} — rollout pending`,
        );
        onCreated();
      })
      .catch((e: Error) => {
        setBusy(false);
        toast(`Could not add the agent — ${e.message}`);
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
        <div style={{ ...mono(500, 11), letterSpacing: '.1em', marginBottom: 2 }}>NEW AGENT — {project.client.toUpperCase()}</div>
        <div style={{ fontSize: 11.5, color: 'var(--tx3)', marginBottom: 14 }}>
          {endpointBacked
            ? 'Register an agent you built in the workspace. Status is read live from the serving endpoint; a pr-reviewer agent is invoked when a linked PR opens.'
            : 'Harness runners are still staged: the configuration is saved, and rollout to a devbox fleet is a future feature.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={LABEL}>TYPE</div>
            <select style={FIELD} value={agentType} onChange={(e) => setAgentType(e.target.value as ProjectAgentType)}>
              <option value="agentbricks">Agent Bricks agent</option>
              <option value="serving-endpoint">Model serving endpoint</option>
              <option value="runner">Agent runner (harness)</option>
              <option value="foundry" disabled>
                Foundry agent — not supported yet
              </option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={LABEL}>NAME</div>
              <input
                style={FIELD}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={endpointBacked ? 'e.g. pr-reviewer' : 'e.g. acme-runner-2'}
                maxLength={80}
                autoFocus
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={LABEL}>ROLE</div>
              <select style={FIELD} value={role} onChange={(e) => setRole(e.target.value as ProjectAgentRole)}>
                <option value="pr-reviewer">PR reviewer — reviews PRs on this project</option>
                <option value="delivery">Delivery — works tickets</option>
                <option value="planning">Planning — refines tickets</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          {endpointBacked ? (
            <>
              <div>
                <div style={LABEL}>SERVING ENDPOINT NAME</div>
                <input
                  style={{ ...FIELD, ...mono(400, 11.5) }}
                  value={endpointName}
                  onChange={(e) => setEndpointName(e.target.value)}
                  placeholder="the endpoint name in Serving, e.g. ka-pr-reviewer"
                  maxLength={200}
                />
                <div style={{ fontSize: 10.5, color: 'var(--tx3)', marginTop: 4 }}>
                  The app’s service principal needs CAN_QUERY on this endpoint, otherwise the node shows as unreachable.
                </div>
              </div>
              <CopyField label="DELIVERY CONSOLE MCP SERVER (ADD THIS TO THE AGENT)" value={mcpUrl()} toast={toast} />
              <div style={{ fontSize: 10.5, color: 'var(--tx3)', marginTop: -6 }}>
                Attach this as a custom MCP server on the agent so it can read tickets and publish its review. The agent’s
                service principal needs CAN_USE on this app.
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
          <div>
            <div style={LABEL}>DESCRIPTION</div>
            <textarea
              style={{ ...FIELD, minHeight: 58, resize: 'vertical', fontFamily: 'inherit' }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this agent does and when it runs — shown on the map and in the agent’s detail popup."
              maxLength={2000}
            />
          </div>
          {!endpointBacked && (
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
          )}
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
            {busy ? 'SAVING…' : endpointBacked ? 'ADD AGENT' : 'STAGE DEPLOY'}
          </button>
        </div>
      </motion.div>
    </>
  );
}

/** Click-through detail for any node on the map (DAT-197 follow-up). */
function AgentDetailModal({
  agent,
  projectName,
  canEdit,
  onClose,
  onRemoved,
  toast,
}: {
  agent: ProjectAgent;
  projectName: string;
  canEdit: boolean;
  onClose: () => void;
  onRemoved: () => void;
  toast: (msg: string) => void;
}) {
  const brand = agentBrand(agent);
  const { staged, unreachable, color: statusColor } = spokeState(agent);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const endpointBacked = agent.agentType === 'agentbricks' || agent.agentType === 'serving-endpoint';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const rows: [string, string][] = [
    ['PROJECT', projectName],
    ['TYPE', agent.agentType === 'runner' ? 'Runner (devbox harness)' : (TYPE_LABEL[agent.agentType] ?? agent.agentType)],
    ['ROLE', ROLE_LABEL[agent.role] ?? agent.role],
    ...(endpointBacked ? ([['ENDPOINT', agent.endpointName ?? '—']] as [string, string][]) : []),
    ...(endpointBacked ? [] : ([['HARNESS', brand?.label ?? agent.harness ?? '—']] as [string, string][])),
    ['MODEL PROVIDER', agent.modelProvider ?? '—'],
    ['MODEL', agent.model ?? '—'],
    [
      'SOURCE',
      agent.source === 'observed'
        ? 'Observed — real runner from task history'
        : staged
          ? 'Configured — rollout pending'
          : 'Stored record · live status synced',
    ],
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
          {unreachable && (
            <div style={{ border: '1px solid var(--bad)', borderRadius: 3, padding: '7px 9px', fontSize: 11.5, color: 'var(--bad)' }}>
              Endpoint unreachable — {agent.endpointError ?? 'the workspace did not return its state'}.
            </div>
          )}
          {agent.description && (
            <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.5, paddingBottom: 2 }}>{agent.description}</div>
          )}
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <span style={{ ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.08em', width: 118, flex: 'none' }}>{label}</span>
              <span style={{ fontSize: 12.5, color: 'var(--tx)', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
            </div>
          ))}
          {endpointBacked && (
            <div style={{ marginTop: 4 }}>
              <CopyField label="DELIVERY CONSOLE MCP SERVER" value={mcpUrl()} toast={toast} />
            </div>
          )}
          {agent.role === 'pr-reviewer' && (
            <div style={{ fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.5, marginTop: 2 }}>
              Runs when a linked PR opens on this project: the console sends the ticket, its acceptance criteria, the diff and
              the CI status, then posts the verdict on the PR and the ticket. It never merges.
            </div>
          )}
          {canEdit && agent.recordId !== null && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
              <button
                className="hv-border"
                onClick={() => {
                  if (!confirmRemove) {
                    setConfirmRemove(true);
                    return;
                  }
                  api
                    .deleteAgent(agent.engagementId, agent.recordId ?? 0)
                    .then(() => {
                      toast(`${agent.name} removed`);
                      onRemoved();
                    })
                    .catch((e: Error) => {
                      setConfirmRemove(false);
                      toast(`Could not remove — ${e.message}`);
                    });
                }}
                style={{
                  ...mono(500, 9),
                  background: 'none',
                  border: `1px solid ${confirmRemove ? 'var(--bad)' : 'var(--line2)'}`,
                  color: confirmRemove ? 'var(--bad)' : 'var(--tx3)',
                  borderRadius: 3,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  letterSpacing: '.07em',
                }}
              >
                {confirmRemove ? 'CONFIRM REMOVE' : 'REMOVE AGENT'}
              </button>
            </div>
          )}
        </div>
      </motion.div>
    </>
  );
}

export function AgentMap({ canLead, toast }: { canLead: (engagementId: string) => boolean; toast: (msg: string) => void }) {
  const [data, setData] = useState<AgentsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newAgentFor, setNewAgentFor] = useState<AgentsOverviewProject | null>(null);
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
          { label: 'LIVE', dot: 'var(--ok)', dashed: false },
          { label: 'IDLE', dot: 'var(--tx3)', dashed: false },
          { label: 'CONFIGURED — ROLLOUT PENDING', dot: 'var(--warn)', dashed: true },
          { label: 'ENDPOINT UNREACHABLE', dot: 'var(--bad)', dashed: true },
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
            onNewAgent={() => setNewAgentFor(p)}
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
            canEdit={canLead(selectedAgent.engagementId)}
            toast={toast}
            onClose={() => setSelectedAgent(null)}
            onRemoved={() => {
              setSelectedAgent(null);
              void load();
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {newAgentFor && (
          <NewAgentModal
            key={newAgentFor.id}
            project={newAgentFor}
            toast={toast}
            onClose={() => setNewAgentFor(null)}
            onCreated={() => {
              setNewAgentFor(null);
              void load();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
