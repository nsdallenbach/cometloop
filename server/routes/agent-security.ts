import type express from 'express';
import { z } from 'zod';
import type { Caller } from './roles';

/**
 * Per-agent security controls (DAT-212). Every agent on the map carries a
 * `security_settings` object on app.project_agents: a master enable switch plus
 * the set of actions it is permitted to execute. The console edits it from the
 * agent's detail panel on /agents; the runner endpoints and the PR review gate
 * enforce it at the moment an action executes.
 *
 * Two rules shape the whole design:
 *
 * - **No silent lockouts.** An agent with no stored settings (a runner claiming
 *   for the first time, a row written before this feature) is treated as the
 *   safe baseline for its role, not as denied. The baseline is exactly what
 *   agents could already do before this ticket — it removes nothing and grants
 *   nothing new.
 * - **No wedged tickets.** Disabling or narrowing an agent stops it starting new
 *   work and cuts its privileges; it never strands a run already in flight.
 *   Winding down a held task — progress notes, flags, completion — is
 *   deliberately not gateable, so a ticket always closes out instead of sitting
 *   claimed until the STALLED detector notices. A lead who wants a live run
 *   stopped cancels it on the board.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * The gateable actions. Each maps to a real execution point in this codebase —
 * an entry here without an enforcement call site would be a lie on the security
 * panel:
 *
 *   claim_work     → POST /api/agent/work/claim
 *   git_credential → POST /api/agent/work/:id/git-credential
 *   coordination   → POST /api/agent/coordination/messages | /branches
 *   pr_review      → runPrReview() invoking the engagement's review agent
 */
export const AGENT_ACTIONS = ['claim_work', 'git_credential', 'coordination', 'pr_review'] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

/** Panel copy — what a lead is actually granting when they tick a box. */
export const AGENT_ACTION_LABELS: Record<AgentAction, string> = {
  claim_work: 'Claim queued tickets and start runs',
  git_credential: 'Receive short-lived repository write credentials',
  coordination: 'Message other agents and announce branch activity',
  pr_review: 'Publish automated PR review verdicts',
};

export const ACCESS_LEVELS = ['restricted', 'standard', 'elevated', 'custom'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * Preset scopes. 'standard' is what a delivery runner does end to end today;
 * 'elevated' adds the review gate. 'restricted' grants nothing — a restricted
 * agent can only wind down a task it already holds.
 */
export const ACCESS_LEVEL_ACTIONS: Record<Exclude<AccessLevel, 'custom'>, AgentAction[]> = {
  restricted: [],
  standard: ['claim_work', 'git_credential', 'coordination'],
  elevated: [...AGENT_ACTIONS],
};

export interface AgentSecuritySettings {
  enabled: boolean;
  accessLevel: AccessLevel;
  allowedActions: AgentAction[];
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * The safe baseline: exactly the scopes an agent of this role already exercises,
 * so the rollout removes nothing and grants nothing new.
 *
 * Role-aware on purpose. A pr-reviewer agent without 'pr_review' would stop
 * reviewing PRs the moment this shipped (a lockout); handing every delivery
 * runner the review scope, or the review agent the repo credentials it never
 * asks for, would over-permission the fleet. So the review gate gets its own
 * two scopes and delivery agents get 'standard'.
 */
export function baselineSecurity(role: string): AgentSecuritySettings {
  const reviewer = role === 'pr-reviewer';
  return {
    enabled: true,
    accessLevel: reviewer ? 'custom' : 'standard',
    allowedActions: reviewer ? ['coordination', 'pr_review'] : [...ACCESS_LEVEL_ACTIONS.standard],
    updatedBy: null,
    updatedAt: null,
  };
}

const isAction = (v: unknown): v is AgentAction => typeof v === 'string' && (AGENT_ACTIONS as readonly string[]).includes(v);
const isLevel = (v: unknown): v is AccessLevel => typeof v === 'string' && (ACCESS_LEVELS as readonly string[]).includes(v);

/** Actions in catalog order, deduplicated — stored lists stay comparable. */
function orderActions(actions: AgentAction[]): AgentAction[] {
  return AGENT_ACTIONS.filter((a) => actions.includes(a));
}

/**
 * Read whatever is in the column (JSONB object, JSON string, null, or a row
 * written before this feature) and return usable settings. A partial or corrupt
 * object falls back field by field to the role baseline rather than denying
 * everything — a bad write must not lock an agent out of the fleet.
 */
export function parseSecuritySettings(raw: unknown, role = 'delivery'): AgentSecuritySettings {
  const base = baselineSecurity(role);
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
  } catch {
    return base;
  }
  if (Object.keys(obj).length === 0) return base;

  const accessLevel = isLevel(obj.accessLevel) ? obj.accessLevel : base.accessLevel;
  const listed = Array.isArray(obj.allowedActions) ? obj.allowedActions.filter(isAction) : null;
  // Presets are authoritative: the stored list is only consulted for 'custom',
  // so a preset can never drift from what its label promises.
  const allowedActions =
    accessLevel === 'custom' ? orderActions(listed ?? base.allowedActions) : [...ACCESS_LEVEL_ACTIONS[accessLevel]];
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : base.enabled,
    accessLevel,
    allowedActions,
    updatedBy: typeof obj.updatedBy === 'string' && obj.updatedBy ? obj.updatedBy : null,
    updatedAt: typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : null,
  };
}

