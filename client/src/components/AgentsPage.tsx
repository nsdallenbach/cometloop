import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { api } from '../api';
import type {
  AgentModelCatalog,
  AgentSecurityCatalog,
  AgentsOverview,
  AgentsOverviewProject,
  ProjectAgent,
} from '../types';
import { HEALTH_COLOR, mono } from '../util';
import { agentBrand, harnessBrand } from './AgentLogos';
import { AgentDrawer, ModelChip } from './AgentDrawer';
import { AgentMapLegend, AgentMapView } from './AgentMap';
import { LoadBalancingModal } from './AgentPanels';
import {
  agentState,
  fmtTokens,
  isEndpointBacked,
  isGeneralCodingAgent,
  relTime,
  ROLE_LABEL,
  TYPE_LABEL,
} from '../lib/agents';

/**
 * /agent-map — the Agents tab (DAT-278). Every agent the console knows about,
 * by project: observed runners from the work queue, registered endpoint
 * agents, staged runner configs. Two views of the same payload — a GRID of
 * cards (configure, secure, scope) and the architecture MAP — plus one drawer
 * that creates and configures agents.
 *
 * The page owns the data and refreshes it every 15s; the drawer and panels are
 * keyed by agent id so a poll never resets an edit in progress.
 */

type View = 'grid' | 'map';
type Kind = 'all' | 'runners' | 'endpoints';

const VIEW_KEY = 'eec-agents-view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'map' ? 'map' : 'grid';
  } catch {
    return 'grid';
  }
}

