import type { CSSProperties } from 'react';
import type { ProjectAgent } from '../types';
import { mono } from '../util';

/**
 * Non-component helpers shared by the Agents page, its drawer, panels and the
 * map. Kept out of the .tsx modules so React fast refresh stays whole-file.
 */

export const FIELD: CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--line2)',
  borderRadius: 3,
  color: 'var(--tx)',
  fontSize: 12,
  padding: '7px 9px',
};

export const LABEL: CSSProperties = { ...mono(500, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 4 };

export const TYPE_LABEL: Record<string, string> = {
  runner: 'RUNNER',
  'serving-endpoint': 'SERVING ENDPOINT',
  agentbricks: 'AGENT BRICKS',
  foundry: 'FOUNDRY AGENT',
};

export const ROLE_LABEL: Record<string, string> = {
  delivery: 'DELIVERY',
  'pr-reviewer': 'PR REVIEWER',
  planning: 'PLANNING',
  other: 'AGENT',
};

const GENERAL_CODING_MODELS = new Set(['claude-code', 'codex', 'omnigent', 'gemini', 'copilot', 'cursor']);

/** Runners whose harness is a general coding agent get load balancing across the fleet. */
export const isGeneralCodingAgent = (agent: Pick<ProjectAgent, 'agentType' | 'harness'>) =>
  agent.agentType === 'runner' && Boolean(agent.harness && GENERAL_CODING_MODELS.has(agent.harness.toLowerCase()));

export const isEndpointBacked = (agentType: string) => agentType === 'agentbricks' || agentType === 'serving-endpoint';

/** The console's own MCP server — what an AgentBricks agent attaches to. */
export const mcpUrl = () => `${window.location.origin}/api/mcp`;

/** Compact token counts: 1234 → 1.2k, 2500000 → 2.5M. */
export function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function relTime(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - +new Date(iso)) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 48) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export interface AgentVisualState {
  staged: boolean;
  unreachable: boolean;
  disabled: boolean;
  color: string;
  label: string;
}

/**
 * Dashed = staged (a runner config awaiting rollout) or an unreachable
 * endpoint. 'offline' is amber rather than the neutral grey 'idle' wears: a
 * runner that has stopped polling is a fact worth seeing, not a resting state
 * (DAT-224). A security-disabled agent reads as blocked wherever it appears —
 * it is the one state that overrides "looks healthy" (DAT-212).
 */
export function agentState(agent: ProjectAgent): AgentVisualState {
  const unreachable = agent.status === 'unreachable';
  const staged = agent.source === 'configured' && !['active', 'idle', 'offline', 'unreachable'].includes(agent.status);
  const disabled = !agent.security.enabled;
  return {
    staged,
    unreachable,
    disabled,
    color:
      disabled || unreachable
        ? 'var(--bad)'
        : agent.status === 'active'
          ? 'var(--ok)'
          : agent.status === 'offline' || staged
            ? 'var(--warn)'
            : 'var(--tx3)',
    label: disabled ? 'DISABLED' : staged ? 'STAGED' : agent.status.toUpperCase(),
  };
}
