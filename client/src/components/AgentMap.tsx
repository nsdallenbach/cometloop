import { motion } from 'motion/react';
import type { AgentsOverview, AgentsOverviewProject, ProjectAgent } from '../types';
import { HEALTH_COLOR, mono } from '../util';
import { agentBrand } from './AgentLogos';
import { agentState, isGeneralCodingAgent, ROLE_LABEL, TYPE_LABEL } from '../lib/agents';
import { MAP_LINKS_CLASS, MAP_MARK_CLASS, MapViewport } from './MapViewport';

/**
 * The architecture map — the MAP view of the Agents page (AgentsPage.tsx).
 * Every project renders as a central hub node with its agents as spokes
 * around it: observed runners (from the work queue), endpoint-backed agents
 * built in AgentBricks or Model Serving and registered here, and staged runner
 * configs awaiting fleet rollout.
 *
 * This is a pure view: the page owns the data, the drawer and the modals, and
 * passes down what a hub or spoke click should do.
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

/** Spoke positions: first node at 12 o'clock, then evenly around the ellipse. */
function spokeXY(i: number, count: number, g: ClusterGeom): { x: number; y: number } {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
  const r = g.stagger && i % 2 === 1 ? 1.16 : 1;
  return { x: g.cx + g.rx * r * Math.cos(a), y: g.cy + g.ry * r * Math.sin(a) };
}

/** Empty-project spoke: a hub with no agents yet still needs somewhere to look. */
function EmptySpoke({ x, y, lead }: { x: number; y: number; lead: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x - 62,
        top: y - 30,
        width: 124,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        opacity: 0.75,
      }}
    >
      <div
        className={MAP_MARK_CLASS}
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
      <div style={{ ...mono(400, 8), color: 'var(--tx3)', letterSpacing: '.08em', textAlign: 'center' }}>
        {lead ? 'NO AGENTS — ADD ONE' : 'NO AGENTS YET'}
      </div>
    </div>
  );
}

function AgentSpoke({
  agent,
  x,
  y,
  onSelect,
}: {
  agent: ProjectAgent;
  x: number;
  y: number;
  onSelect: (agent: ProjectAgent) => void;
}) {
  const brand = agentBrand(agent);
  const { staged, unreachable, disabled, color: statusColor } = agentState(agent);
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
          ? `${agent.name} — disabled by security settings; click to configure`
          : `${agent.name} — click to configure${isGeneralCodingAgent(agent) ? ' (load balancing inside)' : ''}`
      }
      onClick={() => onSelect(agent)}
      style={{
        position: 'absolute',
        left: x - 62,
        top: y - 30,
        width: 124,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        cursor: 'pointer',
      }}
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
            disabled || unreachable
              ? '1px dashed var(--bad)'
              : staged
                ? '1px dashed var(--warn)'
                : '1px solid var(--line2)',
          display: 'grid',
          placeItems: 'center',
          opacity: disabled ? 0.55 : 1,
        }}
      >
        {brand ? (
          brand.mark(22)
        ) : (
          <span style={{ ...mono(700, 15), color: 'var(--agent)' }}>
            {(agent.harness ?? agent.modelProvider ?? agent.name).charAt(0).toUpperCase()}
          </span>
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
      <div
        style={{
          ...mono(400, 8),
          color: disabled ? 'var(--bad)' : 'var(--tx3)',
          letterSpacing: '.08em',
          textTransform: 'uppercase',
        }}
      >
        {sub}
        {disabled ? ' · DISABLED' : staged ? ' · STAGED' : ` · ${agent.status.toUpperCase()}`}
      </div>
    </motion.div>
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
              ? agentState(agent)
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
                  disabled || unreachable
                    ? 'var(--bad)'
                    : active
                      ? 'var(--agent)'
                      : staged
                        ? 'var(--warn)'
                        : 'var(--line2)'
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
        )
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
          <span
            style={{ width: 7, height: 7, borderRadius: '50%', background: HEALTH_COLOR[project.health], flex: 'none' }}
          />
          <span
            style={{
              ...mono(700, 11),
              letterSpacing: '.06em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project.client}
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--tx2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {project.name}
        </div>
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

/** Legend for the map's node states, including the not-yet-live node kinds. */
export function AgentMapLegend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 'none' }}>
      {[
        { label: 'LIVE', dot: 'var(--ok)', dashed: false },
        { label: 'IDLE', dot: 'var(--tx3)', dashed: false },
        { label: 'OFFLINE', dot: 'var(--warn)', dashed: false },
        { label: 'CONFIGURED — ROLLOUT PENDING', dot: 'var(--warn)', dashed: true },
        { label: 'ENDPOINT UNREACHABLE', dot: 'var(--bad)', dashed: true },
        { label: 'DISABLED BY SECURITY', dot: 'var(--bad)', dashed: true },
      ].map((l) => (
        <span
          key={l.label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            border: `1px ${l.dashed ? 'dashed' : 'solid'} var(--line2)`,
            borderRadius: 3,
            padding: '3px 8px',
            ...mono(400, 8.5),
            color: 'var(--tx2)',
            letterSpacing: '.07em',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: l.dot }} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

export function AgentMapView({
  data,
  agentsByProject,
  canLead,
  onNewAgent,
  onSelectAgent,
}: {
  data: AgentsOverview;
  agentsByProject: Map<string, ProjectAgent[]>;
  canLead: (engagementId: string) => boolean;
  onNewAgent: (project: AgentsOverviewProject) => void;
  onSelectAgent: (agent: ProjectAgent) => void;
}) {
  return (
    <MapViewport>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {data.projects.map((p) => (
          <ProjectCluster
            key={p.id}
            project={p}
            agents={agentsByProject.get(p.id) ?? []}
            lead={canLead(p.id)}
            onNewAgent={() => onNewAgent(p)}
            onSelectAgent={onSelectAgent}
          />
        ))}
      </div>
    </MapViewport>
  );
}
