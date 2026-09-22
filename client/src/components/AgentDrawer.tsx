import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api';
import type {
  AgentModelCatalog,
  AgentSecurityCatalog,
  AgentSecuritySettings,
  AgentsOverviewProject,
  ProjectAgent,
  ProjectAgentRole,
  ProjectAgentType,
  Registry,
} from '../types';
import { mono } from '../util';
import {
  agentBrand,
  HARNESS_DEFAULT_PROVIDER,
  HARNESS_OPTIONS,
  harnessBrand,
  PROVIDER_OPTIONS,
  providerBrand,
} from './AgentLogos';
import { CopyField, SecurityPanel } from './AgentPanels';
import {
  agentState,
  FIELD,
  fmtTokens,
  isEndpointBacked,
  isGeneralCodingAgent,
  LABEL,
  mcpUrl,
  relTime,
  ROLE_LABEL,
  TYPE_LABEL,
} from '../lib/agents';

/**
 * The configure drawer (DAT-278): one right-side panel for creating an agent
 * and for editing an existing one. Sections top to bottom — where it lives,
 * what it is, what model it runs, what it can reach (MCP servers and skills,
 * registry-backed once DAT-238 lands), what it may do (security), and the
 * fleet controls (load balancing, remove).
 *
 * Draft state is seeded once per agent (the drawer is keyed by agent id) and
 * never re-synced from the page's poll, so an edit in progress survives the
 * 15s refresh; a save reports up and the page reloads.
 */

/** Sentinel option values for the "type your own" branches of the model pickers. */
const CUSTOM = '__custom__';

interface Draft {
  projectId: string;
  name: string;
  agentType: ProjectAgentType;
  role: ProjectAgentRole;
  description: string;
  endpointName: string;
  harness: string;
  provider: string;
  model: string;
  notes: string;
  /** Registry attachments (DAT-238). */
  mcpServers: number[];
  skills: number[];
}

function draftFrom(agent: ProjectAgent | null, projectId: string): Draft {
  return {
    projectId: agent?.engagementId ?? projectId,
    name: agent?.name ?? '',
    // New agents registered from the web are workspace endpoints; runner
    // agents come from developers' desktop clients (DAT-280).
    agentType: agent?.agentType ?? 'agentbricks',
    role: agent?.role ?? 'delivery',
    description: agent?.description ?? '',
    endpointName: agent?.endpointName ?? '',
    harness: agent ? (agent.harness ?? '') : 'claude-code',
    provider: agent ? (agent.modelProvider ?? '') : 'anthropic',
    model: agent?.model ?? '',
    notes: '',
    mcpServers: agent?.mcpServers ?? [],
    skills: agent?.skills ?? [],
  };
}