function Chip({
  active,
  onClick,
  children,
  title,
  color,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  color?: string;
}) {
  return (
    <button
      className="hv-border"
      onClick={onClick}
      title={title}
      style={{
        border: `1px solid ${active ? (color ?? 'var(--tx3)') : 'var(--line)'}`,
        background: active ? 'var(--bg3)' : 'transparent',
        color: active ? (color ?? 'var(--tx)') : 'var(--tx2)',
        borderRadius: 3,
        padding: '4px 9px',
        ...mono(500, 9.5),
        letterSpacing: '.06em',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function AgentCard({
  agent,
  canEdit,
  onOpen,
  onLoadBalancing,
}: {
  agent: ProjectAgent;
  canEdit: boolean;
  onOpen: () => void;
  onLoadBalancing: () => void;
}) {
  const brand = agentBrand(agent);
  const state = agentState(agent);
  const endpoint = isEndpointBacked(agent.agentType);
  const harness = harnessBrand(agent.harness);
  const kind = endpoint ? (TYPE_LABEL[agent.agentType] ?? agent.agentType) : (harness?.label.toUpperCase() ?? 'RUNNER');
  return (
    <motion.div
      layout
      layoutId={`agent-card-${agent.id}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: 'spring', visualDuration: 0.28, bounce: 0.18 }}
      className="hv-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      title={`${agent.name} — configure`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        background: 'var(--bg2)',
        border:
          state.disabled || state.unreachable
            ? '1px dashed var(--bad)'
            : state.staged
              ? '1px dashed var(--warn)'
              : '1px solid var(--line)',
        borderRadius: 6,
        padding: '12px 13px 11px',
        cursor: 'pointer',
        opacity: state.disabled ? 0.72 : 1,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div
          style={{
            position: 'relative',
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--bg3)',
            border: '1px solid var(--line2)',
            display: 'grid',
            placeItems: 'center',
            flex: 'none',
          }}
        >
          {brand ? (
            brand.mark(24)
          ) : (
            <span style={{ ...mono(700, 16), color: 'var(--agent)' }}>
              {(agent.harness ?? agent.modelProvider ?? agent.name).charAt(0).toUpperCase()}
            </span>
          )}
          <span
            style={{
              position: 'absolute',
              right: -3,
              top: -3,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: state.color,
              border: '2px solid var(--bg2)',
              animation: agent.status === 'active' && !state.disabled ? 'eec-pulse 2.4s infinite' : undefined,
            }}
          />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              ...mono(600, 12),
              letterSpacing: '.03em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {agent.name}
          </div>
          <div
            style={{
              ...mono(400, 8.5),
              color: state.disabled ? 'var(--bad)' : 'var(--tx3)',
              letterSpacing: '.08em',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {kind} · <span style={{ color: state.color }}>{state.label}</span>
          </div>
        </div>
        <span
          style={{
            ...mono(500, 8.5),
            letterSpacing: '.08em',
            color:
              agent.role === 'pr-reviewer' ? 'var(--agent)' : agent.role === 'planning' ? 'var(--acc)' : 'var(--tx3)',
            border: `1px solid ${agent.role === 'pr-reviewer' ? 'var(--agent)' : agent.role === 'planning' ? 'var(--acc)' : 'var(--line2)'}`,
            borderRadius: 3,
            padding: '2px 6px',
            flex: 'none',
          }}
        >
          {ROLE_LABEL[agent.role] ?? agent.role.toUpperCase()}
        </span>
      </div>

      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--tx2)', minWidth: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ ...mono(500, 8.5), color: 'var(--tx3)', letterSpacing: '.08em', width: 58, flex: 'none' }}>
            MODEL
          </span>
          <ModelChip model={agent.model} provider={agent.modelProvider} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ ...mono(500, 8.5), color: 'var(--tx3)', letterSpacing: '.08em', width: 58, flex: 'none' }}>
            {endpoint ? 'ENDPOINT' : 'HARNESS'}
          </span>
          <span
            style={{
              ...mono(400, 11),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: endpoint && !agent.endpointName ? 'var(--tx3)' : 'var(--tx)',
            }}
          >
            {endpoint ? (agent.endpointName ?? '—') : (harness?.label ?? agent.harness ?? '—')}
          </span>
        </div>
        {agent.description && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--tx3)',
              lineHeight: 1.45,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {agent.description}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 'auto',
          ...mono(400, 8.5),
          color: 'var(--tx3)',
          letterSpacing: '.06em',
          flexWrap: 'wrap',
        }}
      >
        {agent.source === 'observed' && (
          <span>
            {agent.tasks} TASK{agent.tasks === 1 ? '' : 'S'}
            {agent.activeTasks > 0 ? ` · ${agent.activeTasks} ACTIVE` : ''}
          </span>
        )}
        {agent.tokens24h && (
          <span title="Tokens in the last 24h">
            {fmtTokens(agent.tokens24h.input + agent.tokens24h.output)} TOK · 24H
            {agent.tokens24h.costUsd != null ? ` · $${agent.tokens24h.costUsd.toFixed(2)}` : ''}
          </span>
        )}
        {agent.lastSeen && <span>SEEN {relTime(agent.lastSeen).toUpperCase()}</span>}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          {isGeneralCodingAgent(agent) && (
            <button
              className="hv-border"
              onClick={(e) => {
                e.stopPropagation();
                onLoadBalancing();
              }}
              title="Runner load balancing for this harness"
              style={{
                ...mono(500, 8.5),
                background: 'none',
                border: '1px solid var(--line2)',
                color: 'var(--tx2)',
                borderRadius: 3,
                padding: '3px 7px',
                cursor: 'pointer',
                letterSpacing: '.07em',
              }}
            >
              ⚖ BALANCE
            </button>
          )}
          <button
            className="hv-border"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            style={{
              ...mono(500, 8.5),
              background: 'none',
              border: `1px solid ${canEdit ? 'var(--agent)' : 'var(--line2)'}`,
              color: canEdit ? 'var(--agent)' : 'var(--tx2)',
              borderRadius: 3,
              padding: '3px 8px',
              cursor: 'pointer',
              letterSpacing: '.07em',
            }}
          >
            {canEdit ? 'CONFIGURE' : 'DETAILS'}
          </button>
        </span>
      </div>
    </motion.div>
  );
}

function ProjectSection({
  project,
  agents,
  lead,
  onNewAgent,
  onOpen,
  onLoadBalancing,
}: {
  project: AgentsOverviewProject;
  agents: ProjectAgent[];
  lead: boolean;
  onNewAgent: () => void;
  onOpen: (agent: ProjectAgent) => void;
  onLoadBalancing: (agent: ProjectAgent) => void;
}) {
  const live = agents.filter((a) => a.status === 'active').length;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{ width: 8, height: 8, borderRadius: '50%', background: HEALTH_COLOR[project.health], flex: 'none' }}
        />
        <span style={{ ...mono(700, 11.5), letterSpacing: '.08em' }}>{project.client.toUpperCase()}</span>
        <span style={{ fontSize: 12, color: 'var(--tx2)' }}>{project.name}</span>
        <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em' }}>
          {agents.length} AGENT{agents.length === 1 ? '' : 'S'}
          {live > 0 ? ` · ${live} LIVE` : ''}
        </span>
        {lead && (
          <button
            className="hv-border"
            onClick={onNewAgent}
            style={{
              ...mono(500, 9),
              marginLeft: 'auto',
              background: 'none',
              border: '1px solid var(--agent)',
              color: 'var(--agent)',
              borderRadius: 3,
              padding: '4px 9px',
              cursor: 'pointer',
              letterSpacing: '.08em',
            }}
          >
            + NEW AGENT
          </button>
        )}
      </div>
      {agents.length === 0 ? (
        <div
          style={{
            border: '1px dashed var(--line2)',
            borderRadius: 6,
            padding: '18px 14px',
            ...mono(400, 9.5),
            color: 'var(--tx3)',
            letterSpacing: '.08em',
            textAlign: 'center',
          }}
        >
          {lead ? 'NO AGENTS ON THIS PROJECT — ADD ONE' : 'NO AGENTS ON THIS PROJECT YET'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          <AnimatePresence initial={false}>
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                canEdit={lead}
                onOpen={() => onOpen(a)}
                onLoadBalancing={() => onLoadBalancing(a)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

export function AgentsPage({
  canLead,
  toast,
}: {
  canLead: (engagementId: string) => boolean;
  toast: (msg: string) => void;
}) {
  const [data, setData] = useState<AgentsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(readView);
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [kind, setKind] = useState<Kind>('all');
  const [query, setQuery] = useState('');
  // Drawer: null = closed; { agent: null, projectId } = create; { agent } = configure.
  const [drawer, setDrawer] = useState<{ agent: ProjectAgent | null; projectId: string } | null>(null);
  const [loadBalanceAgent, setLoadBalanceAgent] = useState<ProjectAgent | null>(null);
  // Action ids, labels and preset scopes come from the server so the permission
  // model lives in one place; the panel degrades to humanized ids without it.
  const [securityCatalog, setSecurityCatalog] = useState<AgentSecurityCatalog | null>(null);
  const [models, setModels] = useState<AgentModelCatalog | null>(null);

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
    api
      .agentModels()
      .then(setModels)
      .catch(() => setModels(null));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // storage unavailable — the view just does not persist
    }
  }, [view]);

  const byProject = useMemo(() => {
    const m = new Map<string, ProjectAgent[]>();
    for (const a of data?.agents ?? []) {
      const list = m.get(a.engagementId) ?? [];
      list.push(a);
      m.set(a.engagementId, list);
    }
    return m;
  }, [data]);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (a: ProjectAgent) => {
      if (kind === 'runners' && a.agentType !== 'runner') return false;
      if (kind === 'endpoints' && a.agentType === 'runner') return false;
      if (!q) return true;
      return [a.name, a.model, a.harness, a.modelProvider, a.endpointName, a.role, a.description].some(
        (v) => v && v.toLowerCase().includes(q)
      );
    },
    [kind, q]
  );

  const visibleProjects = useMemo(
    () => (data?.projects ?? []).filter((p) => projectFilter === 'all' || p.id === projectFilter),
    [data, projectFilter]
  );
  const filteredByProject = useMemo(() => {
    const m = new Map<string, ProjectAgent[]>();
    for (const p of visibleProjects) {
      const list = (byProject.get(p.id) ?? []).filter(matches);
      // Runners first (they are the fleet), then endpoints; live before quiet.
      list.sort(
        (a, b) =>
          Number(isEndpointBacked(a.agentType)) - Number(isEndpointBacked(b.agentType)) ||
          Number(b.status === 'active') - Number(a.status === 'active') ||
          a.name.localeCompare(b.name)
      );
      m.set(p.id, list);
    }
    return m;
  }, [visibleProjects, byProject, matches]);

  const totals = useMemo(() => {
    const agents = data?.agents ?? [];
    return {
      agents: agents.length,
      live: agents.filter((a) => a.status === 'active').length,
      runners: agents.filter((a) => a.agentType === 'runner').length,
      endpoints: agents.filter((a) => a.agentType !== 'runner').length,
    };
  }, [data]);

  const leadAnywhere = (data?.projects ?? []).some((p) => canLead(p.id));
  const defaultProjectForNew = () => {
    if (projectFilter !== 'all' && canLead(projectFilter)) return projectFilter;
    return (data?.projects ?? []).find((p) => canLead(p.id))?.id ?? data?.projects[0]?.id ?? '';
  };
  const openAgent = (agent: ProjectAgent) => setDrawer({ agent, projectId: agent.engagementId });
  const openNew = (projectId: string) => setDrawer({ agent: null, projectId });

  // Keep the drawer's agent fresh after a reload (a saved security change or a
  // sync that assigned a record id) without remounting it.
  const drawerAgent = drawer?.agent ? (data?.agents.find((a) => a.id === drawer.agent?.id) ?? drawer.agent) : null;

  return (
    <div
      className="tab-pane"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: view === 'map' ? 'hidden' : 'auto',
        padding: '18px 22px 18px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', flex: 'none' }}>
        <span style={{ ...mono(700, 13), letterSpacing: '.12em' }}>AGENTS</span>
        {data && (
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
            {data.projects.length} PROJECT{data.projects.length === 1 ? '' : 'S'} · {totals.agents} AGENT
            {totals.agents === 1 ? '' : 'S'}
            {totals.live > 0 ? ` · ${totals.live} LIVE` : ''}
          </span>
        )}
        <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>
          {view === 'grid'
            ? 'Every agent by project. Open one to configure its model, scope and permissions.'
            : 'Architecture view — projects at the center, their agents as spokes. Click an agent to configure it.'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 3, overflow: 'hidden' }}>
            {(['grid', 'map'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-pressed={view === v}
                style={{
                  ...mono(500, 9.5),
                  letterSpacing: '.08em',
                  padding: '5px 11px',
                  border: 'none',
                  cursor: 'pointer',
                  background: view === v ? 'var(--bg3)' : 'transparent',
                  color: view === v ? 'var(--tx)' : 'var(--tx3)',
                }}
              >
                {v === 'grid' ? '▦ GRID' : '◎ MAP'}
              </button>
            ))}
          </div>
          {leadAnywhere && (
            <button
              className="hv-border"
              onClick={() => openNew(defaultProjectForNew())}
              style={{
                ...mono(500, 9.5),
                background: 'var(--agent)',
                border: '1px solid var(--agent)',
                color: '#fff',
                borderRadius: 3,
                padding: '5px 12px',
                cursor: 'pointer',
                letterSpacing: '.08em',
              }}
            >
              + NEW AGENT
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '12px 0 14px', flex: 'none' }}
      >
        {view === 'grid' ? (
          <>
            <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em' }}>PROJECT</span>
            <Chip active={projectFilter === 'all'} onClick={() => setProjectFilter('all')}>
              ALL
            </Chip>
            {(data?.projects ?? []).map((p) => (
              <Chip key={p.id} active={projectFilter === p.id} onClick={() => setProjectFilter(p.id)} title={p.name}>
                {p.client.toUpperCase()}
                <span style={{ color: 'var(--tx3)', marginLeft: 5 }}>{(byProject.get(p.id) ?? []).length}</span>
              </Chip>
            ))}
            <span style={{ width: 1, height: 16, background: 'var(--line)', margin: '0 4px' }} />
            <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em' }}>KIND</span>
            <Chip active={kind === 'all'} onClick={() => setKind('all')}>
              ALL
            </Chip>
            <Chip
              active={kind === 'runners'}
              onClick={() => setKind('runners')}
              title="Coding-agent runners (desktop clients and devboxes)"
            >
              RUNNERS <span style={{ color: 'var(--tx3)', marginLeft: 5 }}>{totals.runners}</span>
            </Chip>
            <Chip
              active={kind === 'endpoints'}
              onClick={() => setKind('endpoints')}
              title="Agent Bricks and model-serving endpoints"
            >
              ENDPOINTS <span style={{ color: 'var(--tx3)', marginLeft: 5 }}>{totals.endpoints}</span>
            </Chip>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by name, model, harness…"
              aria-label="Filter agents"
              style={{
                marginLeft: 'auto',
                width: 220,
                background: 'var(--bg)',
                border: '1px solid var(--line2)',
                borderRadius: 3,
                color: 'var(--tx)',
                fontSize: 11.5,
                padding: '5px 9px',
              }}
            />
          </>
        ) : (
          <AgentMapLegend />
        )}
      </div>

      {error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 12px',
            border: '1px solid var(--bad)',
            borderRadius: 4,
            color: 'var(--bad)',
            ...mono(400, 10.5),
            flex: 'none',
          }}
        >
          COULDN’T LOAD THE AGENTS: {error}
          <button
            onClick={() => void load()}
            style={{
              border: '1px solid var(--bad)',
              background: 'none',
              color: 'var(--bad)',
              borderRadius: 3,
              padding: '2px 9px',
              ...mono(500, 10),
              cursor: 'pointer',
              letterSpacing: '.06em',
            }}
          >
            RETRY
          </button>
        </div>
      )}

      {!data && !error && (
        <div
          style={{ padding: 60, textAlign: 'center', color: 'var(--tx3)', ...mono(400, 11), letterSpacing: '.08em' }}
        >
          LOADING…
        </div>
      )}

      {data && data.projects.length === 0 && (
        <div
          style={{ padding: 60, textAlign: 'center', color: 'var(--tx3)', ...mono(400, 11), letterSpacing: '.06em' }}
        >
          NO PROJECTS YET — CREATE AN ENGAGEMENT TO PUT AGENTS ON IT
        </div>
      )}

      {data && data.projects.length > 0 && view === 'grid' && (
        <LayoutGroup id="agents-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22, paddingBottom: 20 }}>
            {visibleProjects.map((p) => (
              <ProjectSection
                key={p.id}
                project={p}
                agents={filteredByProject.get(p.id) ?? []}
                lead={canLead(p.id)}
                onNewAgent={() => openNew(p.id)}
                onOpen={openAgent}
                onLoadBalancing={setLoadBalanceAgent}
              />
            ))}
            {q && visibleProjects.every((p) => (filteredByProject.get(p.id) ?? []).length === 0) && (
              <div
                style={{
                  padding: 30,
                  textAlign: 'center',
                  color: 'var(--tx3)',
                  ...mono(400, 10.5),
                  letterSpacing: '.06em',
                }}
              >
                NO AGENTS MATCH “{query}”
              </div>
            )}
          </div>
        </LayoutGroup>
      )}

      {data && data.projects.length > 0 && view === 'map' && (
        <AgentMapView
          data={data}
          agentsByProject={byProject}
          canLead={canLead}
          onNewAgent={(p) => openNew(p.id)}
          onSelectAgent={openAgent}
        />
      )}

      <AnimatePresence>
        {drawer && (
          <AgentDrawer
            key={drawerAgent?.id ?? `new-${drawer.projectId}`}
            agent={drawerAgent}
            projects={data?.projects ?? []}
            initialProjectId={drawer.projectId}
            canLead={canLead}
            securityCatalog={securityCatalog}
            models={models}
            toast={toast}
            onClose={() => setDrawer(null)}
            onSaved={(message) => {
              toast(message);
              setDrawer(null);
              void load();
            }}
            onRemoved={() => {
              setDrawer(null);
              void load();
            }}
            onSecuritySaved={(security) => {
              // Reflect the save on the open panel and the card behind it
              // immediately, rather than waiting for the next 15s poll.
              setData((d) =>
                d && drawerAgent
                  ? { ...d, agents: d.agents.map((a) => (a.id === drawerAgent.id ? { ...a, security } : a)) }
                  : d
              );
            }}
            onLoadBalancing={setLoadBalanceAgent}
          />
        )}
        {loadBalanceAgent && (
          <LoadBalancingModal
            key={loadBalanceAgent.id}
            agent={loadBalanceAgent}
            canEdit={canLead(loadBalanceAgent.engagementId)}
            onClose={() => setLoadBalanceAgent(null)}
            toast={toast}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
