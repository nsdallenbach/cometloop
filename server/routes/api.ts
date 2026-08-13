import { z } from 'zod';
import express, { Application } from 'express';
import { extractSowText } from './extract-text';
import { resolveIdentity, type Identity } from './roles';
import { REPO_SCHEMA_SQL, setupRepoRoutes, startRepoPolling } from './repos';
import { setupGithubAppRoutes } from './github-app';
import { AGENT_SCHEMA_SQL, setupAgentRoutes, startMockRunner } from './agent-work';
import { PROJECT_AGENTS_SCHEMA_SQL, setupProjectAgentRoutes } from './agents';
import { setupAgentSecurityRoutes } from './agent-security';
import { RUNNER_LOAD_BALANCING_SCHEMA_SQL, setupRunnerLoadBalancingRoutes } from './runner-load-balancing';
import { projectAccessGuard } from './project-access';
import { COORDINATION_SCHEMA_SQL, setupCoordinationRoutes } from './coordination';
import { TOOL_CALL_SCHEMA_SQL, setupToolCallRoutes } from './tool-calls';
import { setupPrConflictRoutes } from './pr-conflicts';
import { PR_REVIEW_SCHEMA_SQL, setupPrReviewRoutes } from './pr-review';
import { PR_REQUEUE_SCHEMA_SQL } from './pr-requeue';
import { PR_ESCALATION_SCHEMA_SQL, setupPrEscalationRoutes, startEscalationPolling } from './pr-escalation';
import { setupContextFileRoutes } from './context-files';
import { ATTACHMENT_SCHEMA_SQL, deleteAttachmentFiles, setupTicketAttachmentRoutes } from './ticket-attachments';
import { STANDARDS_SCHEMA_SQL, setupStandardsRoutes } from './standards';
import { ESTIMATE_SCHEMA_SQL, estimateTicket, recordActualHours, setupEstimateRoutes } from './estimates';
import {
  NEEDS_ESTIMATE_TAG,
  PROVISIONAL_EST_HOURS,
  PROVISIONAL_HUMAN_EST_HOURS,
  clearNeedsEstimateFlag,
  ensureTicketHours,
  setupTicketHoursRoutes,
} from './ticket-hours';
import { invokeModel, setupLlmHealthRoutes } from './llm-health';
import { normalizeTags } from './ticket-tags';
import { REPO_CONNECTED_JOIN, doneBlockedReason, gateInputFromRow, loadDeployGates } from './deploy-gate';
import { LINKS_SCHEMA_SQL, setupTicketLinkRoutes } from './ticket-links';
import { consolidatedTail, mergeAcceptanceCriteria, setupTicketConsolidateRoutes } from './ticket-consolidate';
import { commentStyleBrief } from './comment-style';
import { setupMcpRoutes } from './mcp';
import { extractText, refinePlan, refineTicketWithBoard, type RefinedPlan, type ScopingAction } from './scoping-agent';
import {
  PLANNING_REVIEW_COLUMNS_SQL,
  PLANNING_REVIEW_SCHEMA_SQL,
  beginPlanningReview,
  clearPlanningReview,
  planningReviewJoin,
  startPlanningReviewSweep,
  withPlanningReview,
} from './planning-review';
import { setupTicketOrderRoutes } from './ticket-order';
import { clipText, installUtf8BodyRecovery } from './utf8-body';
import { setupVelocityRoutes } from './velocity';
import {
  TICKET_EVENTS_SCHEMA_SQL,
  TICKET_EVENTS_BACKFILL_SQL,
  recordTicketEvent,
  computeBurndown,
} from './ticket-events';
import { TICKET_REVIEW_SCHEMA_SQL, setupTicketReviewRoutes } from './ticket-review';
import { createNotification, mentionedEmails, NOTIFICATION_SCHEMA_SQL, setupNotificationRoutes } from './notifications';
import { SEED_ENGAGEMENTS, SEED_TICKETS, SEED_SOURCES, SEED_FEED, SEED_TEAM, SEED_SUGGESTIONS } from './seed-data';

interface AppKitServices {
  lakebase: {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  };
  server: {
    extend(fn: (app: Application) => void): void;
  };
  files(key: string): {
    upload(filePath: string, contents: Buffer, options?: { overwrite?: boolean }): Promise<void>;
    download(filePath: string): Promise<{ contents?: ReadableStream }>;
    list(
      directoryPath?: string
    ): Promise<{ name?: string; path?: string; is_directory?: boolean; file_size?: number; last_modified?: number }[]>;
    delete(filePath: string): Promise<void>;
  };
  serving(alias: string): {
    invoke(body: unknown): Promise<unknown>;
  };
}

