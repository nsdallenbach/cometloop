import type { ReactNode } from 'react';

/**
 * Harness and model-provider logo marks for the /agent-map architecture map and
 * for runner avatars (RunnerLogo.tsx resolves a runner id against HARNESSES).
 * Resolution order per node: harness logo → model-provider logo → letter chip
 * (the chip is rendered by the caller when both lookups miss). All marks are
 * inline SVG approximations of the brands, sized by the caller, drawn to stay
 * legible at 20–40px on both themes.
 *
 * Every mark lives here so this module never imports from its consumers:
 * RunnerLogo depends on AgentLogos, never the reverse.
 */

export interface AgentBrand {
  /** Product name, for tooltips ("Claude Code"). */
  label: string;
  mark: (size: number) => ReactNode;
}

/**
 * The Claude Code pixel mascot ("Clawd") in the brand terracotta — NOT the
 * Claude starburst, which brands the Claude product rather than Claude Code.
 * Drawn as one even-odd path on a 20×14 pixel grid: body with side arms, two
 * eye cutouts (transparent, so the avatar background shows through), four
 * legs. Scales crisply with the avatar.
 */
export const CLAUDE_CODE: AgentBrand = {
  label: 'Claude Code',
  mark: (size) => (
    <svg width={size} height={size * 0.7} viewBox="0 0 20 14" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path
        fill="#D97757"
        fillRule="evenodd"
        d="M3,2 H17 V6 H20 V9 H17 V11 H3 V9 H0 V6 H3 Z
           M6,4 H8 V7 H6 Z
           M12,4 H14 V7 H12 Z
           M4,11 H5.5 V14 H4 Z
           M6.5,11 H8 V14 H6.5 Z
           M12,11 H13.5 V14 H12 Z
           M14.5,11 H16 V14 H14.5 Z"
      />
    </svg>
  ),
};

/** Six rounded petals in a hexagonal rosette — the OpenAI-style knot. */
const OPENAI_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    {[0, 60, 120, 180, 240, 300].map((a) => (
      <rect key={a} x={-2.1} y={-11} width={4.2} height={12.4} rx={2.1} transform={`rotate(${a})`} fill="none" stroke="var(--tx)" strokeWidth={1.7} />
    ))}
  </svg>
);

/** Anthropic's angular A mark, in the Claude terracotta. */
const ANTHROPIC_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <path
      fill="#D97757"
      d="M13.8 4h-3.9L3 20h4l1.3-3.4h6.3L15.9 20h4L13.8 4zm-4.2 9.4 1.9-5 1.9 5H9.6z"
    />
  </svg>
);

/** Gemini's curved four-point star, blue→violet. */
const GEMINI_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <defs>
      <linearGradient id="eec-gem" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stopColor="#4285F4" />
        <stop offset="100%" stopColor="#9B72CB" />
      </linearGradient>
    </defs>
    <path
      fill="url(#eec-gem)"
      d="M12 24c0-6.63-5.37-12-12-12 6.63 0 12-5.37 12-12 0 6.63 5.37 12 12 12-6.63 0-12 5.37-12 12z"
    />
  </svg>
);

/** Copilot-style goggles: a visor with two pill eyes. */
const COPILOT_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <rect x="2.5" y="6" width="19" height="12" rx="5" fill="none" stroke="var(--tx)" strokeWidth={1.8} />
    <rect x="7.2" y="9.2" width="3" height="5.6" rx="1.5" fill="var(--tx)" />
    <rect x="13.8" y="9.2" width="3" height="5.6" rx="1.5" fill="var(--tx)" />
  </svg>
);

/** Cursor's isometric cube. */
const CURSOR_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <path fill="var(--tx3)" d="M12 2 21 7v10l-9 5-9-5V7z" />
    <path fill="var(--tx)" d="M12 2v10l9 5V7z" />
    <path fill="var(--tx2)" d="M12 12 3 7v10l9 5z" />
  </svg>
);

/** Microsoft's four squares. */
const MICROSOFT_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <rect x="3" y="3" width="8.6" height="8.6" fill="#F25022" />
    <rect x="12.4" y="3" width="8.6" height="8.6" fill="#7FBA00" />
    <rect x="3" y="12.4" width="8.6" height="8.6" fill="#00A4EF" />
    <rect x="12.4" y="12.4" width="8.6" height="8.6" fill="#FFB900" />
  </svg>
);

/** Google's four-color G. */
const GOOGLE_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <path fill="#4285F4" d="M21.6 12.2c0-.7-.06-1.4-.18-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z" />
    <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.98 5.98 0 0 1-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
    <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z" />
    <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5L18.7 4.7A10 10 0 0 0 3.1 7.5l3.3 2.6A5.98 5.98 0 0 1 12 6z" />
  </svg>
);

/** Databricks' stacked lozenges in the brand red. */
const DATABRICKS_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <path fill="var(--acc)" d="M12 2 3 6.7l9 4.7 9-4.7z" opacity={0.55} />
    <path fill="var(--acc)" d="m3 10.2 9 4.7 9-4.7v3.1l-9 4.7-9-4.7z" opacity={0.8} />
    <path fill="var(--acc)" d="m3 15.5 9 4.7 9-4.7V18l-9 4.7L3 18z" />
  </svg>
);

/**
 * Agent Bricks: bricks in the Databricks orange-red, stacked in a half-bond so
 * the courses interlock. Databricks lozenge red (var(--acc)) ties it to the
 * platform marks above; the offset course is what tells it apart from the
 * plain Databricks logo at 20px.
 */