export const SecurityUpdateBody = z.object({
  enabled: z.boolean().optional(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
  allowedActions: z.array(z.enum(AGENT_ACTIONS)).max(AGENT_ACTIONS.length).optional(),
});
export type SecurityUpdate = z.infer<typeof SecurityUpdateBody>;

/**
 * Merge an edit onto current settings. A preset access level always rewrites the
 * action list from the preset; 'custom' takes the submitted list. Sending a list
 * without an access level implies 'custom' — that is what ticking a box in the
 * panel means.
 */
export function mergeSecurityUpdate(current: AgentSecuritySettings, update: SecurityUpdate, actor: string): AgentSecuritySettings {
  const accessLevel: AccessLevel = update.accessLevel ?? (update.allowedActions ? 'custom' : current.accessLevel);
  const allowedActions =
    accessLevel === 'custom'
      ? orderActions(update.allowedActions ?? current.allowedActions)
      : [...ACCESS_LEVEL_ACTIONS[accessLevel]];
  return {
    enabled: update.enabled ?? current.enabled,
    accessLevel,
    allowedActions,
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
}

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Column plus the rollout migration, spread into PROJECT_AGENTS_SCHEMA_SQL so it
 * runs wherever that table is created. app.project_agents is owned by the app
 * service principal (DAT-203), so the boot ALTER succeeds — no dev-migrate entry
 * needed (see docs/development-standards.md).
 *
 * The backfill writes the role-aware baseline onto every existing row exactly
 * once: pr-reviewer agents keep the review scope they are already exercising,
 * everything else lands on 'standard'. Rows a lead has already edited are left
 * alone, so a rerun cannot silently re-grant a revoked scope.
 */
export const AGENT_SECURITY_SCHEMA_SQL = [
  `ALTER TABLE app.project_agents ADD COLUMN IF NOT EXISTS security_settings JSONB NOT NULL DEFAULT '{}'`,
  `UPDATE app.project_agents SET security_settings = '${JSON.stringify(baselineSecurity('pr-reviewer'))}'::jsonb
   WHERE role = 'pr-reviewer' AND (security_settings IS NULL OR security_settings::text = '{}')`,
  `UPDATE app.project_agents SET security_settings = '${JSON.stringify(baselineSecurity('delivery'))}'::jsonb
   WHERE (role IS NULL OR role <> 'pr-reviewer') AND (security_settings IS NULL OR security_settings::text = '{}')`,
];

export interface StoredAgent {
  id: number;
  name: string;
  role: string;
  security: AgentSecuritySettings;
}

/**
 * The stored record for a named agent on an engagement, if there is one.
 * Observed runners are upserted into project_agents by the agent-map sync, so
 * this resolves for real runners too — but a runner claiming before its first
 * sync has no row yet, which is why every caller falls back to the baseline.
 */
export async function findAgentRecord(q: Query, engagementId: string, agentName: string): Promise<StoredAgent | null> {
  const row = (
    await q('SELECT id, name, role, security_settings FROM app.project_agents WHERE engagement_id = $1 AND lower(name) = lower($2)', [
      engagementId,
      agentName,
    ])
  ).rows[0];
  if (!row) return null;
  const role = txt(row.role) || 'delivery';
  return {
    id: typeof row.id === 'number' ? row.id : Number(row.id) || 0,
    name: txt(row.name),
    role,
    security: parseSecuritySettings(row.security_settings, role),
  };
}

/**
 * The engagement an agent is currently working, from its active claim. The
 * coordination endpoints identify an agent by name only, and they already
 * require an active claim under that name, so this always resolves for a legal
 * caller. Null means there is nothing to scope the check to — callers treat that
 * as "allow", because refusing on a lookup miss would be a lockout.
 */
export async function activeEngagementFor(q: Query, agentName: string): Promise<string | null> {
  const row = (
    await q(`SELECT engagement_id FROM app.agent_tasks WHERE agent = $1 AND state IN ('claimed','working') ORDER BY id DESC LIMIT 1`, [
      agentName,
    ])
  ).rows[0];
  return row ? txt(row.engagement_id) || null : null;
}

/** Settings in force for an agent — the stored ones, or the role baseline. */
export async function loadAgentSecurity(q: Query, engagementId: string, agentName: string): Promise<AgentSecuritySettings> {
  const record = await findAgentRecord(q, engagementId, agentName);
  return record?.security ?? baselineSecurity('delivery');
}

export interface SecurityDecision {
  allowed: boolean;
  /** Operator-readable reason, sent to the agent as the rejection message. */
  reason: string;
  settings: AgentSecuritySettings;
}

/** Decide a single action against already-loaded settings (pure — easy to test). */
export function decideAction(settings: AgentSecuritySettings, action: AgentAction, agentName: string): SecurityDecision {
  if (!settings.enabled) {
    return {
      allowed: false,
      reason: `Agent '${agentName}' is disabled in its security settings — a lead must re-enable it on the agent map before it can ${AGENT_ACTION_LABELS[action].toLowerCase()}.`,
      settings,
    };
  }
  if (!settings.allowedActions.includes(action)) {
    return {
      allowed: false,
      reason: `Agent '${agentName}' is not permitted to ${AGENT_ACTION_LABELS[action].toLowerCase()} — its access level is '${settings.accessLevel}'. A lead can widen the permission scope on the agent map.`,
      settings,
    };
  }
  return { allowed: true, reason: '', settings };
}

/**
 * Enforcement entry point for the execution paths: load the agent's settings and
 * decide. Denials are logged and written to the engagement feed so a blocked
 * action is visible to humans, not just to the agent that got the 403.
 */
export async function checkAgentAction(
  q: Query,
  input: { engagementId: string; agent: string; action: AgentAction; detail?: string },
): Promise<SecurityDecision> {
  // Fail open on a lookup error, for the same reason a missing record does: a
  // transient database blip must not wedge a claimed ticket or strand the fleet.
  // The denial path below is what a real 'no' looks like.
  let settings: AgentSecuritySettings;
  try {
    settings = await loadAgentSecurity(q, input.engagementId, input.agent);
  } catch (err) {
    console.warn(`[agent-security] settings lookup failed for '${input.agent}' on ${input.engagementId}, allowing ${input.action}:`, (err as Error).message);
    return { allowed: true, reason: '', settings: baselineSecurity('delivery') };
  }
  const decision = decideAction(settings, input.action, input.agent);
  if (!decision.allowed) {
    console.warn(`[agent-security] denied ${input.action} for '${input.agent}' on ${input.engagementId}${input.detail ? ` (${input.detail})` : ''}`);
    await q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
       VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
      [
        input.engagementId,
        `⛔ Blocked ${input.agent} — ${input.action.replace(/_/g, ' ')}${input.detail ? ` (${input.detail})` : ''}. ${decision.reason}`,
      ],
    ).catch((err: unknown) => console.warn('[agent-security] feed write failed:', (err as Error).message));
  }
  return decision;
}

/**
 * Enforce inside an Express handler: sends 403 with the reason and returns false
 * when the action is denied. Callers stop on false.
 */
export async function enforceAgentAction(
  res: express.Response,
  q: Query,
  input: { engagementId: string; agent: string; action: AgentAction; detail?: string },
): Promise<boolean> {
  const decision = await checkAgentAction(q, input);
  if (decision.allowed) return true;
  res.status(403).json({ error: decision.reason, action: input.action, agent: input.agent });
  return false;
}

/**
 * Persist an edit. Returns null when no such agent is on the project; the caller
 * has already authorized the change (leads and admins only — same bar as
 * registering or removing an agent).
 */
export async function saveAgentSecurity(
  q: Query,
  engagementId: string,
  agentId: number,
  update: SecurityUpdate,
  actor: string,
): Promise<{ agent: StoredAgent; settings: AgentSecuritySettings } | null> {
  const row = (
    await q('SELECT id, name, role, security_settings FROM app.project_agents WHERE id = $1 AND engagement_id = $2', [
      agentId,
      engagementId,
    ])
  ).rows[0];
  if (!row) return null;
  const role = txt(row.role) || 'delivery';
  const current = parseSecuritySettings(row.security_settings, role);
  const next = mergeSecurityUpdate(current, update, actor);
  await q('UPDATE app.project_agents SET security_settings = $2 WHERE id = $1', [agentId, JSON.stringify(next)]);
  return { agent: { id: agentId, name: txt(row.name), role, security: next }, settings: next };
}

/** Human summary of a settings change, for the feed and the audit log. */
export function describeChange(before: AgentSecuritySettings, after: AgentSecuritySettings, agentName: string): string {
  const bits: string[] = [];
  if (before.enabled !== after.enabled) bits.push(after.enabled ? 'enabled' : 'disabled');
  if (before.accessLevel !== after.accessLevel) bits.push(`access level ${before.accessLevel} → ${after.accessLevel}`);
  const added = after.allowedActions.filter((a) => !before.allowedActions.includes(a));
  const removed = before.allowedActions.filter((a) => !after.allowedActions.includes(a));
  if (added.length > 0) bits.push(`granted ${added.join(', ')}`);
  if (removed.length > 0) bits.push(`revoked ${removed.join(', ')}`);
  return bits.length > 0 ? `Security settings for ${agentName}: ${bits.join('; ')}.` : `Security settings for ${agentName} re-saved with no change.`;
}

export function setupAgentSecurityRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
) {
  /**
   * The catalog behind the security panel — actions, labels and preset scopes —
   * so the client never hard-codes a second copy of the permission model.
   */
  app.get('/api/agents/security/catalog', (_req, res) => {
    res.json({
      actions: AGENT_ACTIONS.map((id) => ({ id, label: AGENT_ACTION_LABELS[id] })),
      accessLevels: ACCESS_LEVELS,
      presets: ACCESS_LEVEL_ACTIONS,
    });
  });

  /** Read one agent's settings. Readable by anyone who can see the map. */
  app.get('/api/projects/:id/agents/:agentId/security', async (req, res) => {
    try {
      const row = (
        await q('SELECT id, name, role, security_settings FROM app.project_agents WHERE id = $1 AND engagement_id = $2', [
          Number(req.params.agentId),
          req.params.id,
        ])
      ).rows[0];
      if (!row) {
        res.status(404).json({ error: 'Agent not found on this project' });
        return;
      }
      const role = txt(row.role) || 'delivery';
      res.json({ agentId: Number(req.params.agentId), name: txt(row.name), security: parseSecuritySettings(row.security_settings, role) });
    } catch (err) {
      console.error('read agent security failed:', err);
      res.status(500).json({ error: 'Failed to read the agent security settings' });
    }
  });

  /**
   * Update one agent's settings. Lead/admin only — an agent cannot widen its own
   * scope, and a developer cannot widen anyone's.
   */
  app.put('/api/projects/:id/agents/:agentId/security', async (req, res) => {
    const parsed = SecurityUpdateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid security settings' });
      return;
    }
    try {
      const engagementId = req.params.id;
      const who = await requireLead(req, res, engagementId);
      if (!who) return;
      const agentId = Number(req.params.agentId);
      const existing = (
        await q('SELECT role, security_settings FROM app.project_agents WHERE id = $1 AND engagement_id = $2', [agentId, engagementId])
      ).rows[0];
      if (!existing) {
        res.status(404).json({ error: 'Agent not found on this project' });
        return;
      }
      const before = parseSecuritySettings(existing.security_settings, txt(existing.role) || 'delivery');
      const saved = await saveAgentSecurity(q, engagementId, agentId, parsed.data, who.email);
      if (!saved) {
        res.status(404).json({ error: 'Agent not found on this project' });
        return;
      }
      const summary = describeChange(before, saved.settings, saved.agent.name);
      console.log(`[agent-security] ${who.email} updated '${saved.agent.name}' on ${engagementId} — ${summary}`);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [engagementId, summary],
      ).catch((err: unknown) => console.warn('[agent-security] feed write failed:', (err as Error).message));
      res.json({ agentId, name: saved.agent.name, security: saved.settings });
    } catch (err) {
      console.error('update agent security failed:', err);
      res.status(500).json({ error: 'Failed to update the agent security settings' });
    }
  });
}
