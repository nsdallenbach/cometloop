import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';
import type {
  AgentAccessLevel,
  AgentAction,
  AgentSecurityCatalog,
  AgentSecuritySettings,
  AgentsOverview,
  AgentsOverviewProject,
  ProjectAgent,
  ProjectAgentRole,
  ProjectAgentType,
  RunnerLoadBalance,
} from '../types';
import { HEALTH_COLOR, mono } from '../util';
import { agentBrand, HARNESS_DEFAULT_PROVIDER, HARNESS_OPTIONS, PROVIDER_OPTIONS } from './AgentLogos';
import { MAP_LINKS_CLASS, MAP_MARK_CLASS, MapViewport } from './MapViewport';

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

const GENERAL_CODING_MODELS = new Set(['claude-code', 'codex', 'omnigent', 'gemini', 'copilot', 'cursor']);
const isGeneralCodingAgent = (agent: Pick<ProjectAgent, 'agentType' | 'harness'>) =>
  agent.agentType === 'runner' && Boolean(agent.harness && GENERAL_CODING_MODELS.has(agent.harness.toLowerCase()));

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
      <div
        className={MAP_MARK_CLASS}
        style={{ width: 38, height: 38, borderRadius: 9, border: '1px dashed var(--line2)', display: 'grid', placeItems: 'center', color: 'var(--tx3)', fontSize: 15 }}
      >
        ◇
      </div>
      <div style={{ ...mono(400, 8), color: 'var(--tx3)', letterSpacing: '.08em', textAlign: 'center' }}>
        {lead ? 'NO AGENTS — ADD ONE' : 'NO AGENTS YET'}
      </div>
    </div>
  );
}

/** Dashed = staged (a runner config awaiting rollout) or an unreachable endpoint. */
function spokeState(agent: ProjectAgent): { staged: boolean; unreachable: boolean; disabled: boolean; color: string } {
  const unreachable = agent.status === 'unreachable';
  const staged = agent.source === 'configured' && !['active', 'idle', 'unreachable'].includes(agent.status);
  // A security-disabled agent reads as blocked wherever it appears — it is the
  // one state that overrides "looks healthy" (DAT-212).
  const disabled = !agent.security.enabled;
  return {
    staged,
    unreachable,
    disabled,
    color: disabled
      ? 'var(--bad)'
      : unreachable
        ? 'var(--bad)'
        : agent.status === 'active'
          ? 'var(--ok)'
          : staged
            ? 'var(--warn)'
            : 'var(--tx3)',
  };
}

const ACCESS_LEVEL_LABEL: Record<AgentAccessLevel, string> = {
  restricted: 'RESTRICTED — no scopes',
  standard: 'STANDARD — delivery runner',
  elevated: 'ELEVATED — everything',
  custom: 'CUSTOM — picked per action',
};

/** 'claim_work' → 'Claim work', for when the catalog has not loaded yet. */
const humanizeAction = (id: string) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Only used when the catalog request fails — the labels and preset scopes come
 * from the server so the permission model has one home. The panel still needs
 * every action listed to stay usable, and the server normalizes presets on save
 * either way.
 */
const FALLBACK_ACTIONS: AgentAction[] = ['claim_work', 'git_credential', 'coordination', 'pr_review'];