const AGENTBRICKS_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    {/* top course */}
    <rect x="3" y="3.6" width="8.4" height="5.2" rx="1.2" fill="var(--acc)" opacity={0.55} />
    <rect x="12.6" y="3.6" width="8.4" height="5.2" rx="1.2" fill="var(--acc)" opacity={0.55} />
    {/* middle course: offset half-bond */}
    <rect x="3" y="9.4" width="4" height="5.2" rx="1.2" fill="var(--acc)" opacity={0.8} />
    <rect x="8.2" y="9.4" width="8.4" height="5.2" rx="1.2" fill="var(--acc)" opacity={0.8} />
    <rect x="17.8" y="9.4" width="3.2" height="5.2" rx="1.2" fill="var(--acc)" opacity={0.8} />
    {/* base course */}
    <rect x="3" y="15.2" width="8.4" height="5.2" rx="1.2" fill="var(--acc)" />
    <rect x="12.6" y="15.2" width="8.4" height="5.2" rx="1.2" fill="var(--acc)" />
  </svg>
);

/**
 * Omnigent: a hub with four orbiting nodes — the "omni" fan-out of one hosted
 * service dispatching many agents. Drawn in the agent token so it reads as
 * fleet software rather than a vendor logo, and stays legible at 20px because
 * the nodes sit on the axes rather than clustering.
 */
const OMNIGENT_MARK = (size: number): ReactNode => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
    <circle cx="12" cy="12" r="7.4" fill="none" stroke="var(--agent)" strokeWidth={1.5} opacity={0.55} />
    <circle cx="12" cy="12" r="3" fill="var(--agent)" />
    <circle cx="12" cy="2.9" r="2.1" fill="var(--agent)" />
    <circle cx="21.1" cy="12" r="2.1" fill="var(--agent)" />
    <circle cx="12" cy="21.1" r="2.1" fill="var(--agent)" />
    <circle cx="2.9" cy="12" r="2.1" fill="var(--agent)" />
  </svg>
);

/** Codex reuses the OpenAI knot; the harness has no distinct mark. */
const HARNESSES: Record<string, AgentBrand> = {
  'claude-code': CLAUDE_CODE,
  codex: { label: 'Codex', mark: OPENAI_MARK },
  gemini: { label: 'Gemini CLI', mark: GEMINI_MARK },
  copilot: { label: 'GitHub Copilot', mark: COPILOT_MARK },
  cursor: { label: 'Cursor', mark: CURSOR_MARK },
  omnigent: { label: 'Omnigent', mark: OMNIGENT_MARK },
};

/** Anysphere (Cursor's maker) reuses the Cursor cube; it ships no separate mark. */
const PROVIDERS: Record<string, AgentBrand> = {
  anthropic: { label: 'Anthropic', mark: ANTHROPIC_MARK },
  openai: { label: 'OpenAI', mark: OPENAI_MARK },
  google: { label: 'Google', mark: GOOGLE_MARK },
  microsoft: { label: 'Microsoft', mark: MICROSOFT_MARK },
  anysphere: { label: 'Anysphere', mark: CURSOR_MARK },
  databricks: { label: 'Databricks', mark: DATABRICKS_MARK },
  // Omnigent is its own provider (hosted service, vendor-chosen model), so the
  // harness and provider marks are the same — as with Cursor/Anysphere.
  omnigent: { label: 'Omnigent', mark: OMNIGENT_MARK },
};

/** Node-kind marks: an Agent Bricks agent is branded by what it runs on. */
const AGENT_TYPES: Record<string, AgentBrand> = {
  agentbricks: { label: 'Agent Bricks', mark: AGENTBRICKS_MARK },
  'serving-endpoint': { label: 'Model Serving', mark: DATABRICKS_MARK },
};

/**
 * Harness → its default model provider, mirrored from the server's
 * HARNESS_PROVIDER (server/routes/agents.ts) so a node's provider fallback and
 * the deploy form agree with what the sync pass persists. One copy, here, next
 * to the brand tables; tests/harness-abstraction.test.ts pins it to the server.
 */
export const HARNESS_DEFAULT_PROVIDER: Record<string, string> = {
  'claude-code': 'anthropic',
  codex: 'openai',
  gemini: 'google',
  copilot: 'microsoft',
  cursor: 'anysphere',
  omnigent: 'omnigent',
};

const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_]+/g, '-');

export function harnessBrand(harness: string | null): AgentBrand | null {
  return harness ? (HARNESSES[norm(harness)] ?? null) : null;
}

export function providerBrand(provider: string | null): AgentBrand | null {
  return provider ? (PROVIDERS[norm(provider)] ?? null) : null;
}

export function agentTypeBrand(agentType: string | null): AgentBrand | null {
  return agentType ? (AGENT_TYPES[norm(agentType)] ?? null) : null;
}

/**
 * Node-kind logo first (an Agent Bricks agent is an Agent Bricks agent whatever
 * model it serves), then harness, then model provider; null → letter chip.
 */
export function agentBrand(a: { agentType?: string | null; harness: string | null; modelProvider: string | null }): AgentBrand | null {
  return agentTypeBrand(a.agentType ?? null) ?? harnessBrand(a.harness) ?? providerBrand(a.modelProvider);
}

/** Selectable harnesses for the deploy form, in display order. */
export const HARNESS_OPTIONS = Object.entries(HARNESSES).map(([id, b]) => ({ id, label: b.label }));

/** Selectable model providers for the deploy form, in display order. */
export const PROVIDER_OPTIONS = Object.entries(PROVIDERS).map(([id, b]) => ({ id, label: b.label }));