const SCHEMA_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE IF NOT EXISTS app.engagements (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    name TEXT NOT NULL,
    health TEXT NOT NULL,
    health_reason TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    phase TEXT NOT NULL,
    pct INT NOT NULL DEFAULT 0,
    burn INT NOT NULL DEFAULT 0,
    plan INT NOT NULL DEFAULT 0,
    next_milestone TEXT NOT NULL DEFAULT '',
    blockers INT NOT NULL DEFAULT 0,
    sow_status TEXT NOT NULL DEFAULT 'SIGNED',
    dates TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL DEFAULT '',
    hours TEXT NOT NULL DEFAULT '',
    team_size INT NOT NULL DEFAULT 0,
    rm_start TEXT,
    rm_end TEXT,
    phases JSONB,
    milestones JSONB,
    composer TEXT NOT NULL DEFAULT '',
    pushed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.tickets (
    key TEXT PRIMARY KEY,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'backlog',
    assignee TEXT NOT NULL DEFAULT '—',
    est TEXT NOT NULL DEFAULT '—',
    workstream TEXT NOT NULL DEFAULT '',
    agent BOOLEAN NOT NULL DEFAULT false,
    sources JSONB NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    ac JSONB NOT NULL DEFAULT '[]',
    blocked BOOLEAN NOT NULL DEFAULT false,
    tags JSONB NOT NULL DEFAULT '[]',
    -- DAT-195: time estimates are mandatory. Fresh installs enforce here; the
    -- existing dev-owned database gets the same NOT NULL via dev-migrate.cjs
    -- (a boot ALTER on app.tickets would be rejected — see ownership rule).
    est_hours REAL NOT NULL,
    human_est_hours REAL NOT NULL,
    seq SERIAL,
    done_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
  )`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS branch TEXT`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ`,
  // Pre-migration done tickets have no completion time; stamp them at first
  // boot so they age out of the Done lane 24h from now instead of vanishing.
  `UPDATE app.tickets SET done_at = NOW() WHERE status = 'done' AND done_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS app.sources (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    status_color TEXT NOT NULL DEFAULT 'ok',
    last_sync TEXT NOT NULL DEFAULT '',
    chunks INT NOT NULL DEFAULT 0,
    linked INT NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS app.team_members (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL,
    skills JSONB NOT NULL DEFAULT '[]',
    load INT NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS team_members_email_unique ON app.team_members (LOWER(email)) WHERE email IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS app.suggestions (
    id TEXT PRIMARY KEY,
    ticket TEXT NOT NULL,
    person TEXT NOT NULL,
    rationale TEXT NOT NULL,
    decision TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS app.engagement_members (
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    member_id INT NOT NULL REFERENCES app.team_members(id) ON DELETE CASCADE,
    PRIMARY KEY (engagement_id, member_id)
  )`,
  `CREATE TABLE IF NOT EXISTS app.engagement_leads (
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    PRIMARY KEY (engagement_id, email)
  )`,
  `CREATE TABLE IF NOT EXISTS app.ticket_comments (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.feed_items (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id),
    actor TEXT NOT NULL,
    text TEXT NOT NULL,
    time_label TEXT NOT NULL,
    source TEXT,
    reversible BOOLEAN NOT NULL DEFAULT false,
    reverted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Roadmap linkage: tickets attach to a roadmap item (phase name) and carry
  // effort in LLM-hours; per-engagement settings translate hours to days.
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS roadmap_item TEXT`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS est_hours REAL`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS human_est_hours REAL`,
  `ALTER TABLE app.engagements ADD COLUMN IF NOT EXISTS roadmap_settings JSONB`,
];

async function initSchema(appkit: AppKitServices) {
  // Statements run independently: legacy tables the app SP doesn't own can
  // reject an ALTER without blocking migrations on the tables it does own.
  for (const sql of [
    ...SCHEMA_SQL,
    ...NOTIFICATION_SCHEMA_SQL,
    ...REPO_SCHEMA_SQL,
    ...AGENT_SCHEMA_SQL,
    ...PROJECT_AGENTS_SCHEMA_SQL,
    ...RUNNER_LOAD_BALANCING_SCHEMA_SQL,
    ...TOOL_CALL_SCHEMA_SQL,
    ...COORDINATION_SCHEMA_SQL,
    ...STANDARDS_SCHEMA_SQL,
    ...TICKET_EVENTS_SCHEMA_SQL,
    ...LINKS_SCHEMA_SQL,
    ...ESTIMATE_SCHEMA_SQL,
    ...ATTACHMENT_SCHEMA_SQL,
    ...PR_REVIEW_SCHEMA_SQL,
    ...PR_REQUEUE_SCHEMA_SQL,
    ...PR_ESCALATION_SCHEMA_SQL,
    ...PLANNING_REVIEW_SCHEMA_SQL,
    ...TICKET_REVIEW_SCHEMA_SQL,
  ]) {
    try {
      await appkit.lakebase.query(sql);
    } catch (err) {
      console.warn(
        `[api] schema statement failed (${sql.slice(0, 60).replace(/\s+/g, ' ')}…):`,
        (err as Error).message
      );
    }
  }
  const { rows } = await appkit.lakebase.query('SELECT 1 FROM app.engagements LIMIT 1');
  if (rows.length > 0) {
    await backfillMemberships(appkit);
    return;
  }
  // Never resurrect the demo portfolio in a live database that was intentionally
  // emptied — seeding is opt-in for fresh demo environments only.
  if (process.env.EEC_SEED_DEMO !== '1') {
    console.log('[api] Empty database; demo seed skipped (set EEC_SEED_DEMO=1 to seed)');
    return;
  }
  console.log('[api] Seeding demo data');
  for (const e of SEED_ENGAGEMENTS) {
    await appkit.lakebase.query(
      `INSERT INTO app.engagements
       (id, client, name, health, health_reason, owner, phase, pct, burn, plan, next_milestone, blockers,
        sow_status, dates, value, hours, team_size, rm_start, rm_end, phases, milestones, composer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        e.id,
        e.client,
        e.name,
        e.health,
        e.health_reason,
        e.owner,
        e.phase,
        e.pct,
        e.burn,
        e.plan,
        e.next_milestone,
        e.blockers,
        e.sow_status,
        e.dates,
        e.value,
        e.hours,
        e.team_size,
        e.rm_start,
        e.rm_end,
        e.phases ? JSON.stringify(e.phases) : null,
        e.milestones ? JSON.stringify(e.milestones) : null,
        e.composer,
      ]
    );
  }
  for (const t of SEED_TICKETS) {
    const seedEst = seedEstimates(t.est);
    await appkit.lakebase.query(
      `INSERT INTO app.tickets (key, engagement_id, title, status, assignee, est, workstream, agent, sources, description, ac, blocked, est_hours, human_est_hours, done_at)
       VALUES ($1,'cav',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $3 = 'done' THEN NOW() END)`,
      [
        t.key,
        t.title,
        t.status,
        t.assignee,
        t.est,
        t.workstream,
        t.agent,
        JSON.stringify(t.sources),
        t.description,
        JSON.stringify(t.ac),
        t.blocked,
        seedEst.estHours,
        seedEst.humanEstHours,
      ]
    );
  }
  for (const s of SEED_SOURCES) {
    await appkit.lakebase.query(
      `INSERT INTO app.sources (engagement_id, name, type, status, status_color, last_sync, chunks, linked)
       VALUES ('cav',$1,$2,$3,$4,$5,$6,$7)`,
      [s.name, s.type, s.status, s.status_color, s.last_sync, s.chunks, s.linked]
    );
  }
  for (const f of SEED_FEED) {
    await appkit.lakebase.query(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
       VALUES ('cav',$1,$2,$3,$4,$5)`,
      [f.actor, f.text, f.time_label, f.source, f.reversible]
    );
  }
  for (const m of SEED_TEAM) {
    await appkit.lakebase.query(`INSERT INTO app.team_members (name, role, skills, load) VALUES ($1,$2,$3,$4)`, [
      m.name,
      m.role,
      JSON.stringify(m.skills),
      m.load,
    ]);
  }
  for (const g of SEED_SUGGESTIONS) {
    await appkit.lakebase.query(`INSERT INTO app.suggestions (id, ticket, person, rationale) VALUES ($1,$2,$3,$4)`, [
      g.id,
      g.ticket,
      g.person,
      g.rationale,
    ]);
  }
  // The seeded tickets need baseline events too — the schema-time backfill ran before they existed.
  await appkit.lakebase.query(TICKET_EVENTS_BACKFILL_SQL);
  console.log('[api] Seed complete');
  await backfillMemberships(appkit);
}

/** One-time: assign the full seeded bench to the Cavendish demo engagement. */
async function backfillMemberships(appkit: AppKitServices) {
  const { rows } = await appkit.lakebase.query('SELECT 1 FROM app.engagement_members LIMIT 1');
  if (rows.length > 0) return;
  await appkit.lakebase.query(
    `INSERT INTO app.engagement_members (engagement_id, member_id)
     SELECT 'cav', id FROM app.team_members
     WHERE EXISTS (SELECT 1 FROM app.engagements WHERE id = 'cav')
     ON CONFLICT DO NOTHING`
  );
}

// ---------- LLM helpers ----------
// extractText / refinePlan / refineTicketWithBoard live in scoping-agent.ts;
// the board tools they can call are shared with the MCP endpoint (mcp.ts).

/**
 * Fold a board-aware refinement back into a ticket row: append the verbatim
 * original request, and when the scoping loop consolidated other tickets into
 * this one mid-flight, carry the "## Consolidated from" sections and merged
 * AC across the description rewrite instead of dropping them.
 */
function foldPlanIntoTicket(
  plan: RefinedPlan,
  original: string,
  currentRow: Record<string, unknown> | undefined,
  actions: ScopingAction[]
): { description: string; ac: string[] } {
  let description = plan.description
    ? `${plan.description}\n\n## Original request\n\n> ${original.replace(/\n/g, '\n> ')}`
    : original;
  let ac = plan.ac;
  const consolidated = actions.some((a) => a.tool === 'consolidate_tickets' && a.ok);
  if (consolidated && currentRow) {
    const tail = consolidatedTail(typeof currentRow.description === 'string' ? currentRow.description : '');
    if (tail && plan.description) description = `${description}\n\n${tail}`;
    const rowAc = (() => {
      try {
        const raw: unknown = typeof currentRow.ac === 'string' ? JSON.parse(currentRow.ac) : (currentRow.ac ?? []);
        return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === 'string' && a.trim().length > 0) : [];
      } catch {
        return [];
      }
    })();
    ac = mergeAcceptanceCriteria(plan.ac, rowAc);
  }
  return { description, ac };
}

/** Phase/roadmap-item names from an engagement row's phases JSONB, defensively parsed. */
function roadmapItemNames(phasesRaw: unknown): string[] {
  try {
    const arr: unknown = typeof phasesRaw === 'string' ? JSON.parse(phasesRaw) : phasesRaw;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) =>
        p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string'
          ? (p as { name: string }).name
          : ''
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Default roadmap item when the model doesn't pick one: the phase whose window contains today, else the last not-yet-started phase, else null. */
function activeRoadmapItem(phasesRaw: unknown): string | null {
  try {
    const arr: unknown = typeof phasesRaw === 'string' ? JSON.parse(phasesRaw) : phasesRaw;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    const phases = arr.filter(
      (p): p is { name: string; s: string; e: string } =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as { name?: unknown }).name === 'string' &&
        typeof (p as { s?: unknown }).s === 'string' &&
        typeof (p as { e?: unknown }).e === 'string'
    );
    const current = phases.find((p) => p.s <= today && today <= p.e);
    if (current) return current.name;
    const upcoming = phases.find((p) => p.s > today);
    if (upcoming) return upcoming.name;
    return phases[phases.length - 1]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Comment-driven refinement: while no runner has ever picked up a ticket, a
 * new comment is treated as feedback on the plan. The ticket is re-planned
 * with the feedback applied and the planning agent replies in the thread —
 * tagging the commenter, then a short markdown note on what changed (DAT-204:
 * bulleted once there are three or more changes, so the reply is skimmable in
 * the drawer). Runs in the background after the comment posts; any failure
 * leaves the comment as a plain comment.
 */
async function applyCommentFeedback(
  appkit: AppKitServices,
  key: string,
  author: string,
  feedback: string
): Promise<void> {
  const q = (text: string, params?: unknown[]) => appkit.lakebase.query(text, params);
  const t = (await q('SELECT * FROM app.tickets WHERE key = $1', [key])).rows[0];
  if (!t) return;
  if (!['backlog', 'progress', 'proposed'].includes(String(t.status))) return;
  // "Never picked up": no runner has ever claimed work on this ticket.
  const picked = (
    await q(
      `SELECT 1 FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('claimed','working','done','failed') LIMIT 1`,
      [key]
    )
  ).rows;
  if (picked.length > 0) return;
  // Both eligibility gates have passed, so a rework really is starting: raise
  // the "agent reviewing" flag (DAT-218) for the rest of the pass. Everything
  // below runs in the background after the comment 201, so the flag is the
  // only thing telling the board this ticket is about to change.
  await withPlanningReview(q, { key, engagementId: String(t.engagement_id), flow: 'comment-rework' }, () =>
    reworkFromComment(q, appkit, t, key, author, feedback),
  );
}

/** The model round-trip and write-back behind {@link applyCommentFeedback}. */
async function reworkFromComment(
  q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  appkit: AppKitServices,
  t: Record<string, unknown>,
  key: string,
  author: string,
  feedback: string,
): Promise<void> {
  const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
  const existingAc = (() => {
    try {
      const raw: unknown = typeof t.ac === 'string' ? JSON.parse(t.ac) : (t.ac ?? []);
      return Array.isArray(raw) ? (raw as unknown[]).map((a) => asText(a)).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();

  const response = await invokeModel(appkit.serving.bind(appkit), q, 'comment-rework', {
    messages: [
      {
        role: 'user',
        content: [
          'You are the delivery-planning agent for a consulting delivery board. A team member left feedback on a planned ticket that no agent has started yet. Update the ticket to incorporate the feedback.',
          'Respond with ONLY a JSON object, no code fences:',
          '{"title": "concise title, max 10 words, plain text", "description": "markdown", "acceptance_criteria": ["testable outcome", ...], "reply": "markdown telling the commenter what you changed — no jargon, no filler"}',
          [
            'The reply is posted straight into the ticket thread and rendered as markdown, so a reader has to be able to skim it.',
            commentStyleBrief(),
            'One change → one sentence, no bullets. Three or more changes → a one-line lead-in, then one bullet each. Escape the newlines, so as a JSON string value that reads:',
            '"reply": "Tightened the scope to the staging config.\\n\\n- **Dropped** the production rollout step\\n- Added an AC for `staging.yaml` validation\\n- Kept the rollback plan as-is"',
          ].join('\n'),
          'Keep the description in the planned format (## Context / ## Approach / ## Dependencies). If the current description contains an "## Original request" section, keep it verbatim at the end. If it contains a ```mermaid diagram, keep it — updated to reflect the reworked plan — unless the feedback removes the need for it. Change only what the feedback calls for; keep everything else as-is.',
          'Current title:',
          asText(t.title),
          'Current description:',
          asText(t.description).trim() || '(empty)',
          'Current acceptance criteria:',
          existingAc.length > 0 ? existingAc.map((a) => `- ${a}`).join('\n') : '(none)',
          'Feedback comment:',
          feedback,
        ].join('\n\n'),
      },
    ],
    max_tokens: 2000,
  }, { engagementId: String(t.engagement_id), ticketKey: key });
  const text = extractText(response);
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) return;
  const plan = JSON.parse(jsonMatch[0]) as {
    title?: unknown;
    description?: unknown;
    acceptance_criteria?: unknown;
    reply?: unknown;
  };
  const title =
    typeof plan.title === 'string' && plan.title.trim() ? clipText(plan.title.trim(), 200) : asText(t.title);
  const description =
    typeof plan.description === 'string' && plan.description.trim() ? plan.description.trim() : asText(t.description);
  const ac = Array.isArray(plan.acceptance_criteria)
    ? plan.acceptance_criteria.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 10)
    : existingAc;
  // 1200, not 600: a bulleted reply needs the headroom, and clipping mid-list
  // item is exactly the unreadable output DAT-204 set out to remove.
  const reply = typeof plan.reply === 'string' && plan.reply.trim() ? clipText(plan.reply.trim(), 1200) : 'Updated the ticket based on your comment.';

  console.log(`[api] comment feedback applied to ${key} — plan updated (${ac.length} AC)`);
  await q(`UPDATE app.tickets SET title = $2, description = $3, ac = $4, updated_at = NOW() WHERE key = $1`, [
    key,
    title,
    description,
    JSON.stringify(ac),
  ]);
  await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
    key,
    'Planning Agent',
    `@${author} — ${reply}`,
  ]);
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
    [String(t.engagement_id), `Planning agent reworked ${key} from ${author}'s feedback.`]
  );
}

function parseJsonBlock(text: string): unknown {
  const stripped = text.replace(/```json/gi, '```').split('```');
  const candidate = stripped.length >= 2 ? stripped[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('the model response contained no JSON object');
  const body = candidate.slice(start);
  try {
    return JSON.parse(body.slice(0, body.lastIndexOf('}') + 1));
  } catch {
    // Truncated output: cut back to the last complete value and close any
    // brackets left open, retrying at earlier cut points if needed.
    let cut = body.length;
    for (let attempt = 0; attempt < 5; attempt++) {
      cut = body.lastIndexOf('}', cut - 1);
      if (cut <= 0) break;
      const slice = body.slice(0, cut + 1);
      const closers: string[] = [];
      let inString = false;
      let escaped = false;
      for (const ch of slice) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = !inString;
        } else if (!inString) {
          if (ch === '{') closers.push('}');
          else if (ch === '[') closers.push(']');
          else if (ch === '}' || ch === ']') closers.pop();
        }
      }
      try {
        const repaired = JSON.parse(slice + closers.reverse().join('')) as unknown;
        console.warn('[api] model JSON was truncated; repaired at cut point', cut);
        return repaired;
      } catch {
        // try an earlier cut point
      }
    }
    throw new Error('the model returned an incomplete plan (output was truncated)');
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ProposalPlanSchema = z.object({
  phases: z
    .array(z.object({ name: z.string(), s: z.string().regex(ISO_DATE), e: z.string().regex(ISO_DATE) }))
    .min(2)
    .max(6),
  milestones: z
    .array(z.object({ label: z.string(), d: z.string().regex(ISO_DATE) }))
    .max(8)
    .optional(),
  proposals: z
    .array(z.object({ title: z.string(), phase: z.string(), est: z.string(), source: z.string() }))
    .min(4)
    .max(24),
  summary: z.string().optional(),
});

// ---------- routes ----------

// Exported for the required-estimates unit tests (DAT-195).
export const PatchTicketBody = z.object({
  status: z.enum(['backlog', 'progress', 'review', 'done', 'proposed', 'dismissed']).optional(),
  assignee: z.string().optional(),
  // Matches the ceiling refined plans can reach; the description doubles as
  // the agent prompt, so edits keep the raw markdown untouched.
  description: z.string().max(20000).optional(),
  roadmapItem: z.string().max(120).nullable().optional(),
  // DAT-195: estimates can be revised but never cleared — null is rejected.
  estHours: z.number().gt(0).max(400).optional(),
  humanEstHours: z.number().gt(0).max(999).optional(),
  // Git refs cap out around 255 bytes; empty string clears the manual value so
  // the card falls back to the branch of the latest linked PR.
  branch: z.string().trim().max(255).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

const BulkBody = z.object({
  keys: z.array(z.string()).min(1),
  // Tags are excluded: a bulk patch replaces the whole tag list, which is
  // never what "tag these N tickets" means. Tags are edited per-ticket.
  // Description likewise — overwriting N bodies with one text is never intended.
  patch: PatchTicketBody.omit({ tags: true, description: true }),
});

const SuggestionBody = z.object({ decision: z.enum(['acc', 'ovr']) });

/** How ticket effort (LLM agent-hours) translates into roadmap days. */
const RoadmapSettingsBody = z.object({
  hoursPerDay: z.number().min(0.5).max(24),
  bufferPct: z.number().min(0).max(200),
  workdaysPerWeek: z.number().min(1).max(7),
});

const ComposerBody = z.object({ text: z.string() });

const ParseBody = z
  .object({
    path: z.string().optional(),
    description: z.string().min(30).max(20000).optional(),
    client: z.string(),
    name: z.string(),
  })
  .refine((b) => b.path || b.description, {
    message: 'Either an uploaded document path or a project description is required',
  });

const CreateEngagementBody = z.object({
  client: z.string().min(1),
  name: z.string().min(1),
  sowFile: z.string().optional(),
  phases: z.array(z.object({ name: z.string(), s: z.string(), e: z.string() })),
  milestones: z.array(z.object({ label: z.string(), d: z.string() })).optional(),
  proposals: z.array(z.object({ title: z.string(), phase: z.string(), est: z.string(), source: z.string() })).min(1),
});

const MembersBody = z.object({ memberIds: z.array(z.number().int()).max(50) });

const NewMemberBody = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().max(254),
  role: z.string().min(1).max(80),
});

const CommentBody = z.object({ body: z.string().min(1).max(4000) });

export const CreateTicketBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    assignee: z.string().max(80).optional(),
    est: z.string().max(16).optional(),
    workstream: z.string().max(80).optional(),
    // DAT-207: estimates are the ticket agent's job, so they are optional on
    // the wire — omit them and the agent fills them in at creation (see
    // ticket-hours.ts). Supplied values are still honoured verbatim, which is
    // why they stay range-checked and can never be an explicit null.
    estHours: z.number().gt(0).max(400).optional(),
    humanEstHours: z.number().gt(0).max(999).optional(),
  })
  .refine((b) => b.title?.trim() || b.description?.trim(), { message: 'A title or description is required' })
  // All-or-nothing: a lone figure would either be clobbered by the agent's
  // pair or leave a half-human/half-model estimate nobody can interpret.
  .refine((b) => (b.estHours == null) === (b.humanEstHours == null), {
    message: 'Supply both estimates or neither',
    path: ['estHours'],
  });

/** True when any validation issue is about the estimate fields. */
function hasEstimateIssue(error: z.ZodError): boolean {
  return error.issues.some((i) => i.path[0] === 'estHours' || i.path[0] === 'humanEstHours');
}

/**
 * Deterministic estimates for server-seeded tickets (engagement-setup
 * proposals, demo seed) now that est_hours/human_est_hours are NOT NULL
 * (DAT-195): an hour-suffixed est label is taken at face value; anything
 * else (day labels, '—') defaults to 1 agent-hour, with the human figure at
 * the DAT-175 4× fallback ratio. User/agent creates carry real values.
 */
export function seedEstimates(est?: string): { estHours: number; humanEstHours: number } {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*h$/i.exec(est?.trim() ?? '');
  const estHours = m ? Math.min(400, Math.max(0.1, Number(m[1]))) : 1;
  return { estHours, humanEstHours: Math.min(999, Math.round(estHours * 4 * 10) / 10) };
}

/** Fallback title when the model is unavailable: first line, clipped at a word boundary. */
function fallbackTitle(description: string): string {
  const line = description.split('\n').find((l) => l.trim()) ?? 'New ticket';
  const clean = line.replace(/^[#*\->\s]+/, '').trim();
  if (clean.length <= 80) return clean || 'New ticket';
  const cut = clipText(clean, 80); // surrogate-safe: never cuts an emoji in half
  return `${clipText(cut, Math.max(cut.lastIndexOf(' '), 40))}…`;
}

function requestAuthor(req: express.Request): string {
  const h = req.headers['x-forwarded-preferred-username'] ?? req.headers['x-forwarded-email'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.trim() ? v.trim() : 'You';
}

export async function setupApiRoutes(appkit: AppKitServices) {
  try {
    await initSchema(appkit);
  } catch (err) {
    console.warn('[api] Database setup failed:', (err as Error).message);
    console.warn('[api] Routes will be registered but may return errors until permissions are fixed');
  }

  const q = appkit.lakebase.query.bind(appkit.lakebase);

  /** Sends 403 and returns null unless the caller is an admin. */
  const requireAdmin = async (req: express.Request, res: express.Response): Promise<Identity | null> => {
    const id = await resolveIdentity(req);
    if (id.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' });
      return null;
    }
    return id;
  };

  /** Sends 403 and returns null unless the caller is an admin or a lead assigned to the engagement. */
  const requireLead = async (
    req: express.Request,
    res: express.Response,
    engagementId: string | null
  ): Promise<Identity | null> => {
    const id = await resolveIdentity(req);
    if (id.role === 'admin') return id;
    if (id.role === 'lead' && engagementId) {
      const { rows } = await q(
        'SELECT 1 FROM app.engagement_leads WHERE engagement_id = $1 AND LOWER(email) = LOWER($2)',
        [engagementId, id.email]
      );
      if (rows.length > 0) return id;
    }
    res.status(403).json({ error: 'Engagement lead access required for this project' });
    return null;
  };

  /** Any lead or admin (for actions not tied to an existing engagement, e.g. creating one). */
  const requireAnyLead = async (req: express.Request, res: express.Response): Promise<Identity | null> => {
    const id = await resolveIdentity(req);
    if (id.role === 'admin' || id.role === 'lead') return id;
    res.status(403).json({ error: 'Engagement lead access required' });
    return null;
  };
  const requireProjectAccess = projectAccessGuard(q, resolveIdentity);

  const ticketEngagement = async (key: string): Promise<string | null> => {
    const { rows } = await q('SELECT engagement_id FROM app.tickets WHERE key = $1', [key]);
    return rows.length > 0 ? String(rows[0].engagement_id) : null;
  };

  appkit.server.extend((app) => {
    // DAT-198: strict UTF-8 body decode with Windows-1252 recovery, ahead of
    // the stock JSON parser — legacy-codepage clients must not write mojibake.
    installUtf8BodyRecovery(app);

    app.get('/api/me', async (req, res) => {
      try {
        const id = await resolveIdentity(req);
        const leadOf = (await q('SELECT engagement_id FROM app.engagement_leads WHERE LOWER(email) = LOWER($1)', [id.email])).rows.map(
          (r) => String(r.engagement_id),
        );
        const memberOf = (
          await q(
            `SELECT em.engagement_id FROM app.engagement_members em
             JOIN app.team_members tm ON tm.id = em.member_id
             WHERE LOWER(tm.email) = LOWER($1)`,
            [id.email],
          )
        ).rows.map((r) => String(r.engagement_id));
        res.json({ ...id, leadOf, memberOf });
      } catch (err) {
        console.error('me failed:', err);
        res.status(500).json({ error: 'Failed to resolve identity' });
      }
    });

    // ---- portfolio / workspace reads ----
    app.get('/api/engagements', async (_req, res) => {
      try {
        const { rows } = await q('SELECT * FROM app.engagements ORDER BY created_at, id');
        res.json(rows);
      } catch (err) {
        console.error('list engagements failed:', err);
        res.status(500).json({ error: 'Failed to load engagements' });
      }
    });

    app.get('/api/engagements/:id/detail', async (req, res) => {
      try {
        const id = req.params.id;
        // Latest tracked deploy per ticket rides along so board cards can show
        // pipeline progress while the ticket holds in Review, the active PR
        // (open one if any, else most recently updated) for branch/state on
        // cards, the branch a runner announced for in-flight work (fills the
        // gap between claim and the PR opening), waiting_on = unresolved
        // blocking tickets for dependency chips, the live review-SLA
        // escalation stage (DAT-201) so a breached PR review flags the card,
        // and the live planning-agent review pass (DAT-218) so a card shows
        // that the plan is being rewritten right now.
        // repo_connected completes the deploy gate's inputs (DAT-213) — with
        // it alongside the PR and deploy joins above, every card can carry the
        // reason it cannot move to Done without a second round trip.
        const tickets = (
          await q(
            `SELECT t.*, d.deploy_state, d.deploy_url, (conn.present IS NOT NULL) AS repo_connected,
                    p.number AS pr_number, p.title AS pr_title, p.state AS pr_state, p.branch AS pr_branch, p.url AS pr_url,
                    ba.branch_name AS active_branch,
                    esc.stage AS escalation_stage, esc.pr_number AS escalation_pr,
                    ${PLANNING_REVIEW_COLUMNS_SQL},
                    (SELECT COUNT(*)::int FROM app.ticket_links l
                     JOIN app.tickets b ON b.key = l.ticket_key
                     WHERE l.linked_key = t.key AND l.type = 'blocks'
                       AND b.status NOT IN ('done','dismissed')) AS waiting_on
             FROM app.tickets t
             LEFT JOIN LATERAL (
               SELECT pr.deploy_state, pr.deploy_url FROM app.repo_prs pr
               JOIN app.repo_connections c ON c.id = pr.connection_id
               WHERE pr.ticket_key = t.key AND c.engagement_id = t.engagement_id AND pr.deploy_state IS NOT NULL
               ORDER BY pr.updated_at DESC NULLS LAST LIMIT 1
             ) d ON true
             LEFT JOIN LATERAL (
               SELECT pr.number, pr.title, pr.state, pr.branch, pr.url FROM app.repo_prs pr
               JOIN app.repo_connections c ON c.id = pr.connection_id
               WHERE pr.ticket_key = t.key AND c.engagement_id = t.engagement_id
               ORDER BY (pr.state = 'open') DESC, pr.updated_at DESC NULLS LAST LIMIT 1
             ) p ON true
             LEFT JOIN LATERAL (
               SELECT b.branch_name FROM app.branch_activity b
               WHERE b.ticket_key = t.key AND b.status = 'active'
               ORDER BY b.last_heartbeat DESC NULLS LAST LIMIT 1
             ) ba ON true
             LEFT JOIN LATERAL (
               SELECT e.stage, e.pr_number FROM app.pr_review_escalations e
               WHERE e.ticket_key = t.key AND e.stage IN ('pinged','flagged')
               ORDER BY (e.stage = 'flagged') DESC, e.id DESC LIMIT 1
             ) esc ON true
             ${planningReviewJoin('t')}
             ${REPO_CONNECTED_JOIN}
             WHERE t.engagement_id = $1 ORDER BY t.seq DESC`,
            [id],
          )
        ).rows.map((r) => ({ ...r, done_blocked_reason: doneBlockedReason(gateInputFromRow(r)) }));
        const sources = (await q('SELECT * FROM app.sources WHERE engagement_id = $1 ORDER BY id', [id])).rows;
        const feed = (
          await q('SELECT * FROM app.feed_items WHERE engagement_id = $1 AND NOT reverted ORDER BY id', [id])
        ).rows;
        const team = (
          await q(
            `SELECT t.* FROM app.team_members t
             JOIN app.engagement_members m ON m.member_id = t.id
             WHERE m.engagement_id = $1 ORDER BY t.id`,
            [id]
          )
        ).rows;
        const suggestions = (
          await q(
            `SELECT s.* FROM app.suggestions s
             JOIN app.tickets t ON t.key = s.ticket
             WHERE t.engagement_id = $1 ORDER BY s.id`,
            [id]
          )
        ).rows;
        const agentTasks = (
          await q('SELECT * FROM app.agent_tasks WHERE engagement_id = $1 ORDER BY id DESC LIMIT 50', [id])
        ).rows;
        res.json({ tickets, sources, feed, team, suggestions, agentTasks });
      } catch (err) {
        console.error('engagement detail failed:', err);
        res.status(500).json({ error: 'Failed to load engagement detail' });
      }
    });

    // Daily open/done ticket counts replayed from the status event trail.
    // Empty trail (zero tickets, fresh engagement) → { days: [] }.
    app.get('/api/engagements/:id/burndown', async (req, res) => {
      try {
        const id = req.params.id;
        const exists = await q('SELECT 1 FROM app.engagements WHERE id = $1', [id]);
        if (exists.rows.length === 0) {
          res.status(404).json({ error: 'Engagement not found' });
          return;
        }
        const { rows } = await q(
          'SELECT ticket_key, to_status, created_at FROM app.ticket_events WHERE engagement_id = $1 ORDER BY created_at, id',
          [id]
        );
        const events = rows.map((r) => ({
          ticketKey: String(r.ticket_key),
          toStatus: String(r.to_status),
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        }));
        res.json({ days: computeBurndown(events, new Date().toISOString().slice(0, 10)) });
      } catch (err) {
        console.error('burndown failed:', err);
        res.status(500).json({ error: 'Failed to load burndown' });
      }
    });

    // Cross-project reads backing the /tickets and /tickets/:key routes: the
    // client resolves a deep-linked ticket to its engagement via these.
    // Rides along per ticket: the branch for the work (runner-announced while
    // in flight, else the latest linked PR's) and the agent on the latest
    // agent task, so the list view can show branch + runner avatar too.
    const crossTicketSelect = `
      SELECT t.*, e.client, e.name AS engagement_name,
             p.branch AS pr_branch, ba.branch_name AS active_branch, ag.agent AS task_agent,
             esc.stage AS escalation_stage, esc.pr_number AS escalation_pr,
             ${PLANNING_REVIEW_COLUMNS_SQL}
      FROM app.tickets t
      JOIN app.engagements e ON e.id = t.engagement_id
      LEFT JOIN LATERAL (
        SELECT pr.branch FROM app.repo_prs pr
        JOIN app.repo_connections c ON c.id = pr.connection_id
        WHERE pr.ticket_key = t.key AND c.engagement_id = t.engagement_id
        ORDER BY (pr.state = 'open') DESC, pr.updated_at DESC NULLS LAST LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT b.branch_name FROM app.branch_activity b
        WHERE b.ticket_key = t.key AND b.status = 'active'
        ORDER BY b.last_heartbeat DESC NULLS LAST LIMIT 1
      ) ba ON true
      LEFT JOIN LATERAL (
        SELECT a.agent FROM app.agent_tasks a
        WHERE a.ticket_key = t.key ORDER BY a.id DESC LIMIT 1
      ) ag ON true
      LEFT JOIN LATERAL (
        SELECT s.stage, s.pr_number FROM app.pr_review_escalations s
        WHERE s.ticket_key = t.key AND s.stage IN ('pinged','flagged')
        ORDER BY (s.stage = 'flagged') DESC, s.id DESC LIMIT 1
      ) esc ON true
      ${planningReviewJoin('t')}`;

    app.get('/api/tickets', async (_req, res) => {
      try {
        const { rows } = await q(`${crossTicketSelect} ORDER BY e.created_at, e.id, t.seq`);
        res.json(rows);
      } catch (err) {
        console.error('list tickets failed:', err);
        res.status(500).json({ error: 'Failed to load tickets' });
      }
    });

    app.get('/api/tickets/:key', async (req, res) => {
      try {
        const { rows } = await q(`${crossTicketSelect} WHERE t.key = $1`, [req.params.key]);
        if (rows.length === 0) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        res.json(rows[0]);
      } catch (err) {
        console.error('ticket lookup failed:', err);
        res.status(500).json({ error: 'Failed to load ticket' });
      }
    });

    // ---- ticket mutations ----
    app.patch('/api/tickets/:key', async (req, res) => {
      const parsed = PatchTicketBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: hasEstimateIssue(parsed.error)
            ? 'Time estimates cannot be cleared — estHours and humanEstHours must be positive numbers'
            : 'Invalid patch',
        });
        return;
      }
      try {
        const { status, assignee, branch } = parsed.data;
        const tags = parsed.data.tags === undefined ? undefined : normalizeTags(parsed.data.tags);
        let review: { engagementId: string; from: string } | null = null;
        let enteredReview = false;
        let before: { engagementId: string; status: string } | null = null;
        if (status !== undefined) {
          // Moving tickets in or out of the agent-review states is a lead decision;
          // everything else (board moves, assignment) is open to developers.
          const current = (await q('SELECT engagement_id, status FROM app.tickets WHERE key = $1', [req.params.key]))
            .rows[0];
          if (!current) {
            res.status(404).json({ error: 'Ticket not found' });
            return;
          }
          before = { engagementId: String(current.engagement_id), status: String(current.status) };
          const reviewStates = ['proposed', 'dismissed'];
          if (reviewStates.includes(String(current.status)) || reviewStates.includes(status)) {
            if (!(await requireLead(req, res, String(current.engagement_id)))) return;
            review = { engagementId: String(current.engagement_id), from: String(current.status) };
          }
          enteredReview = status === 'review' && String(current.status) !== 'review';
          // DAT-213: Done means shipped. A move into Done needs the ticket's
          // linked work actually deployed; tickets already in Done, exempt
          // tickets and repo-less engagements pass straight through.
          if (status === 'done' && String(current.status) !== 'done') {
            const blocked = (await loadDeployGates(q, [req.params.key])).get(req.params.key);
            if (blocked) {
              res.status(409).json({ error: blocked });
              return;
            }
          }
        }
        const sets: string[] = [];
        const params: unknown[] = [req.params.key];
        if (status !== undefined) {
          params.push(status);
          sets.push(`status = $${params.length}`);
          // Completion time drives the Done lane's 24h auto-hide: stamped on
          // entering 'done' (kept if already done), cleared on leaving it.
          sets.push(`done_at = CASE WHEN $${params.length} = 'done' THEN COALESCE(done_at, NOW()) END`);
        }
        if (assignee !== undefined) {
          params.push(assignee);
          sets.push(`assignee = $${params.length}`);
        }
        if (parsed.data.roadmapItem !== undefined) {
          params.push(parsed.data.roadmapItem);
          sets.push(`roadmap_item = $${params.length}`);
        }
        if (parsed.data.estHours !== undefined) {
          params.push(parsed.data.estHours);
          sets.push(`est_hours = $${params.length}`);
          // Keep the board card's est label in step with the agent estimate,
          // matching how estimateTicket writes the pair.
          params.push(`${parsed.data.estHours}h`);
          sets.push(`est = $${params.length}`);
        }
        if (parsed.data.humanEstHours !== undefined) {
          params.push(parsed.data.humanEstHours);
          sets.push(`human_est_hours = $${params.length}`);
        }
        if (parsed.data.description !== undefined) {
          params.push(parsed.data.description);
          sets.push(`description = $${params.length}`);
          // updated_at tracks content edits specifically, so the drawer's
          // "edited" stamp stays truthful across status/assignee churn.
          sets.push(`updated_at = NOW()`);
        }
        if (branch !== undefined) {
          params.push(branch === '' ? null : branch);
          sets.push(`branch = $${params.length}`);
        }
        if (tags !== undefined) {
          params.push(JSON.stringify(tags));
          sets.push(`tags = $${params.length}`);
        }
        if (sets.length === 0) {
          res.status(400).json({ error: 'Empty patch' });
          return;
        }
        const result = await q(`UPDATE app.tickets SET ${sets.join(', ')} WHERE key = $1 RETURNING *`, params);
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        const updated = result.rows[0] as { key: string; title: string; status: string };
        console.log(
          `[api] ticket ${updated.key} patched${status !== undefined ? ` — status → '${status}'` : ''}${assignee !== undefined ? ` — assignee → '${assignee}'` : ''}${branch !== undefined ? ` — branch → '${branch}'` : ''}${tags !== undefined ? ` — tags → [${tags.join(', ')}]` : ''}${parsed.data.description !== undefined ? ' — description edited' : ''}`
        );
        if (enteredReview) {
          // Ready for review: log the actual LLM working time against the estimate.
          void recordActualHours(q, updated.key, 'status-patch');
          const deployer = (
            await q(
              `SELECT queued_by FROM app.agent_tasks WHERE ticket_key = $1 AND queued_by IS NOT NULL ORDER BY id DESC LIMIT 1`,
              [updated.key]
            )
          ).rows[0]?.queued_by;
          if (typeof deployer === 'string') {
            await createNotification(q, {
              recipient: deployer,
              type: 'agent_review',
              title: `${updated.key} is ready for sign-off`,
              message: updated.title,
              ticketKey: updated.key,
              engagementId: before?.engagementId,
            });
          }
        }
        if (assignee?.includes('@')) {
          await createNotification(q, {
            recipient: assignee,
            type: 'assignment',
            title: `${updated.key} was assigned to you`,
            message: updated.title,
            ticketKey: updated.key,
            engagementId: before?.engagementId ?? String(result.rows[0].engagement_id),
          });
        }
        if (parsed.data.estHours !== undefined || parsed.data.humanEstHours !== undefined) {
          // DAT-207: hours entered by hand resolve the needs-estimate flag as
          // surely as the agent's do — otherwise the card keeps reading NO EST
          // and the sweep re-estimates over what the lead just typed.
          await clearNeedsEstimateFlag(q, updated.key);
        }
        if (status !== undefined && before) {
          await recordTicketEvent(q, updated.key, before.engagementId, before.status, status);
        }
        if (review && updated.status !== review.from) {
          const verb =
            updated.status === 'dismissed' ? 'Dismissed' : review.from === 'proposed' ? 'Accepted' : 'Reinstated';
          await q(
            `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
             VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
            [
              review.engagementId,
              `${verb} ${updated.status === 'dismissed' ? 'proposed ' : ''}ticket ${updated.key} — ${updated.title}`,
            ]
          );
        }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('patch ticket failed:', err);
        res.status(500).json({ error: 'Failed to update ticket' });
      }
    });

    app.patch('/api/engagements/:id/roadmap-settings', async (req, res) => {
      const parsed = RoadmapSettingsBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid roadmap settings' });
        return;
      }
      try {
        const id = req.params.id;
        if (!(await requireLead(req, res, id))) return;
        const result = await q(
          'UPDATE app.engagements SET roadmap_settings = $2 WHERE id = $1 RETURNING roadmap_settings',
          [id, JSON.stringify(parsed.data)]
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Engagement not found' });
          return;
        }
        res.json(parsed.data);
      } catch (err) {
        console.error('save roadmap settings failed:', err);
        res.status(500).json({ error: 'Failed to save roadmap settings' });
      }
    });

    /**
     * Retroactively refine an existing ticket into a planned ticket via the
     * serving endpoint. The previous description is preserved verbatim under
     * "Original request"; existing AC are kept when the model returns none.
     */
    app.post('/api/tickets/:key/refine', async (req, res) => {
      try {
        const key = req.params.key;
        const t = (await q('SELECT * FROM app.tickets WHERE key = $1', [key])).rows[0];
        if (!t) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        if (['done', 'dismissed'].includes(String(t.status))) {
          res.status(409).json({ error: 'Refine is for active tickets' });
          return;
        }
        const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
        const original = asText(t.description).trim() || asText(t.title);
        const content = [asText(t.title), asText(t.description).trim()].filter(Boolean).join('\n\n');
        console.log(`[api] refining ticket ${key} via the scoping agent (${content.length} chars of context)`);
        const engRow = (await q('SELECT phases FROM app.engagements WHERE id = $1', [String(t.engagement_id)])).rows[0];
        const roadmapItems = roadmapItemNames(engRow?.phases);
        const serving = appkit.serving.bind(appkit);
        // Board-aware tool-calling agent first; single-shot refinement as the
        // fallback so a tool-loop failure degrades, never breaks, the action.
        // DAT-218: the ticket carries the "agent reviewing" flag for the whole
        // pass, so the card and the drawer say the plan is being rewritten.
        // The flag is cleared however this ends — plan, no plan, or throw.
        const { agentic, plan } = await withPlanningReview(
          q,
          { key, engagementId: String(t.engagement_id), flow: 'refine' },
          async () => {
            const agentic = await refineTicketWithBoard(serving, q, {
              key,
              engagementId: String(t.engagement_id),
              content,
              roadmapItems,
              author: requestAuthor(req),
            });
            const plan =
              agentic?.plan ??
              (await refinePlan(serving, content, roadmapItems, q, { engagementId: String(t.engagement_id), ticketKey: key }));
            return { agentic, plan };
          },
        );
        if (!plan) {
          res.status(502).json({ error: 'The planning model is unavailable — try again shortly' });
          return;
        }
        if (agentic && agentic.actions.length > 0) {
          console.log(`[api] ${key} scoping actions: ${agentic.actions.map((a) => a.summary).join('; ')}`);
        }
        // Re-read the row — the scoping loop may have consolidated other
        // tickets into it since `t` was loaded.
        const currentRow = agentic
          ? (await q('SELECT description, ac FROM app.tickets WHERE key = $1', [key])).rows[0]
          : t;
        const folded = foldPlanIntoTicket(plan, original, currentRow, agentic?.actions ?? []);
        const existingAc: unknown[] = (() => {
          try {
            const raw: unknown = typeof t.ac === 'string' ? JSON.parse(t.ac) : (t.ac ?? []);
            return Array.isArray(raw) ? (raw as unknown[]) : [];
          } catch {
            return [];
          }
        })();
        const finalAc: string[] = folded.ac.length > 0 ? folded.ac : existingAc.map((a) => String(a));
        console.log(`[api] ticket ${key} refined — ${finalAc.length} AC`);
        const updated = await q(
          `UPDATE app.tickets SET title = $2, description = $3, ac = $4,
             est_hours = COALESCE($5, est_hours), human_est_hours = COALESCE($6, human_est_hours),
             roadmap_item = COALESCE($7, roadmap_item), updated_at = NOW()
           WHERE key = $1 RETURNING *`,
          [
            key,
            plan.title || String(t.title),
            folded.description,
            JSON.stringify(finalAc),
            plan.estHours,
            plan.humanEstHours,
            plan.roadmapItem,
          ]
        );
        // The plan (and so the scope) changed — re-estimate in the background.
        void estimateTicket(
          q,
          serving,
          {
            key,
            engagementId: String(t.engagement_id),
            title: plan.title || String(t.title),
            description: folded.description,
            ac: finalAc,
          },
          'revised'
        );
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [String(t.engagement_id), `Refined ${key} into a planned ticket.`]
        );
        res.json(updated.rows[0]);
      } catch (err) {
        console.error('refine ticket failed:', err);
        res.status(500).json({ error: 'Failed to refine ticket' });
      }
    });

    app.post('/api/engagements/:id/tickets', async (req, res) => {
      const parsed = CreateTicketBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: hasEstimateIssue(parsed.error)
            ? 'Time estimates are optional — the ticket agent fills them in — but estHours and humanEstHours must be supplied together, both positive numbers'
            : 'A ticket title or description is required',
        });
        return;
      }
      try {
        const engId = req.params.id;
        const eng = (await q('SELECT client, phases FROM app.engagements WHERE id = $1', [engId])).rows[0];
        if (!eng) {
          res.status(404).json({ error: 'Engagement not found' });
          return;
        }
        // Continue the engagement's existing key sequence (e.g. NAC-118 after
        // NAC-117); fall back to the client-derived prefix for a fresh board.
        const existing = (
          await q('SELECT key FROM app.tickets WHERE engagement_id = $1 ORDER BY seq', [engId])
        ).rows.map((r) => String(r.key));
        const prefix =
          existing[0]?.split('-')[0] ??
          (String(eng.client)
            .replace(/[^A-Za-z]/g, '')
            .slice(0, 3)
            .toUpperCase() ||
            'ENG');
        let next = 101;
        for (const k of existing) {
          const m = k.match(/-(\d+)$/);
          if (m && Number(m[1]) >= next) next = Number(m[1]) + 1;
        }
        const key = `${prefix}-${next}`;
        const { assignee, est, workstream } = parsed.data;
        let description = parsed.data.description?.trim() ?? '';
        let title = parsed.data.title?.trim() ?? '';
        let ac: string[] = [];
        // DAT-207: estimates are optional on the wire. Supplied ones are the
        // values of record (the model never overrides them, per DAT-195);
        // when the caller omits them — the console's New Ticket modal, the
        // MCP create_ticket tool, any direct API call — the row lands on the
        // NOT NULL columns with provisional hours plus the needs-estimate
        // flag, and the ticket agent replaces both below.
        const { estHours, humanEstHours } = parsed.data;
        const agentEstimates = estHours == null || humanEstHours == null;
        let roadmapItem: string | null = null;
        const author = requestAuthor(req);
        const chatbox = !title;
        if (chatbox) title = fallbackTitle(description);
        // Every ticket lands on the roadmap; the chatbox flow lets the plan
        // pick an item first and falls back to the active phase after refining.
        else roadmapItem = activeRoadmapItem(eng.phases);
        // Insert the raw ticket first: the scoping agent needs a real key on
        // the board so its link/consolidate tool calls have a subject. The
        // refined plan folds into the row right after, within this request.
        const inserted = await q(
          `INSERT INTO app.tickets (key, engagement_id, title, status, assignee, est, workstream, agent, sources, description, ac, blocked, tags, est_hours, human_est_hours, roadmap_item)
           VALUES ($1,$2,$3,'backlog',$4,$5,$6,false,$7,$8,$9,false,$10,$11,$12,$13) RETURNING *`,
          [
            key,
            engId,
            title.trim(),
            assignee?.trim() || '—',
            est?.trim() || (estHours != null ? `${estHours}h` : '—'),
            workstream?.trim() ?? '',
            JSON.stringify([{ type: 'MANUAL', label: `Created in console by ${author}` }]),
            description,
            JSON.stringify(ac),
            // The flag goes on before the row exists, so a ticket is never
            // silently incomplete even if the process dies mid-request.
            JSON.stringify(agentEstimates ? [NEEDS_ESTIMATE_TAG] : []),
            estHours ?? PROVISIONAL_EST_HOURS,
            humanEstHours ?? PROVISIONAL_HUMAN_EST_HOURS,
            roadmapItem,
          ]
        );
        let row = inserted.rows[0];
        // DAT-218: the row is already on the board, and the planning agent is
        // about to rewrite it (chatbox refine) and/or fill in its hours. Flag
        // it as under review for that whole span — one span, not one per step,
        // so the badge doesn't flicker between them — and clear it in the
        // `finally` below whatever happens.
        const planningPass = chatbox || agentEstimates;
        if (planningPass) await beginPlanningReview(q, { key, engagementId: engId, flow: 'plan' });
        try {
          if (chatbox) {
            // Single-chatbox flow: refine the raw request into a planned ticket.
            // The description doubles as the agent prompt, so it should read like
            // the output of planning: context, approach, dependencies, AC.
            // Board-aware tool-calling agent first (search/link/consolidate
            // against other board tickets), single-shot planner as fallback, raw
            // content as the last resort — refinement never fails creation.
            const content = description;
            const roadmapItems = roadmapItemNames(eng.phases);
            const serving = appkit.serving.bind(appkit);
            const agentic = await refineTicketWithBoard(serving, q, { key, engagementId: engId, content, roadmapItems, author });
            const plan = agentic?.plan ?? (await refinePlan(serving, content, roadmapItems, q, { engagementId: engId, ticketKey: key }));
            if (plan) {
              if (plan.title) title = plan.title;
              roadmapItem = plan.roadmapItem;
              // Keep the human's words verbatim below the plan — they are the
              // intent of record — and carry consolidation results across.
              const currentRow = agentic ? (await q('SELECT description, ac FROM app.tickets WHERE key = $1', [key])).rows[0] : undefined;
              const folded = foldPlanIntoTicket(plan, content, currentRow, agentic?.actions ?? []);
              if (plan.description) description = folded.description;
              ac = folded.ac;
            }
            if (agentic && agentic.actions.length > 0) {
              console.log(`[api] ${key} scoping actions: ${agentic.actions.map((a) => a.summary).join('; ')}`);
            }
            if (!roadmapItem) roadmapItem = activeRoadmapItem(eng.phases);
            const updated = await q(
              `UPDATE app.tickets SET title = $2, description = $3, ac = $4, est = $5, roadmap_item = $6
               WHERE key = $1 RETURNING *`,
              [key, title.trim(), description, JSON.stringify(ac), est?.trim() || (estHours != null ? `${estHours}h` : '—'), roadmapItem],
            );
            row = updated.rows[0] ?? row;
            console.log(
              `[api] chatbox ticket ${key} for ${engId} ${plan ? (agentic ? 'planned via scoping agent' : 'planned via model') : 'using fallback title'} (${content.length} chars)`,
            );
          }
          console.log(`[api] created ticket ${key} in ${engId} (${ac.length} AC)`);
          // DAT-207: hours the caller did not supply are the ticket agent's to
          // fill in — awaited (not backgrounded) so every path, the MCP tool
          // included, gets real hours back in the create response, and so the
          // flag tag is resolved before anyone reads the row. It runs after the
          // chatbox refine so the estimate sees the planned scope, not the raw
          // request. Never throws: a model outage leaves the ticket flagged.
          if (agentEstimates) {
            const hours = await ensureTicketHours(q, appkit.serving.bind(appkit), {
              key,
              engagementId: engId,
              title: title.trim(),
              description,
              ac,
            });
            const refreshed = (await q('SELECT * FROM app.tickets WHERE key = $1', [key])).rows[0];
            if (refreshed) row = refreshed;
            if (hours.status === 'flagged') {
              console.warn(`[api] ${key} created without hours — tagged ${NEEDS_ESTIMATE_TAG} for backfill`);
            }
          }
        } finally {
          if (planningPass) await clearPlanningReview(q, key);
        }
        await recordTicketEvent(q, key, engId, null, 'backlog');
        const who = assignee?.trim();
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [engId, `Created ticket ${key} — ${title.trim()}${who && who !== '—' ? `, assigned to ${who}` : ''}`]
        );
        res.status(201).json(row);
      } catch (err) {
        console.error('create ticket failed:', err);
        res.status(500).json({ error: 'Failed to create ticket' });
      }
    });

    app.delete('/api/tickets/:key', async (req, res) => {
      try {
        const key = req.params.key;
        const current = (await q('SELECT engagement_id, title FROM app.tickets WHERE key = $1', [key])).rows[0];
        if (!current) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        const engagementId = String(current.engagement_id);
        if (!(await requireLead(req, res, engagementId))) return;
        await deleteAttachmentFiles(q, appkit.files('files'), [key]);
        // app.planning_reviews has no FK onto the dev-owned tickets table, so
        // its rows are cleaned up explicitly here (DAT-218).
        await clearPlanningReview(q, key);
        await q('DELETE FROM app.suggestions WHERE ticket = $1', [key]);
        await q('UPDATE app.repo_prs SET ticket_key = NULL WHERE ticket_key = $1', [key]);
        await q('UPDATE app.repo_commits SET ticket_key = NULL WHERE ticket_key = $1', [key]);
        await q('DELETE FROM app.tickets WHERE key = $1', [key]);
        console.log(`[api] deleted ticket ${key} from ${engagementId}`);
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [engagementId, `Deleted ticket ${key} — ${String(current.title)}`]
        );
        res.json({ ok: true });
      } catch (err) {
        console.error('delete ticket failed:', err);
        res.status(500).json({ error: 'Failed to delete ticket' });
      }
    });

    app.post('/api/tickets/bulk', async (req, res) => {
      const parsed = BulkBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid bulk request' });
        return;
      }
      try {
        const { keys, patch } = parsed.data;
        if (patch.status !== undefined) {
          // Same review gate as the single-ticket PATCH: moving tickets in or out
          // of the agent-review states is a lead decision per engagement.
          const reviewStates = ['proposed', 'dismissed'];
          const targets = (await q('SELECT key, engagement_id, status FROM app.tickets WHERE key = ANY($1)', [keys]))
            .rows;
          const gated = reviewStates.includes(patch.status)
            ? targets
            : targets.filter((t) => reviewStates.includes(String(t.status)));
          for (const engagementId of new Set(gated.map((t) => String(t.engagement_id)))) {
            if (!(await requireLead(req, res, engagementId))) return;
          }
          // DAT-213: same deploy gate as the single-ticket PATCH. A bulk move
          // is all-or-nothing — moving the passing subset silently would leave
          // the user guessing which tickets actually closed.
          if (patch.status === 'done') {
            const blocked: { key: string; reason: string }[] = [];
            for (const [key, reason] of await loadDeployGates(q, keys)) {
              if (reason !== null) blocked.push({ key, reason });
            }
            if (blocked.length > 0) {
              res.status(409).json({
                error:
                  blocked.length === 1
                    ? blocked[0].reason
                    : `${String(blocked.length)} tickets are not deployed yet and can't move to Done: ${blocked.map((b) => b.key).join(', ')}. ${blocked[0].reason}`,
              });
              return;
            }
          }
          await q(
            `UPDATE app.tickets SET status = $1,
                    done_at = CASE WHEN $1 = 'done' THEN COALESCE(done_at, NOW()) END
             WHERE key = ANY($2)`,
            [patch.status, keys]
          );
          if (patch.status === 'review') {
            for (const t of targets.filter((t) => String(t.status) !== 'review')) {
              void recordActualHours(q, String(t.key), 'status-patch');
            }
          }
          for (const t of targets) {
            await recordTicketEvent(q, String(t.key), String(t.engagement_id), String(t.status), patch.status);
          }
        }
        if (patch.assignee !== undefined) {
          await q('UPDATE app.tickets SET assignee = $1 WHERE key = ANY($2)', [patch.assignee, keys]);
        }
        console.log(
          `[api] bulk updated ${keys.length} ticket(s)${patch.status !== undefined ? ` — status → '${patch.status}'` : ''}${patch.assignee !== undefined ? ` — assignee → '${patch.assignee}'` : ''}`
        );
        res.json({ updated: keys.length });
      } catch (err) {
        console.error('bulk update failed:', err);
        res.status(500).json({ error: 'Failed bulk update' });
      }
    });

    // ---- assignment suggestions ----
    app.post('/api/suggestions/:id', async (req, res) => {
      const parsed = SuggestionBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid decision' });
        return;
      }
      try {
        const target = (await q('SELECT ticket FROM app.suggestions WHERE id = $1', [req.params.id])).rows[0];
        if (!target) {
          res.status(404).json({ error: 'Suggestion not found' });
          return;
        }
        if (!(await requireLead(req, res, await ticketEngagement(String(target.ticket))))) return;
        const result = await q('UPDATE app.suggestions SET decision = $2 WHERE id = $1 RETURNING *', [
          req.params.id,
          parsed.data.decision,
        ]);
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Suggestion not found' });
          return;
        }
        const sg = result.rows[0] as { ticket: string; person: string };
        if (parsed.data.decision === 'acc') {
          await q('UPDATE app.tickets SET assignee = $2 WHERE key = $1', [sg.ticket, sg.person]);
        }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('suggestion decision failed:', err);
        res.status(500).json({ error: 'Failed to record decision' });
      }
    });

    // ---- status feed / composer ----
    app.put('/api/engagements/:id/composer', async (req, res) => {
      const parsed = ComposerBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      try {
        if (!(await requireLead(req, res, req.params.id))) return;
        await q('UPDATE app.engagements SET composer = $2 WHERE id = $1', [req.params.id, parsed.data.text]);
        res.json({ ok: true });
      } catch (err) {
        console.error('save composer failed:', err);
        res.status(500).json({ error: 'Failed to save draft' });
      }
    });

    app.post('/api/engagements/:id/push', async (req, res) => {
      try {
        if (!(await requireLead(req, res, req.params.id))) return;
        await q('UPDATE app.engagements SET pushed = true WHERE id = $1', [req.params.id]);
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', 'Pushed weekly status update to the Teams delivery channel.', 'JUST NOW', false)`,
          [req.params.id]
        );
        res.json({ ok: true });
      } catch (err) {
        console.error('push failed:', err);
        res.status(500).json({ error: 'Failed to push update' });
      }
    });

    app.post('/api/engagements/:id/draft', async (req, res) => {
      try {
        const id = req.params.id;
        if (!(await requireLead(req, res, id))) return;
        const eng = (await q('SELECT * FROM app.engagements WHERE id = $1', [id])).rows[0];
        if (!eng) {
          res.status(404).json({ error: 'Engagement not found' });
          return;
        }
        const tickets = (
          await q(
            'SELECT key, title, status, assignee, blocked FROM app.tickets WHERE engagement_id = $1 ORDER BY seq',
            [id]
          )
        ).rows;
        const es = (v: unknown) => (typeof v === 'string' ? v : '');
        const prompt = [
          `You are the delivery agent for a consulting engagement. Draft a concise weekly status update (plain text, no markdown) for the client channel.`,
          `Engagement: ${es(eng.name)} for ${es(eng.client)}. Phase: ${es(eng.phase)}. Health: ${es(eng.health)} (${es(eng.health_reason)}). Next milestone: ${es(eng.next_milestone)}.`,
          `Current board: ${JSON.stringify(tickets)}`,
          `Format exactly like this example, four short blocks separated by blank lines:`,
          `<Engagement name> — week of <date>`,
          `Progress: <1-2 sentences>`,
          `Risks: <1-2 sentences>`,
          `Next: <1-2 sentences>`,
        ].join('\n\n');
        const response = await invokeModel(
          appkit.serving.bind(appkit),
          q,
          'status-draft',
          {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 400,
          },
          { engagementId: id }
        );
        const text = extractText(response).trim();
        if (!text) throw new Error('empty model response');
        console.log(`[api] weekly draft generated for ${id} (${text.length} chars)`);
        await q('UPDATE app.engagements SET composer = $2, pushed = false WHERE id = $1', [id, text]);
        res.json({ text });
      } catch (err) {
        console.error('draft generation failed:', err);
        res.status(502).json({ error: 'Draft generation failed' });
      }
    });

    app.post('/api/feed/:id/revert', async (req, res) => {
      try {
        const idNum = parseInt(req.params.id, 10);
        if (isNaN(idNum)) {
          res.status(400).json({ error: 'Invalid id' });
          return;
        }
        const target = (await q('SELECT engagement_id FROM app.feed_items WHERE id = $1', [idNum])).rows[0];
        if (!target) {
          res.status(404).json({ error: 'Feed item not found' });
          return;
        }
        if (!(await requireLead(req, res, String(target.engagement_id)))) return;
        const result = await q(
          'UPDATE app.feed_items SET reverted = true WHERE id = $1 AND reversible RETURNING engagement_id, text',
          [idNum]
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Feed item not found or not reversible' });
          return;
        }
        const item = result.rows[0] as { engagement_id: string; text: string };
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [item.engagement_id, `Reverted agent action: “${item.text}”`]
        );
        res.json({ ok: true });
      } catch (err) {
        console.error('revert failed:', err);
        res.status(500).json({ error: 'Failed to revert' });
      }
    });

    // ---- SOW upload + agent extraction ----
    app.post('/api/sow/upload', express.raw({ type: '*/*', limit: '30mb' }), async (req, res) => {
      try {
        if (!(await requireAnyLead(req, res))) return;
        const rawName = typeof req.query.filename === 'string' ? req.query.filename : 'sow.pdf';
        const filename = rawName.replace(/[^A-Za-z0-9._-]/g, '_');
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'Empty upload' });
          return;
        }
        const path = `sows/${Date.now()}-${filename}`;
        console.log(`[api] SOW upload — ${body.length} bytes to ${path}`);
        await appkit.files('files').upload(path, body, { overwrite: true });
        // Keep only the most recent upload in memory for text extraction at parse time.
        for (const k of Object.keys(req.app.locals)) {
          if (k.startsWith('sow:')) delete req.app.locals[k];
        }
        req.app.locals[`sow:${path}`] = body;
        res.json({ path, filename, size: body.length });
      } catch (err) {
        console.error('sow upload failed:', err);
        res.status(500).json({ error: 'Upload failed' });
      }
    });

    app.post('/api/sow/parse', express.json(), async (req, res) => {
      const parsed = ParseBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid parse request' });
        return;
      }
      const { path, description, client, name } = parsed.data;
      try {
        if (!(await requireAnyLead(req, res))) return;
        let docText = '';
        if (path) {
          // Prefer the in-memory copy from the upload request; re-download from the
          // volume when it is gone (app restarted or scaled between requests).
          let buf: Buffer | null = null;
          const raw: unknown = req.app.locals[`sow:${path}`];
          if (Buffer.isBuffer(raw)) {
            buf = raw;
          } else {
            try {
              const dl = await appkit.files('files').download(path);
              if (dl.contents) buf = Buffer.from(await new Response(dl.contents).arrayBuffer());
            } catch (err) {
              console.warn('volume re-download failed:', (err as Error).message);
            }
          }
          if (!buf) {
            res
              .status(502)
              .json({ error: 'Could not read the uploaded document back from the volume — please re-upload the SOW.' });
            return;
          }
          docText = await extractSowText(path, buf);
        } else {
          docText = description ?? '';
        }
        console.log(
          `[api] SOW parse — source ${path ? `document ${path}` : 'written brief'}, ${docText.length} chars extracted`
        );
        const today = new Date().toISOString().slice(0, 10);
        const sourceKind = path ? 'a signed SOW / SOP document' : 'a written project brief from the engagement lead';
        const prompt = [
          `You are the delivery-planning agent for the consulting firm Datavail. ${path ? 'A signed SOW / SOP was uploaded' : 'The engagement lead described the project'} to set up a new engagement, and you must derive the high-level delivery plan from ${sourceKind}.`,
          `Client: ${client}. Engagement: ${name}. Today's date: ${today}.`,
          docText
            ? `${path ? 'Full extracted SOW text (may be truncated)' : 'Project brief'}:\n---\n${docText}\n---`
            : `The document body could not be text-extracted; infer a realistic plan for this kind of engagement.`,
          `Produce STRICT JSON only (no prose, no code fences) with this shape:`,
          `{"phases":[{"name":string,"s":"YYYY-MM-DD","e":"YYYY-MM-DD"}],"milestones":[{"label":string,"d":"YYYY-MM-DD"}],"proposals":[{"title":string,"phase":string,"est":"Nd","source":string}],"summary":string}`,
          [
            `Rules:`,
            `- 3-6 sequential phases. Use the phase names, start and end dates stated in the document when present; otherwise infer a schedule starting the first Monday of next month with realistic durations.`,
            `- 3-6 dated milestones (kickoff, phase gates, go-live, cutover, sign-off) taken from or consistent with the document.`,
            `- 10-16 proposals (draft tickets). Each title is a concrete, actionable delivery task from the document's deliverables/scope; each proposal's phase must exactly match one of the phase names; est is a day estimate like "4d".`,
            path
              ? `- source cites where the item came from: the SOW section/clause if numbered (e.g. "SOW §2.3"), otherwise a short quote or heading reference.`
              : `- source cites where the item came from: a short quote or paraphrase of the brief line it derives from (e.g. "Brief: migrate 40 ETL jobs").`,
            `- summary: 1-2 sentences stating which sections the schedule was derived from and the overall date range.`,
          ].join('\n'),
        ].join('\n\n');
        // No engagement exists yet at SOW-parse time, so there is no feed to
        // surface a failure on — the 502 with the failure reason is the signal.
        const response = await invokeModel(appkit.serving.bind(appkit), null, 'sow-parse', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 8000,
        });
        const planJson = parseJsonBlock(extractText(response));
        const validated = ProposalPlanSchema.safeParse(planJson);
        if (!validated.success) {
          const issue = validated.error.issues[0];
          console.warn('sow plan failed validation:', validated.error.message);
          res.status(502).json({
            error: `The extracted plan failed validation (${issue.path.join('.')}: ${issue.message}). Try again.`,
          });
          return;
        }
        console.log(
          `[api] SOW plan validated — ${validated.data.phases.length} phases, ${validated.data.milestones?.length ?? 0} milestones, ${validated.data.proposals.length} proposals`
        );
        res.json({ milestones: [], ...validated.data, extractedChars: docText.length });
      } catch (err) {
        const msg = (err as Error).message;
        console.warn('sow parse failed:', msg);
        res.status(502).json({ error: `Plan extraction failed — ${msg}.` });
      }
    });

    // ---- create engagement from accepted plan ----
    app.post('/api/engagements', express.json(), async (req, res) => {
      const parsed = CreateEngagementBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid engagement payload' });
        return;
      }
      try {
        const creator = await requireAnyLead(req, res);
        if (!creator) return;
        const { client, name, sowFile, phases, milestones, proposals } = parsed.data;
        const base =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')
            .slice(0, 24) || 'engagement';
        let id = base;
        let n = 2;
        while ((await q('SELECT 1 FROM app.engagements WHERE id = $1', [id])).rows.length > 0) {
          id = `${base}-${n++}`;
        }
        const prefix =
          client
            .replace(/[^A-Za-z]/g, '')
            .slice(0, 3)
            .toUpperCase() || 'ENG';
        const rmStart = phases[0]?.s ?? '2026-08-01';
        const phaseEnd = phases[phases.length - 1]?.e ?? '2027-02-20';
        // The roadmap window must also cover milestones that land after the last
        // phase (e.g. an acceptance window); ISO dates compare lexically.
        const rmEnd = (milestones ?? []).reduce((max, m) => (m.d > max ? m.d : max), phaseEnd);
        const fmt = (d: string) =>
          new Date(`${d}T12:00:00`).toLocaleString('en', { month: 'short', day: '2-digit' }).toUpperCase();
        // Owner defaults to the creator; "nigel.silva@…" reads as "Nigel Silva".
        const owner =
          creator.email
            .split('@')[0]
            .split(/[._-]+/)
            .filter(Boolean)
            .map((w) => w[0].toUpperCase() + w.slice(1))
            .join(' ') || 'Unassigned';
        const planOrigin = sowFile ? 'the signed SOW' : 'the project brief';
        await q(
          `INSERT INTO app.engagements
           (id, client, name, health, health_reason, owner, phase, pct, burn, plan, next_milestone, blockers,
            sow_status, dates, value, hours, team_size, rm_start, rm_end, phases, milestones, composer)
           VALUES ($1,$2,$3,'ok',$4,$11,$12,0,0,0,$5,0,$13,$6,'—','—',0,$7,$8,$9,$10,'')`,
          [
            id,
            client.toUpperCase(),
            name,
            `Kickoff ${fmt(rmStart)}. Plan seeded from ${planOrigin}; ${proposals.length} tickets on board.`,
            `Kickoff · ${fmt(rmStart)}`,
            `${fmt(rmStart)} – ${fmt(phaseEnd)}`,
            rmStart,
            rmEnd,
            JSON.stringify(phases.map((p) => ({ ...p, pct: 0 }))),
            JSON.stringify(
              (milestones && milestones.length > 0
                ? milestones
                : [
                    { label: 'Kickoff', d: rmStart },
                    { label: 'Go-live', d: rmEnd },
                  ]
              ).map((m) => ({ ...m, done: false }))
            ),
            owner,
            phases[0]?.name ?? 'Discover',
            sowFile ? 'SIGNED' : 'BRIEF',
          ]
        );
        let i = 101;
        for (const p of proposals) {
          const ticketKey = `${prefix}-${i++}`;
          const seedEst = seedEstimates(p.est);
          await q(
            `INSERT INTO app.tickets (key, engagement_id, title, status, assignee, est, workstream, agent, sources, description, ac, blocked, est_hours, human_est_hours)
             VALUES ($1,$2,$3,'backlog','—',$4,$5,true,$6,$7,$8,false,$9,$10)`,
            [
              ticketKey,
              id,
              p.title,
              p.est,
              p.phase,
              JSON.stringify([
                sowFile ? { type: 'SOW', label: `${p.source} — ${sowFile}` } : { type: 'BRIEF', label: p.source },
              ]),
              `Seeded automatically from ${planOrigin} during engagement setup.`,
              JSON.stringify(['Scope confirmed at kickoff', `Deliverable acceptance per ${p.source}`]),
              seedEst.estHours,
              seedEst.humanEstHours,
            ]
          );
          await recordTicketEvent(q, ticketKey, id, null, 'backlog');
        }
        if (sowFile) {
          await q(
            `INSERT INTO app.sources (engagement_id, name, type, status, status_color, last_sync, chunks, linked)
             VALUES ($1,$2,'SOW','SYNCED','ok','JUST NOW',0,$3)`,
            [id, sowFile, proposals.length]
          );
        }
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
           VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
          [
            id,
            `Seeded ${proposals.length} tickets, phase schedule and roadmap from ${planOrigin}.`,
            sowFile ?? 'Project brief',
          ]
        );
        await q(
          'INSERT INTO app.engagement_leads (engagement_id, email) VALUES ($1, LOWER($2)) ON CONFLICT DO NOTHING',
          [id, creator.email]
        );
        console.log(
          `[api] created engagement ${id} — ${proposals.length} tickets seeded from ${planOrigin} (${phases.length} phases)`
        );
        res.status(201).json({ id });
      } catch (err) {
        console.error('create engagement failed:', err);
        res.status(500).json({ error: 'Failed to create engagement' });
      }
    });

    // ---- delete engagement (cascade) ----
    app.delete('/api/engagements/:id', async (req, res) => {
      try {
        const id = req.params.id;
        if (!(await requireLead(req, res, id))) return;
        const exists = await q('SELECT 1 FROM app.engagements WHERE id = $1', [id]);
        if (exists.rows.length === 0) {
          res.status(404).json({ error: 'Engagement not found' });
          return;
        }
        const ticketKeys = (await q('SELECT key FROM app.tickets WHERE engagement_id = $1', [id])).rows.map((r) =>
          String(r.key)
        );
        await deleteAttachmentFiles(q, appkit.files('files'), ticketKeys);
        await q('DELETE FROM app.suggestions WHERE ticket IN (SELECT key FROM app.tickets WHERE engagement_id = $1)', [
          id,
        ]);
        await q('DELETE FROM app.feed_items WHERE engagement_id = $1', [id]);
        await q('DELETE FROM app.sources WHERE engagement_id = $1', [id]);
        await q('DELETE FROM app.engagement_members WHERE engagement_id = $1', [id]);
        await q('DELETE FROM app.tickets WHERE engagement_id = $1', [id]);
        await q('DELETE FROM app.engagements WHERE id = $1', [id]);
        console.log(`[api] deleted engagement ${id} (cascade: tickets, sources, feed, members)`);
        res.json({ ok: true });
      } catch (err) {
        console.error('delete engagement failed:', err);
        res.status(500).json({ error: 'Failed to delete engagement' });
      }
    });

    // ---- admin: team assignment ----
    app.get('/api/admin', async (req, res) => {
      try {
        if (!(await requireAdmin(req, res))) return;
        const engagements = (
          await q('SELECT id, client, name, phase, health FROM app.engagements ORDER BY created_at, id')
        ).rows;
        const members = (await q('SELECT * FROM app.team_members ORDER BY id')).rows;
        const assignments = (await q('SELECT engagement_id, member_id FROM app.engagement_members')).rows;
        const leads = (await q('SELECT engagement_id, email FROM app.engagement_leads ORDER BY engagement_id, email'))
          .rows;
        res.json({ engagements, members, assignments, leads });
      } catch (err) {
        console.error('admin overview failed:', err);
        res.status(500).json({ error: 'Failed to load admin data' });
      }
    });

    app.put('/api/engagements/:id/members', async (req, res) => {
      const parsed = MembersBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'memberIds required' });
        return;
      }
      try {
        const id = req.params.id;
        if (!(await requireLead(req, res, id))) return;
        await q('DELETE FROM app.engagement_members WHERE engagement_id = $1', [id]);
        for (const memberId of parsed.data.memberIds) {
          await q(
            'INSERT INTO app.engagement_members (engagement_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [id, memberId]
          );
        }
        await q('UPDATE app.engagements SET team_size = $2 WHERE id = $1', [id, parsed.data.memberIds.length]);
        res.json({ ok: true, count: parsed.data.memberIds.length });
      } catch (err) {
        console.error('set members failed:', err);
        res.status(500).json({ error: 'Failed to update assignment' });
      }
    });

    app.put('/api/engagements/:id/leads', async (req, res) => {
      const parsed = z.object({ emails: z.array(z.string().email()).max(20) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'emails must be a list of email addresses' });
        return;
      }
      try {
        if (!(await requireAdmin(req, res))) return;
        const id = req.params.id;
        await q('DELETE FROM app.engagement_leads WHERE engagement_id = $1', [id]);
        for (const email of parsed.data.emails) {
          await q(
            'INSERT INTO app.engagement_leads (engagement_id, email) VALUES ($1, LOWER($2)) ON CONFLICT DO NOTHING',
            [id, email]
          );
        }
        res.json({ ok: true, count: parsed.data.emails.length });
      } catch (err) {
        console.error('set leads failed:', err);
        res.status(500).json({ error: 'Failed to update leads' });
      }
    });

    app.post('/api/team-members', async (req, res) => {
      const parsed = NewMemberBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'name and role are required' });
        return;
      }
      try {
        if (!(await requireAdmin(req, res))) return;
        const result = await q(
          `INSERT INTO app.team_members (name, email, role, skills, load) VALUES ($1,LOWER($2),$3,'[0,0,0,0,0,0]',0) RETURNING *`,
          [parsed.data.name.trim(), parsed.data.email, parsed.data.role.trim().toUpperCase()],
        );
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('add member failed:', err);
        res.status(500).json({ error: 'Failed to add team member' });
      }
    });

    app.put('/api/team-members/:id/email', async (req, res) => {
      const parsed = z.object({ email: z.string().email().max(254) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'A valid workspace email is required' });
        return;
      }
      try {
        if (!(await requireAdmin(req, res))) return;
        const updated = await q('UPDATE app.team_members SET email = LOWER($2) WHERE id = $1 RETURNING *', [
          Number(req.params.id),
          parsed.data.email,
        ]);
        if (updated.rows.length === 0) {
          res.status(404).json({ error: 'Member not found' });
          return;
        }
        res.json(updated.rows[0]);
      } catch (err) {
        console.error('update member email failed:', err);
        res.status(500).json({ error: 'Failed to update workspace email' });
      }
    });

    app.delete('/api/team-members/:id', async (req, res) => {
      try {
        if (!(await requireAdmin(req, res))) return;
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) {
          res.status(400).json({ error: 'Invalid id' });
          return;
        }
        const affected = (await q('SELECT engagement_id FROM app.engagement_members WHERE member_id = $1', [id])).rows;
        const result = await q('DELETE FROM app.team_members WHERE id = $1 RETURNING name', [id]);
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Member not found' });
          return;
        }
        // Membership rows cascade; keep the affected engagements' team counts in sync.
        for (const row of affected) {
          await q(
            `UPDATE app.engagements e SET team_size = (SELECT COUNT(*) FROM app.engagement_members m WHERE m.engagement_id = e.id)
             WHERE e.id = $1`,
            [row.engagement_id]
          );
        }
        res.json({ ok: true });
      } catch (err) {
        console.error('delete member failed:', err);
        res.status(500).json({ error: 'Failed to remove team member' });
      }
    });

    // ---- ticket comments ----
    app.get('/api/tickets/:key/comments', async (req, res) => {
      try {
        const { rows } = await q('SELECT * FROM app.ticket_comments WHERE ticket_key = $1 ORDER BY id', [
          req.params.key,
        ]);
        res.json(rows);
      } catch (err) {
        console.error('list comments failed:', err);
        res.status(500).json({ error: 'Failed to load comments' });
      }
    });

    // The telemetry volume is optional — consoles deployed before the
    // agent_telemetry bundle resource exists still run, minus the archive.
    let telemetry: ReturnType<AppKitServices['files']> | null = null;
    if (process.env.DATABRICKS_VOLUME_TELEMETRY) {
      try {
        telemetry = appkit.files('telemetry');
      } catch (err) {
        console.warn(
          '[api] telemetry volume unavailable — tool-call logs stay in Postgres only:',
          (err as Error).message
        );
      }
    } else {
      console.log('[api] DATABRICKS_VOLUME_TELEMETRY not set — tool-call logs stay in Postgres only');
    }

    setupRepoRoutes(app, q, requireLead);
    setupNotificationRoutes(app, q);
    setupTicketLinkRoutes(app, q);
    setupTicketConsolidateRoutes(app, q, requireLead);
    setupMcpRoutes(app, q);
    setupTicketOrderRoutes(app, q);
    setupVelocityRoutes(app, q);
    setupGithubAppRoutes(app);
    setupAgentRoutes(app, q, appkit.files('files'), requireProjectAccess, telemetry);
    setupProjectAgentRoutes(app, q, requireLead, resolveIdentity);
    setupRunnerLoadBalancingRoutes(app, q, requireLead);
    setupAgentSecurityRoutes(app, q, requireLead);
    setupToolCallRoutes(app, q);
    setupCoordinationRoutes(app, q);
    setupPrConflictRoutes(app, q);
    setupTicketReviewRoutes(app, q, requireLead);
    setupPrReviewRoutes(app, q, requireLead);
    setupPrEscalationRoutes(app, q, requireLead);
    setupEstimateRoutes(app, q, appkit.serving.bind(appkit), requireLead);
    setupTicketHoursRoutes(app, q, appkit.serving.bind(appkit), requireLead);
    setupContextFileRoutes(app, q, appkit.files('files'), requireLead);
    setupTicketAttachmentRoutes(app, q, appkit.files('files'), requireLead);
    setupStandardsRoutes(app, q, appkit.files('files'), appkit.serving.bind(appkit), requireLead);
    setupLlmHealthRoutes(app, appkit.serving.bind(appkit));

    app.post('/api/tickets/:key/comments', async (req, res) => {
      const parsed = CommentBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Comment body is required' });
        return;
      }
      try {
        const exists = await q('SELECT key, title, assignee, engagement_id FROM app.tickets WHERE key = $1', [
          req.params.key,
        ]);
        if (exists.rows.length === 0) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        const identity = await resolveIdentity(req);
        const author = identity.email || requestAuthor(req);
        const ticket = exists.rows[0];
        const body = parsed.data.body.trim();
        const result = await q(
          'INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3) RETURNING *',
          [req.params.key, author, body]
        );
        const mentions = mentionedEmails(body).filter((email) => email !== author.toLowerCase());
        for (const recipient of mentions) {
          await createNotification(q, {
            recipient,
            type: 'mention',
            title: `${author} mentioned you on ${req.params.key}`,
            message: body,
            ticketKey: req.params.key,
            engagementId: String(ticket.engagement_id),
          });
        }
        const assignee = (typeof ticket.assignee === 'string' ? ticket.assignee : '').toLowerCase();
        if (assignee.includes('@') && assignee !== author.toLowerCase() && !mentions.includes(assignee)) {
          await createNotification(q, {
            recipient: assignee,
            type: 'comment',
            title: `New comment on ${req.params.key}`,
            message: `${author}: ${body}`,
            ticketKey: req.params.key,
            engagementId: String(ticket.engagement_id),
          });
        }
        res.status(201).json(result.rows[0]);
        // Before a runner ever picks the ticket up, comments double as plan
        // feedback — the planning agent updates the ticket and replies here.
        void applyCommentFeedback(appkit, req.params.key, author, parsed.data.body.trim()).catch((err) =>
          console.warn('[api] comment feedback refinement failed:', (err as Error).message)
        );
      } catch (err) {
        console.error('add comment failed:', err);
        res.status(500).json({ error: 'Failed to add comment' });
      }
    });
  });

  console.log('[api] API routes registered');
  // Idle repos sync every 90s; connections with an open linked PR or an
  // in-flight deploy drop to a 30s cadence so an external merge reflects on
  // the ticket in under a minute while webhooks can't reach the app
  // (GitHub App tokens make the extra polling free, rate-limit-wise).
  startRepoPolling(q, 90_000, 30_000);
  // Review-SLA watch (DAT-201): the thresholds are 24h and 48h, so a 5-minute
  // sweep is ample — and PRs inside the first 24h cost no provider calls.
  startEscalationPolling(q, 5 * 60_000);
  // DAT-218: reap planning-review flags whose owning pass died without
  // clearing them. Reads already ignore expired rows, so this is housekeeping
  // (and the log line that tells us a pass went missing).
  startPlanningReviewSweep(q);
  if (process.env.DEMO_MOCK_RUNNER === '1') startMockRunner(q);
}