function AgentSpoke({ agent, x, y, onSelect }: { agent: ProjectAgent; x: number; y: number; onSelect: (agent: ProjectAgent) => void }) {
  const brand = agentBrand(agent);
  const { staged, unreachable, disabled, color: statusColor } = spokeState(agent);
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
      title={
        disabled
          ? `${agent.name} — disabled by security settings; click for details`
          : `${agent.name} — click for ${isGeneralCodingAgent(agent) ? 'load balancing' : 'details'}`
      }
      onClick={() => onSelect(agent)}
      style={{ position: 'absolute', left: x - 62, top: y - 30, width: 124, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer' }}
    >
      <div
        className={MAP_MARK_CLASS}
        style={{
          position: 'relative',
          width: 38,
          height: 38,
          borderRadius: 9,
          background: 'var(--bg3)',
          border:
            disabled || unreachable ? '1px dashed var(--bad)' : staged ? '1px dashed var(--warn)' : '1px solid var(--line2)',
          display: 'grid',
          placeItems: 'center',
          opacity: disabled ? 0.55 : 1,
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
      <div style={{ ...mono(400, 8), color: disabled ? 'var(--bad)' : 'var(--tx3)', letterSpacing: '.08em', textTransform: 'uppercase' }}>
        {sub}
        {disabled ? ' · DISABLED' : staged ? ' · STAGED' : ` · ${agent.status.toUpperCase()}`}
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
        {/* One group per cluster so a zoom settle can lift the whole spoke
            bundle with anime.js in a single animation, not one per line. */}
        <g className={MAP_LINKS_CLASS}>
          {spots.map((p, i) => {
            const agent = agents[i];
            const empty = !agent;
            const { staged, unreachable, disabled } = agent
              ? spokeState(agent)
              : { staged: false, unreachable: false, disabled: false };
            const active = agent?.status === 'active' && !disabled;
            return (
              <line
                key={agent?.id ?? 'empty'}
                x1={geom.cx}
                y1={geom.cy}
                x2={p.x}
                y2={p.y}
                stroke={
                  disabled || unreachable ? 'var(--bad)' : active ? 'var(--agent)' : staged ? 'var(--warn)' : 'var(--line2)'
                }
                strokeWidth={active ? 1.6 : 1.1}
                strokeDasharray={empty || staged || unreachable || disabled ? '4 4' : undefined}
                opacity={empty ? 0.55 : 0.9}
              />
            );
          })}
        </g>
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
        className={MAP_MARK_CLASS}
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

/**
 * Per-agent security controls (DAT-212), inside the agent's detail panel: the
 * enable switch and the permission scope the backend enforces at
 * action-execution time. Leads edit; everyone else reads.
 *
 * Each agent's settings are addressed by its own record id, so editing one never
 * touches another. Observed runners whose stored row has not been written yet
 * (recordId null) render read-only rather than pretending to save.
 */
function SecurityPanel({
  agent,
  canEdit,
  catalog,
  onSaved,
  toast,
}: {
  agent: ProjectAgent;
  canEdit: boolean;
  catalog: AgentSecurityCatalog | null;
  onSaved: (settings: AgentSecuritySettings) => void;
  toast: (msg: string) => void;
}) {
  // Seeded once per agent: the panel is keyed by agent id, so selecting a
  // different node remounts it with that agent's settings. No sync effect —
  // a save updates the draft directly, and the map's 15s poll must never
  // clobber an edit in progress.
  const [draft, setDraft] = useState<AgentSecuritySettings>(agent.security);
  const [busy, setBusy] = useState(false);

  const editable = canEdit && agent.recordId !== null;
  const actions: { id: AgentAction; label: string }[] =
    catalog?.actions ?? FALLBACK_ACTIONS.map((id) => ({ id, label: humanizeAction(id) }));
  const dirty =
    draft.enabled !== agent.security.enabled ||
    draft.accessLevel !== agent.security.accessLevel ||
    draft.allowedActions.join(',') !== agent.security.allowedActions.join(',');

  /** Presets rewrite the scope list; ticking an individual action means custom. */
  const pickLevel = (level: AgentAccessLevel) =>
    setDraft((d) => ({
      ...d,
      accessLevel: level,
      allowedActions: level === 'custom' ? d.allowedActions : (catalog?.presets[level] ?? d.allowedActions),
    }));

  const toggleAction = (id: AgentAction) =>
    setDraft((d) => ({
      ...d,
      accessLevel: 'custom',
      allowedActions: d.allowedActions.includes(id) ? d.allowedActions.filter((a) => a !== id) : [...d.allowedActions, id],
    }));

  const save = () => {
    if (agent.recordId === null) return;
    setBusy(true);
    api
      .updateAgentSecurity(agent.engagementId, agent.recordId, {
        enabled: draft.enabled,
        accessLevel: draft.accessLevel,
        allowedActions: draft.allowedActions,
      })
      .then((saved) => {
        setBusy(false);
        setDraft(saved);
        onSaved(saved);
        toast(`Security settings saved for ${agent.name}`);
      })
      .catch((e: Error) => {
        setBusy(false);
        setDraft(agent.security);
        toast(`Could not save security settings — ${e.message}`);
      });
  };

  return (
    <div style={{ marginTop: 6, border: '1px solid var(--line2)', borderRadius: 4, padding: '10px 11px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ ...mono(600, 9.5), letterSpacing: '.1em', color: 'var(--tx2)' }}>SECURITY</span>
        <span
          style={{
            ...mono(500, 8.5),
            letterSpacing: '.08em',
            color: draft.enabled ? 'var(--ok)' : 'var(--bad)',
            border: `1px solid ${draft.enabled ? 'var(--ok)' : 'var(--bad)'}`,
            borderRadius: 3,
            padding: '1px 6px',
          }}
        >
          {draft.enabled ? 'ENABLED' : 'DISABLED'}
        </span>
        {editable && (
          <button
            className="hv-border"
            onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
            style={{
              ...mono(500, 8.5),
              marginLeft: 'auto',
              background: 'none',
              border: `1px solid ${draft.enabled ? 'var(--bad)' : 'var(--ok)'}`,
              color: draft.enabled ? 'var(--bad)' : 'var(--ok)',
              borderRadius: 3,
              padding: '2px 8px',
              cursor: 'pointer',
              letterSpacing: '.07em',
            }}
          >
            {draft.enabled ? 'DISABLE AGENT' : 'ENABLE AGENT'}
          </button>
        )}
      </div>

      {editable ? (
        <div style={{ marginBottom: 8 }}>
          <div style={LABEL}>ACCESS LEVEL</div>
          <select style={FIELD} value={draft.accessLevel} onChange={(e) => pickLevel(e.target.value as AgentAccessLevel)}>
            {(catalog?.accessLevels ?? (['restricted', 'standard', 'elevated', 'custom'] as AgentAccessLevel[])).map((l) => (
              <option key={l} value={l}>
                {ACCESS_LEVEL_LABEL[l] ?? l}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', marginBottom: 8 }}>
          <span style={{ ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.08em', width: 118, flex: 'none' }}>ACCESS LEVEL</span>
          <span style={{ fontSize: 12.5 }}>{ACCESS_LEVEL_LABEL[draft.accessLevel] ?? draft.accessLevel}</span>
        </div>
      )}

      <div style={LABEL}>PERMISSION SCOPE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {actions.map((a) => {
          const granted = draft.allowedActions.includes(a.id);
          return (
            <label
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 7,
                fontSize: 11.5,
                color: granted ? 'var(--tx)' : 'var(--tx3)',
                cursor: editable ? 'pointer' : 'default',
              }}
            >
              <input
                type="checkbox"
                checked={granted}
                disabled={!editable}
                onChange={() => toggleAction(a.id)}
                style={{ marginTop: 2, accentColor: 'var(--agent)' }}
              />
              <span>
                {a.label}
                <span style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.06em', marginLeft: 6 }}>{a.id}</span>
              </span>
            </label>
          );
        })}
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--tx3)', lineHeight: 1.5, marginTop: 8 }}>
        Enforced when the agent acts, not when it is configured: a blocked action is rejected with the reason and logged to the
        feed. Closing out a task the agent already holds is always allowed, so disabling one never strands a ticket mid-run —
        cancel the run on the board for that.
      </div>

      {draft.updatedBy && (
        <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', letterSpacing: '.06em', marginTop: 6 }}>
          LAST CHANGED BY {draft.updatedBy.toUpperCase()}
          {draft.updatedAt ? ` · ${relTime(draft.updatedAt).toUpperCase()}` : ''}
        </div>
      )}

      {canEdit && agent.recordId === null && (
        <div style={{ fontSize: 10.5, color: 'var(--warn)', marginTop: 6 }}>
          This runner has no stored record yet — its settings become editable after the next agent-map sync.
        </div>
      )}

      {editable && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
          {dirty && (
            <button
              className="hv-tx2"
              onClick={() => setDraft(agent.security)}
              style={{ ...mono(500, 9), background: 'none', border: '1px solid var(--line2)', color: 'var(--tx3)', borderRadius: 3, padding: '4px 10px', cursor: 'pointer', letterSpacing: '.07em' }}
            >
              RESET
            </button>
          )}
          <button
            onClick={save}
            disabled={busy || !dirty}
            style={{
              ...mono(500, 9),
              background: dirty ? 'var(--agent)' : 'none',
              border: `1px solid ${dirty ? 'var(--agent)' : 'var(--line2)'}`,
              color: dirty ? '#fff' : 'var(--tx3)',
              borderRadius: 3,
              padding: '4px 12px',
              cursor: busy ? 'wait' : dirty ? 'pointer' : 'default',
              letterSpacing: '.07em',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? 'SAVING…' : 'SAVE SECURITY'}
          </button>
        </div>
      )}
    </div>
  );
}

function LoadBalancingModal({ agent, canEdit, onClose, toast }: { agent: ProjectAgent; canEdit: boolean; onClose: () => void; toast: (message: string) => void }) {
  const modelType = agent.harness ?? '';
  const [runners, setRunners] = useState<RunnerLoadBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    api.runnerLoadBalancing(agent.engagementId, modelType)
      .then((data) => setRunners(data.runners))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    return () => window.removeEventListener('keydown', onKey);
  }, [agent.engagementId, modelType, onClose]);
  const update = (name: string, values: Partial<RunnerLoadBalance>) => setRunners((rows) => rows.map((r) => (r.name === name ? { ...r, ...values } : r)));
  const totalWeight = runners.reduce((sum, runner) => sum + runner.weight, 0);
  const save = () => {
    if (runners.some((r) => !Number.isInteger(r.weight) || r.weight < 0 || r.weight > 100)) return setError('Weights must be whole numbers from 0 to 100.');
    if (totalWeight === 0) return setError('At least one runner must have a positive weight.');
    if (runners.some((r) => r.cap !== null && (!Number.isInteger(r.cap) || r.cap < 1 || r.cap > 100))) return setError('Caps must be blank or a whole number from 1 to 100.');
    setBusy(true);
    setError(null);
    api.saveRunnerLoadBalancing(agent.engagementId, modelType, runners.map(({ name, weight, cap }) => ({ name, weight, cap })))
      .then(() => { toast(`Load balancing saved for ${modelType}`); onClose(); })
      .catch((e: Error) => { setError(e.message); setBusy(false); });
  };
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 54 }} />
      <motion.div initial={{ opacity: 0, transform: 'translate(-50%,-48%) scale(.97)' }} animate={{ opacity: 1, transform: 'translate(-50%,-50%) scale(1)' }} role="dialog" aria-label={`Load balancing for ${agent.name}`} style={{ position: 'fixed', left: '50%', top: '50%', width: 520, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 50px)', overflowY: 'auto', background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 6, padding: 18, zIndex: 55, boxShadow: '0 12px 40px rgba(0,0,0,.5)' }}>
        <div style={{ display: 'flex', alignItems: 'start', gap: 10 }}>
          <div><div style={{ ...mono(600, 11), letterSpacing: '.1em' }}>RUNNER LOAD BALANCING</div><div style={{ fontSize: 11.5, color: 'var(--tx3)', marginTop: 3 }}>{agent.name} · {modelType}. Weights are relative; caps limit concurrent tasks per runner.</div></div>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', border: 0, background: 'none', color: 'var(--tx3)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>
        {loading ? <div style={{ color: 'var(--tx3)', fontSize: 12, padding: '24px 0' }}>Loading available runners…</div> : runners.length === 0 ? <div style={{ color: 'var(--tx3)', fontSize: 12, padding: '24px 0' }}>No live or idle runners are currently available for this model type.</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            {runners.map((runner) => <div key={runner.name} style={{ border: '1px solid var(--line2)', borderRadius: 4, padding: '10px 11px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}><span style={{ ...mono(600, 10.5), flex: 1 }}>{runner.name}</span><span style={{ ...mono(400, 8.5), color: runner.status === 'active' ? 'var(--ok)' : 'var(--tx3)', letterSpacing: '.07em' }}>{runner.status.toUpperCase()} · {runner.activeTasks} ACTIVE</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 64px 86px', gap: 8, alignItems: 'center' }}>
                <input aria-label={`${runner.name} weight slider`} type="range" min={0} max={100} value={runner.weight} disabled={!canEdit} onChange={(e) => update(runner.name, { weight: Number(e.target.value) })} />
                <input aria-label={`${runner.name} weight`} type="number" min={0} max={100} step={1} value={runner.weight} disabled={!canEdit} onChange={(e) => update(runner.name, { weight: Number(e.target.value) })} style={{ ...FIELD, padding: '5px 6px' }} />
                <input aria-label={`${runner.name} concurrency cap`} type="number" min={1} max={100} step={1} value={runner.cap ?? ''} disabled={!canEdit} placeholder="No cap" onChange={(e) => update(runner.name, { cap: e.target.value === '' ? null : Number(e.target.value) })} style={{ ...FIELD, padding: '5px 6px' }} />
              </div>
              <div style={{ ...mono(400, 8.5), color: 'var(--tx3)', marginTop: 5 }}>{totalWeight > 0 ? `${Math.round((runner.weight / totalWeight) * 100)}% TARGET SHARE` : '0% TARGET SHARE'}</div>
            </div>)}
          </div>
        )}
        {error && <div role="alert" style={{ color: 'var(--bad)', fontSize: 11.5, marginTop: 12 }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={{ ...mono(500, 9.5), background: 'none', border: '1px solid var(--line2)', color: 'var(--tx3)', borderRadius: 3, padding: '6px 11px', cursor: 'pointer' }}>CANCEL</button>
          {canEdit && <button onClick={save} disabled={busy || loading || runners.length === 0} style={{ ...mono(500, 9.5), background: 'var(--agent)', border: '1px solid var(--agent)', color: '#fff', borderRadius: 3, padding: '6px 12px', cursor: busy ? 'wait' : 'pointer', opacity: busy || loading || runners.length === 0 ? .6 : 1 }}>{busy ? 'SAVING…' : 'SAVE'}</button>}
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
  catalog,
  onClose,
  onRemoved,
  onSecuritySaved,
  toast,
}: {
  agent: ProjectAgent;
  projectName: string;
  canEdit: boolean;
  catalog: AgentSecurityCatalog | null;
  onClose: () => void;
  onRemoved: () => void;
  onSecuritySaved: (settings: AgentSecuritySettings) => void;
  toast: (msg: string) => void;
}) {
  const brand = agentBrand(agent);
  const { staged, unreachable, disabled, color: statusColor } = spokeState(agent);
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
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, animation: agent.status === 'active' && !disabled ? 'eec-pulse 2.4s infinite' : undefined }} />
              {disabled ? 'DISABLED BY SECURITY' : staged ? 'STAGED' : agent.status.toUpperCase()}
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
          <SecurityPanel key={agent.id} agent={agent} canEdit={canEdit} catalog={catalog} onSaved={onSecuritySaved} toast={toast} />
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
  // Action ids, labels and preset scopes come from the server so the permission
  // model lives in one place; the panel degrades to humanized ids without it.
  const [securityCatalog, setSecurityCatalog] = useState<AgentSecurityCatalog | null>(null);
  const [loadBalanceAgent, setLoadBalanceAgent] = useState<ProjectAgent | null>(null);

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

  useEffect(() => {
    api
      .agentSecurityCatalog()
      .then(setSecurityCatalog)
      .catch(() => setSecurityCatalog(null));
  }, []);

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
    // Column layout with the pane itself clipped: the constellation lives in a
    // zoomable viewport that owns the remaining height, so the page must not
    // scroll underneath it and fight the wheel gesture.
    <div
      className="tab-pane"
      style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '18px 22px 18px' }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', flex: 'none' }}>
        <span style={{ ...mono(700, 13), letterSpacing: '.12em' }}>AGENT MAP</span>
        {data && (
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
            {data.projects.length} PROJECT{data.projects.length === 1 ? '' : 'S'} · {totals.agents} AGENT{totals.agents === 1 ? '' : 'S'}
            {totals.live > 0 ? ` · ${totals.live} LIVE` : ''}
          </span>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
          Architecture view — projects at the center, their agents as spokes. Click an agent for its details and security
          controls.
        </span>
      </div>

      {/* Legend, including the not-yet-live node kinds. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '12px 0 8px', flex: 'none' }}>
        {[
          { label: 'LIVE', dot: 'var(--ok)', dashed: false },
          { label: 'IDLE', dot: 'var(--tx3)', dashed: false },
          { label: 'CONFIGURED — ROLLOUT PENDING', dot: 'var(--warn)', dashed: true },
          { label: 'ENDPOINT UNREACHABLE', dot: 'var(--bad)', dashed: true },
          { label: 'DISABLED BY SECURITY', dot: 'var(--bad)', dashed: true },
        ].map((l) => (
          <span
            key={l.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: `1px ${l.dashed ? 'dashed' : 'solid'} var(--line2)`, borderRadius: 3, padding: '3px 8px', ...mono(400, 8.5), color: 'var(--tx2)', letterSpacing: '.07em' }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: l.dot }} />
            {l.label}
          </span>
        ))}
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

      {data && data.projects.length > 0 && (
        <MapViewport>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {data.projects.map((p) => (
              <ProjectCluster
                key={p.id}
                project={p}
                agents={byProject.get(p.id) ?? []}
                lead={canLead(p.id)}
                onNewAgent={() => setNewAgentFor(p)}
                onSelectAgent={(agent) => (isGeneralCodingAgent(agent) ? setLoadBalanceAgent(agent) : setSelectedAgent(agent))}
              />
            ))}
          </div>
        </MapViewport>
      )}

      <AnimatePresence>
        {selectedAgent && (
          <AgentDetailModal
            key={selectedAgent.id}
            agent={selectedAgent}
            projectName={data?.projects.find((p) => p.id === selectedAgent.engagementId)?.name ?? selectedAgent.engagementId}
            canEdit={canLead(selectedAgent.engagementId)}
            catalog={securityCatalog}
            toast={toast}
            onClose={() => setSelectedAgent(null)}
            onRemoved={() => {
              setSelectedAgent(null);
              void load();
            }}
            onSecuritySaved={(security) => {
              // Reflect the save on the open panel and the node behind it
              // immediately, rather than waiting for the next 15s poll.
              setSelectedAgent((a) => (a ? { ...a, security } : a));
              setData((d) =>
                d ? { ...d, agents: d.agents.map((a) => (a.id === selectedAgent.id ? { ...a, security } : a)) } : d,
              );
            }}
          />
        )}
        {loadBalanceAgent && (
          <LoadBalancingModal key={loadBalanceAgent.id} agent={loadBalanceAgent} canEdit={canLead(loadBalanceAgent.engagementId)} onClose={() => setLoadBalanceAgent(null)} toast={toast} />
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