const Section = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        borderBottom: '1px solid var(--line)',
        paddingBottom: 5,
      }}
    >
      <span style={{ ...mono(600, 9.5), letterSpacing: '.12em', color: 'var(--tx2)' }}>{title}</span>
      {hint && <span style={{ fontSize: 10.5, color: 'var(--tx3)' }}>{hint}</span>}
    </div>
    {children}
  </section>
);

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
    <span style={{ ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.08em', width: 112, flex: 'none' }}>
      {label}
    </span>
    <span style={{ fontSize: 12.5, color: 'var(--tx)', minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
  </div>
);

/** A model id with its provider's mark in front — the picker's "what did I choose" line. */
export function ModelChip({
  model,
  provider,
  size = 12,
}: {
  model: string | null;
  provider: string | null;
  size?: number;
}) {
  const brand = providerBrand(provider);
  if (!model) return <span style={{ color: 'var(--tx3)' }}>no model set</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {brand && <span style={{ display: 'inline-flex', flex: 'none' }}>{brand.mark(size)}</span>}
      <span style={{ ...mono(500, 11), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {model}
      </span>
    </span>
  );
}

export function AgentDrawer({
  agent,
  projects,
  initialProjectId,
  canLead,
  securityCatalog,
  models,
  onClose,
  onSaved,
  onRemoved,
  onSecuritySaved,
  onLoadBalancing,
  toast,
}: {
  /** null = create mode. */
  agent: ProjectAgent | null;
  projects: AgentsOverviewProject[];
  initialProjectId: string;
  canLead: (engagementId: string) => boolean;
  securityCatalog: AgentSecurityCatalog | null;
  models: AgentModelCatalog | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onRemoved: () => void;
  onSecuritySaved: (settings: AgentSecuritySettings) => void;
  onLoadBalancing: (agent: ProjectAgent) => void;
  toast: (msg: string) => void;
}) {
  const creating = agent === null;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(agent, initialProjectId));
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [customEndpoint, setCustomEndpoint] = useState(false);

  const project = projects.find((p) => p.id === draft.projectId) ?? null;
  const lead = canLead(draft.projectId);
  const stored = agent ? agent.recordId !== null : true;
  const systemRow = agent?.source === 'observed' || agent?.name === 'planning-agent';
  // Runner agents are managed on developers' desktops (DAT-280): the web only
  // mirrors what they report. Everything about their run configuration is
  // read-only here; lead governance (security scopes, load balancing) stays.
  const runnerAgent = agent?.agentType === 'runner';
  const editable = lead && (creating || stored) && !runnerAgent;
  const endpointBacked = isEndpointBacked(draft.agentType);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Model options for the current harness; the current value stays selectable
  // even when it is not in the vetted list (a lead typed it), via CUSTOM.
  const harnessModels = useMemo(() => models?.harnessModels[draft.harness] ?? [], [models, draft.harness]);
  const modelInList = harnessModels.some((m) => m.id === draft.model);
  const showCustomModel = customModel || (draft.model !== '' && !modelInList);
  const endpointInList = (models?.servingEndpoints ?? []).some((e) => e.name === draft.endpointName);
  const showCustomEndpoint = customEndpoint || (draft.endpointName !== '' && !endpointInList);
  const pickedEndpoint = (models?.servingEndpoints ?? []).find((e) => e.name === draft.endpointName) ?? null;

  // What this project may attach: shared registry entries plus its own. Reloads
  // when a new agent is pointed at a different project.
  const [registry, setRegistry] = useState<Registry | null>(null);
  useEffect(() => {
    let stale = false;
    api
      .registry(draft.projectId)
      .then((r) => {
        if (!stale) setRegistry(r);
      })
      .catch(() => {
        if (!stale) setRegistry(null);
      });
    return () => {
      stale = true;
    };
  }, [draft.projectId]);
  const toggleId = (k: 'mcpServers' | 'skills', id: number) =>
    setDraft((d) => ({ ...d, [k]: d[k].includes(id) ? d[k].filter((x) => x !== id) : [...d[k], id] }));

  const dirty = useMemo(() => {
    if (creating) return true;
    const base = draftFrom(agent, initialProjectId);
    return (Object.keys(base) as (keyof Draft)[]).some(
      (k) => k !== 'notes' && JSON.stringify(base[k]) !== JSON.stringify(draft[k])
    );
  }, [agent, creating, draft, initialProjectId]);

  const brandPreview = agentBrand({
    agentType: draft.agentType,
    harness: endpointBacked ? null : draft.harness || null,
    modelProvider: endpointBacked ? (pickedEndpoint?.provider ?? 'databricks') : draft.provider || null,
  });

  const submit = () => {
    if (!draft.name.trim()) return toast('Give the agent a name');
    if (endpointBacked && !draft.endpointName.trim())
      return toast('Name the workspace serving endpoint this agent runs on');
    if (!endpointBacked && !draft.harness && !draft.provider) return toast('Pick a harness or a model provider');
    setBusy(true);
    const done = (message: string) => {
      setBusy(false);
      onSaved(message);
    };
    const fail = (e: Error) => {
      setBusy(false);
      toast(`Could not save the agent — ${e.message}`);
    };
    if (creating) {
      api
        .createAgent(draft.projectId, {
          name: draft.name.trim(),
          agentType: draft.agentType,
          role: draft.role,
          endpointName: endpointBacked ? draft.endpointName.trim() : undefined,
          description: draft.description.trim() || undefined,
          harness: endpointBacked ? undefined : draft.harness || undefined,
          modelProvider: endpointBacked ? undefined : draft.provider || undefined,
          model: endpointBacked ? undefined : draft.model.trim() || undefined,
          notes: draft.notes.trim() || undefined,
        })
        .then(async (created) => {
          // Attachments are a PATCH concern; a create with any selected follows
          // up on the new record before the drawer closes.
          const id = (created as { id?: number } | null)?.id;
          if (id && (draft.mcpServers.length || draft.skills.length)) {
            await api.updateAgent(draft.projectId, id, { mcpServers: draft.mcpServers, skills: draft.skills });
          }
          done(
            endpointBacked
              ? `${draft.name.trim()} registered on ${project?.client ?? 'the project'}`
              : `${draft.name.trim()} configured for ${project?.client ?? 'the project'} — rollout pending`
          );
        })
        .catch(fail);
      return;
    }
    if (!agent || agent.recordId === null) return;
    const base = draftFrom(agent, initialProjectId);
    const payload: Parameters<typeof api.updateAgent>[2] = {};
    if (draft.name.trim() !== base.name && !systemRow) payload.name = draft.name.trim();
    if (draft.role !== base.role) payload.role = draft.role;
    if (draft.description.trim() !== base.description) payload.description = draft.description.trim() || null;
    if (endpointBacked && draft.endpointName.trim() !== base.endpointName)
      payload.endpointName = draft.endpointName.trim();
    if (!endpointBacked) {
      if (draft.harness !== base.harness) payload.harness = draft.harness || null;
      if (draft.provider !== base.provider) payload.modelProvider = draft.provider || null;
      if (draft.model.trim() !== base.model) payload.model = draft.model.trim() || null;
    }
    if (JSON.stringify(draft.mcpServers) !== JSON.stringify(base.mcpServers)) payload.mcpServers = draft.mcpServers;
    if (JSON.stringify(draft.skills) !== JSON.stringify(base.skills)) payload.skills = draft.skills;
    api
      .updateAgent(agent.engagementId, agent.recordId, payload)
      .then(() => done(`${draft.name.trim() || agent.name} updated`))
      .catch(fail);
  };

  const remove = () => {
    if (!agent || agent.recordId === null) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    api
      .deleteAgent(agent.engagementId, agent.recordId)
      .then(() => {
        toast(`${agent.name} removed`);
        onRemoved();
      })
      .catch((e: Error) => {
        setConfirmRemove(false);
        toast(`Could not remove — ${e.message}`);
      });
  };

  const state = agent ? agentState(agent) : null;
  const disabledStyle = editable ? {} : { opacity: 0.7, cursor: 'not-allowed' as const };

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 40 }}
      />
      <motion.aside
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ type: 'spring', visualDuration: 0.28, bounce: 0.12 }}
        role="dialog"
        aria-label={creating ? 'New agent' : `Configure ${agent?.name ?? 'agent'}`}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          maxWidth: '100vw',
          background: 'var(--bg2)',
          borderLeft: '1px solid var(--line)',
          zIndex: 41,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-12px 0 40px rgba(0,0,0,.35)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid var(--line)',
            flex: 'none',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: 42,
              height: 42,
              borderRadius: 10,
              background: 'var(--bg3)',
              border: state?.staged
                ? '1px dashed var(--warn)'
                : state?.disabled || state?.unreachable
                  ? '1px dashed var(--bad)'
                  : '1px solid var(--line2)',
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
            }}
          >
            {brandPreview ? (
              brandPreview.mark(24)
            ) : (
              <span style={{ ...mono(700, 16), color: 'var(--agent)' }}>
                {(draft.name || '?').charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                ...mono(600, 12.5),
                letterSpacing: '.04em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {creating ? 'REGISTER ENDPOINT AGENT' : agent?.name}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                ...mono(400, 9),
                color: state?.color ?? 'var(--tx3)',
                letterSpacing: '.08em',
                marginTop: 2,
              }}
            >
              {state && (
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: state.color,
                    animation: agent?.status === 'active' && !state.disabled ? 'eec-pulse 2.4s infinite' : undefined,
                  }}
                />
              )}
              {creating
                ? `ON ${project?.client.toUpperCase() ?? 'A PROJECT'}`
                : `${state?.label ?? ''} · ${TYPE_LABEL[agent?.agentType ?? ''] ?? ''} · ${ROLE_LABEL[agent?.role ?? ''] ?? ''}`}
            </div>
          </div>
          <button
            className="hv-tx"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none',
              background: 'none',
              color: 'var(--tx3)',
              fontSize: 18,
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
          }}
        >
          {!lead && (
            <div
              style={{
                border: '1px solid var(--line2)',
                borderRadius: 3,
                padding: '7px 9px',
                fontSize: 11.5,
                color: 'var(--tx3)',
              }}
            >
              Read-only — only the project&apos;s leads can manage its endpoint agents and security settings.
            </div>
          )}
          {runnerAgent && (
            <div
              style={{
                border: '1px solid var(--agent)',
                borderRadius: 3,
                padding: '8px 10px',
                fontSize: 11.5,
                color: 'var(--tx2)',
                lineHeight: 1.5,
              }}
            >
              <span style={{ ...mono(600, 9), letterSpacing: '.1em', color: 'var(--agent)' }}>DESKTOP-MANAGED</span>{' '}
              {agent?.managedBy === 'desktop'
                ? `Configured on ${agent.host ?? 'its developer’s'} desktop client — scope, model, MCP servers and skills are set there; this is what it reported.`
                : 'This runner has not reported from a desktop client yet. Its scope, model and attachments are managed on its developer’s machine, not here.'}
              {agent && agent.projects.length > 0 && (
                <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginTop: 4, letterSpacing: '.04em' }}>
                  CLAIMS FROM: {agent.projects.map((p) => projects.find((x) => x.id === p)?.client ?? p).join(' · ')}
                </div>
              )}
            </div>
          )}
          {agent && agent.recordId === null && lead && (
            <div
              style={{
                border: '1px solid var(--warn)',
                borderRadius: 3,
                padding: '7px 9px',
                fontSize: 11.5,
                color: 'var(--warn)',
              }}
            >
              This runner has no stored record yet — it becomes configurable after the next agent sync (a few seconds).
            </div>
          )}
          {state?.unreachable && (
            <div
              style={{
                border: '1px solid var(--bad)',
                borderRadius: 3,
                padding: '7px 9px',
                fontSize: 11.5,
                color: 'var(--bad)',
              }}
            >
              Endpoint unreachable — {agent?.endpointError ?? 'the workspace did not return its state'}.
            </div>
          )}

          <Section title="PROJECT" hint={creating ? 'Agents are scoped to one project' : undefined}>
            {creating ? (
              <select style={FIELD} value={draft.projectId} onChange={(e) => set('projectId', e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id} disabled={!canLead(p.id)}>
                    {p.client} — {p.name}
                    {canLead(p.id) ? '' : ' (not a lead)'}
                  </option>
                ))}
              </select>
            ) : (
              <Row label="PROJECT" value={project ? `${project.client} — ${project.name}` : draft.projectId} />
            )}
          </Section>

          <Section title="IDENTITY">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ gridColumn: creating ? 'auto' : '1 / -1' }}>
                <div style={LABEL}>NAME</div>
                <input
                  style={{ ...FIELD, ...disabledStyle }}
                  value={draft.name}
                  disabled={!editable || Boolean(systemRow)}
                  title={systemRow ? 'Named by the runner itself — rename the runner, not the record' : undefined}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder={endpointBacked ? 'e.g. pr-reviewer' : 'e.g. acme-runner-2'}
                  maxLength={80}
                  autoFocus={creating}
                />
              </div>
              {creating && (
                <div>
                  <div style={LABEL}>TYPE</div>
                  <select
                    style={FIELD}
                    value={draft.agentType}
                    onChange={(e) => set('agentType', e.target.value as ProjectAgentType)}
                  >
                    <option value="agentbricks">Agent Bricks agent</option>
                    <option value="serving-endpoint">Model serving endpoint</option>
                    <option value="foundry" disabled>
                      Foundry agent — not supported yet
                    </option>
                  </select>
                </div>
              )}
            </div>
            <div>
              <div style={LABEL}>ROLE</div>
              <select
                style={{ ...FIELD, ...disabledStyle }}
                value={draft.role}
                disabled={!editable}
                onChange={(e) => set('role', e.target.value as ProjectAgentRole)}
              >
                <option value="delivery">Delivery — works tickets</option>
                <option value="pr-reviewer">PR reviewer — reviews PRs on this project</option>
                <option value="planning">Planning — refines tickets</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <div style={LABEL}>DESCRIPTION</div>
              <textarea
                style={{ ...FIELD, minHeight: 54, resize: 'vertical', fontFamily: 'inherit', ...disabledStyle }}
                value={draft.description}
                disabled={!editable}
                onChange={(e) => set('description', e.target.value)}
                placeholder="What this agent does and when it runs."
                maxLength={2000}
              />
            </div>
          </Section>

          <Section
            title="MODEL"
            hint={
              models
                ? models.source === 'workspace'
                  ? 'from the workspace'
                  : 'built-in list — workspace not reachable'
                : undefined
            }
          >
            {endpointBacked ? (
              <>
                <div>
                  <div style={LABEL}>SERVING ENDPOINT</div>
                  {!showCustomEndpoint ? (
                    <select
                      style={{ ...FIELD, ...mono(400, 11.5), ...disabledStyle }}
                      value={draft.endpointName}
                      disabled={!editable}
                      onChange={(e) => {
                        if (e.target.value === CUSTOM) {
                          setCustomEndpoint(true);
                          set('endpointName', '');
                          return;
                        }
                        set('endpointName', e.target.value);
                      }}
                    >
                      <option value="">— pick an endpoint —</option>
                      {(models?.servingEndpoints ?? []).map((e) => (
                        <option key={e.name} value={e.name}>
                          {e.name}
                          {e.task === 'llm/v1/chat' ? '' : ` · ${e.task ?? 'agent'}`}
                          {e.ready ? '' : ' · not ready'}
                        </option>
                      ))}
                      <option value={CUSTOM}>Other endpoint name…</option>
                    </select>
                  ) : (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        style={{ ...FIELD, ...mono(400, 11.5), ...disabledStyle }}
                        value={draft.endpointName}
                        disabled={!editable}
                        onChange={(e) => set('endpointName', e.target.value)}
                        placeholder="the endpoint name in Serving, e.g. ka-pr-reviewer"
                        maxLength={200}
                        autoFocus
                      />
                      {editable && (
                        <button
                          className="hv-border"
                          onClick={() => {
                            setCustomEndpoint(false);
                            set('endpointName', '');
                          }}
                          style={{
                            ...mono(500, 9),
                            background: 'none',
                            border: '1px solid var(--line2)',
                            color: 'var(--tx2)',
                            borderRadius: 3,
                            padding: '0 10px',
                            cursor: 'pointer',
                          }}
                        >
                          LIST
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <Row
                  label="SERVED MODEL"
                  value={
                    <ModelChip
                      model={pickedEndpoint?.servedModel ?? agent?.model ?? null}
                      provider={pickedEndpoint?.provider ?? providerFromAgent(agent)}
                    />
                  }
                />
                <div style={{ fontSize: 10.5, color: 'var(--tx3)' }}>
                  The app’s service principal needs CAN_QUERY on the endpoint, otherwise the agent shows as unreachable.
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <div style={LABEL}>HARNESS</div>
                    <select
                      style={{ ...FIELD, ...disabledStyle }}
                      value={draft.harness}
                      disabled={!editable}
                      onChange={(e) => {
                        const h = e.target.value;
                        setDraft((d) => ({
                          ...d,
                          harness: h,
                          provider: h ? (HARNESS_DEFAULT_PROVIDER[h] ?? d.provider) : d.provider,
                          model:
                            h && models?.harnessModels[h]
                              ? (models.harnessModels[h].find((m) => m.default)?.id ?? '')
                              : '',
                        }));
                        setCustomModel(false);
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
                  <div>
                    <div style={LABEL}>MODEL PROVIDER</div>
                    <select
                      style={{ ...FIELD, ...disabledStyle }}
                      value={draft.provider}
                      disabled={!editable}
                      onChange={(e) => set('provider', e.target.value)}
                    >
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
                  <div style={LABEL}>MODEL</div>
                  {harnessModels.length > 0 && !showCustomModel ? (
                    <select
                      style={{ ...FIELD, ...mono(400, 11.5), ...disabledStyle }}
                      value={draft.model}
                      disabled={!editable}
                      onChange={(e) => {
                        if (e.target.value === CUSTOM) {
                          setCustomModel(true);
                          set('model', '');
                          return;
                        }
                        set('model', e.target.value);
                      }}
                    >
                      <option value="">— harness default —</option>
                      {harnessModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} · {m.id}
                          {m.default ? ' (default)' : ''}
                        </option>
                      ))}
                      <option value={CUSTOM}>Other model id…</option>
                    </select>
                  ) : (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        style={{ ...FIELD, ...mono(400, 11.5), ...disabledStyle }}
                        value={draft.model}
                        disabled={!editable}
                        onChange={(e) => set('model', e.target.value)}
                        placeholder={draft.harness === 'codex' ? 'e.g. gpt-5.3-codex' : 'e.g. claude-opus-5'}
                        maxLength={80}
                      />
                      {harnessModels.length > 0 && editable && (
                        <button
                          className="hv-border"
                          onClick={() => {
                            setCustomModel(false);
                            set('model', '');
                          }}
                          style={{
                            ...mono(500, 9),
                            background: 'none',
                            border: '1px solid var(--line2)',
                            color: 'var(--tx2)',
                            borderRadius: 3,
                            padding: '0 10px',
                            cursor: 'pointer',
                          }}
                        >
                          LIST
                        </button>
                      )}
                    </div>
                  )}
                  {draft.model && (
                    <div style={{ marginTop: 6 }}>
                      <ModelChip model={draft.model} provider={draft.provider || null} />
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--tx3)', lineHeight: 1.5 }}>
                  The model is saved on the agent today; passing it to the harness at claim time is the next step
                  (registry delivery), so a running fleet keeps using its own default until then.
                </div>
              </>
            )}
          </Section>

          <Section
            title="MCP SERVERS & SKILLS"
            hint={registry ? 'from the registry — delivered at claim time' : 'registry unavailable'}
          >
            {endpointBacked && (
              <CopyField
                label="COMETLOOP MCP SERVER (ATTACH THIS TO THE AGENT)"
                value={mcpUrl()}
                toast={toast}
              />
            )}
            <div>
              <div style={LABEL}>MCP SERVERS</div>
              <AttachRow
                checked
                locked
                title="Cometloop"
                sub="built in · tickets, progress, flags, git credentials"
                tag="ALWAYS"
              />
              {(registry?.mcpServers ?? [])
                .filter((m) => m.status === 'published' || draft.mcpServers.includes(m.id))
                .map((m) => (
                  <AttachRow
                    key={m.id}
                    checked={draft.mcpServers.includes(m.id)}
                    disabled={!editable}
                    onToggle={() => toggleId('mcpServers', m.id)}
                    title={m.name}
                    sub={`${m.transport === 'http' ? m.url : [m.command, ...m.args].filter(Boolean).join(' ')}${m.requiresAuth ? ` · needs ${m.authEnv}` : ''}${m.status === 'retired' ? ' · RETIRED' : ''}`}
                    tag={m.engagementId ? (project?.client.toUpperCase() ?? 'PROJECT') : 'SHARED'}
                  />
                ))}
              {registry && registry.mcpServers.length === 0 && (
                <div style={{ fontSize: 10.5, color: 'var(--tx3)', marginTop: 4 }}>
                  Nothing published yet — add servers on the REGISTRY view.
                </div>
              )}
            </div>
            <div>
              <div style={LABEL}>SKILLS</div>
              {(registry?.skills ?? [])
                .filter((k) => k.status === 'published' || draft.skills.includes(k.id))
                .map((k) => {
                  const fits = endpointBacked || !draft.harness || k.harnesses.includes(draft.harness);
                  return (
                    <AttachRow
                      key={k.id}
                      checked={draft.skills.includes(k.id)}
                      disabled={!editable}
                      muted={!fits}
                      onToggle={() => toggleId('skills', k.id)}
                      title={k.name}
                      sub={`${k.description || k.slug}${fits ? '' : ` · not written for ${harnessBrand(draft.harness)?.label ?? draft.harness}`}${k.status === 'retired' ? ' · RETIRED' : ''}`}
                      tag={k.engagementId ? (project?.client.toUpperCase() ?? 'PROJECT') : 'SHARED'}
                      marks={k.harnesses}
                    />
                  );
                })}
              {registry && registry.skills.length === 0 && (
                <div style={{ fontSize: 10.5, color: 'var(--tx3)', marginTop: 4 }}>
                  Nothing published yet — add skills on the REGISTRY view.
                </div>
              )}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--tx3)', lineHeight: 1.5 }}>
              Attachments are saved on the agent now; runners materialize them into the task workdir at claim time (the
              next delivery step). Secrets never travel — a server that needs one is filled from the runner
              machine&apos;s own keychain.
            </div>
          </Section>

          {agent && (
            <Section title="ACTIVITY">
              <Row
                label="SOURCE"
                value={
                  agent.source === 'observed'
                    ? 'Observed — real runner from task history'
                    : state?.staged
                      ? 'Configured — rollout pending'
                      : 'Stored record · live status synced'
                }
              />
              <Row
                label="TASKS"
                value={agent.source === 'observed' ? `${agent.tasks} total · ${agent.activeTasks} active now` : '—'}
              />
              <Row
                label="TOKENS (24H)"
                value={
                  agent.tokens24h
                    ? `${fmtTokens(agent.tokens24h.input)} in · ${fmtTokens(agent.tokens24h.output)} out · ${fmtTokens(agent.tokens24h.cacheRead)} cached${agent.tokens24h.costUsd != null ? ` · $${agent.tokens24h.costUsd.toFixed(2)}` : ''}`
                    : '—'
                }
              />
              <Row label="LAST SEEN" value={agent.lastSeen ? relTime(agent.lastSeen) : '—'} />
              <Row label="FIRST SEEN" value={agent.createdAt ? relTime(agent.createdAt) : '—'} />
              {agent.role === 'pr-reviewer' && (
                <div style={{ fontSize: 11.5, color: 'var(--tx3)', lineHeight: 1.5 }}>
                  Runs when a linked PR opens on this project: the console sends the ticket, its acceptance criteria,
                  the diff and the CI status, then posts the verdict on the PR and the ticket. It never merges.
                </div>
              )}
            </Section>
          )}

          {agent && (
            <Section title="PERMISSIONS">
              <SecurityPanel
                key={agent.id}
                agent={agent}
                canEdit={lead}
                catalog={securityCatalog}
                onSaved={onSecuritySaved}
                toast={toast}
              />
            </Section>
          )}

          {agent && isGeneralCodingAgent(agent) && (
            <Section title="FLEET" hint="how work is shared between runners of this harness">
              <button
                className="hv-border"
                onClick={() => onLoadBalancing(agent)}
                style={{
                  ...mono(500, 9.5),
                  alignSelf: 'flex-start',
                  background: 'none',
                  border: '1px solid var(--line2)',
                  color: 'var(--tx2)',
                  borderRadius: 3,
                  padding: '6px 12px',
                  cursor: 'pointer',
                  letterSpacing: '.07em',
                }}
              >
                ⚖ LOAD BALANCING — {agent.harness?.toUpperCase()}
              </button>
            </Section>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 18px',
            borderTop: '1px solid var(--line)',
            flex: 'none',
          }}
        >
          {agent && lead && agent.recordId !== null && agent.source !== 'observed' && (
            <button
              className="hv-border"
              onClick={remove}
              style={{
                ...mono(500, 9),
                background: 'none',
                border: `1px solid ${confirmRemove ? 'var(--bad)' : 'var(--line2)'}`,
                color: confirmRemove ? 'var(--bad)' : 'var(--tx3)',
                borderRadius: 3,
                padding: '6px 10px',
                cursor: 'pointer',
                letterSpacing: '.07em',
              }}
            >
              {confirmRemove ? 'CONFIRM REMOVE' : 'REMOVE AGENT'}
            </button>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              className="hv-tx2"
              onClick={onClose}
              style={{
                ...mono(500, 10),
                background: 'none',
                border: '1px solid var(--line2)',
                color: 'var(--tx3)',
                borderRadius: 3,
                padding: '6px 12px',
                cursor: 'pointer',
                letterSpacing: '.06em',
              }}
            >
              {editable ? 'CANCEL' : 'CLOSE'}
            </button>
            {editable && (
              <button
                onClick={submit}
                disabled={busy || !dirty}
                style={{
                  ...mono(500, 10),
                  background: dirty ? 'var(--agent)' : 'none',
                  border: `1px solid ${dirty ? 'var(--agent)' : 'var(--line2)'}`,
                  color: dirty ? '#fff' : 'var(--tx3)',
                  borderRadius: 3,
                  padding: '6px 14px',
                  cursor: busy ? 'wait' : dirty ? 'pointer' : 'default',
                  letterSpacing: '.06em',
                  opacity: busy ? 0.7 : 1,
                }}
              >
                {busy ? 'SAVING…' : creating ? (endpointBacked ? 'ADD AGENT' : 'STAGE AGENT') : 'SAVE CHANGES'}
              </button>
            )}
          </div>
        </div>
      </motion.aside>
    </>
  );
}

/** One attachable registry entry: a checkbox row with scope tag and, for skills, the harness marks. */
function AttachRow({
  checked,
  locked,
  disabled,
  muted,
  onToggle,
  title,
  sub,
  tag,
  marks,
}: {
  checked: boolean;
  locked?: boolean;
  disabled?: boolean;
  muted?: boolean;
  onToggle?: () => void;
  title: string;
  sub: string;
  tag: string;
  marks?: string[];
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 0',
        borderBottom: '1px solid var(--line)',
        cursor: locked || disabled ? 'default' : 'pointer',
        opacity: muted ? 0.55 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={locked || disabled}
        onChange={onToggle}
        style={{ marginTop: 2, accentColor: 'var(--agent)' }}
      />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...mono(600, 11), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </span>
          {marks?.map((h) => {
            const b = harnessBrand(h);
            return b ? (
              <span key={h} title={b.label} style={{ display: 'inline-flex' }}>
                {b.mark(11)}
              </span>
            ) : null;
          })}
          <span
            style={{
              ...mono(500, 7.5),
              letterSpacing: '.08em',
              marginLeft: 'auto',
              color: tag === 'SHARED' ? 'var(--agent)' : tag === 'ALWAYS' ? 'var(--ok)' : 'var(--tx3)',
              border: `1px solid ${tag === 'SHARED' ? 'var(--agent)' : tag === 'ALWAYS' ? 'var(--ok)' : 'var(--line2)'}`,
              borderRadius: 3,
              padding: '1px 5px',
              flex: 'none',
            }}
          >
            {tag}
          </span>
        </span>
        <span
          style={{
            display: 'block',
            ...mono(400, 9.5),
            color: 'var(--tx3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sub}
        </span>
      </span>
    </label>
  );
}

function providerFromAgent(agent: ProjectAgent | null): string | null {
  return agent?.modelProvider ?? null;
}
