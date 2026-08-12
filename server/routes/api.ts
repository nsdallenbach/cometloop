import { z } from 'zod';
import express, { Application } from 'express';
import { extractSowText } from './extract-text';
import { resolveIdentity, type Identity } from './roles';
import { REPO_SCHEMA_SQL, setupRepoRoutes, startRepoPolling } from './repos';
import { setupGithubAppRoutes } from './github-app';
import { AGENT_SCHEMA_SQL, setupAgentRoutes, startMockRunner } from './agent-work';
import { COORDINATION_SCHEMA_SQL, setupCoordinationRoutes } from './coordination';
import { TOOL_CALL_SCHEMA_SQL, setupToolCallRoutes } from './tool-calls';
import { setupPrConflictRoutes } from './pr-conflicts';
import { setupContextFileRoutes } from './context-files';
import { ATTACHMENT_SCHEMA_SQL, deleteAttachmentFiles, setupTicketAttachmentRoutes } from './ticket-attachments';
import { STANDARDS_SCHEMA_SQL, setupStandardsRoutes } from './standards';
import { ESTIMATE_SCHEMA_SQL, estimateTicket, recordActualHours, setupEstimateRoutes } from './estimates';
import { normalizeTags } from './ticket-tags';
import { LINKS_SCHEMA_SQL, setupTicketLinkRoutes } from './ticket-links';
import { setupTicketOrderRoutes } from './ticket-order';
import { TICKET_EVENTS_SCHEMA_SQL, TICKET_EVENTS_BACKFILL_SQL, recordTicketEvent, computeBurndown } from './ticket-events';
import {
  SEED_ENGAGEMENTS,
  SEED_TICKETS,
  SEED_SOURCES,
  SEED_FEED,
  SEED_TEAM,
  SEED_SUGGESTIONS,
} from './seed-data';

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
    list(directoryPath?: string): Promise<{ name?: string; path?: string; is_directory?: boolean; file_size?: number; last_modified?: number }[]>;
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
    seq SERIAL,
    done_at TIMESTAMPTZ
  )`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS branch TEXT`,
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
    role TEXT NOT NULL,
    skills JSONB NOT NULL DEFAULT '[]',
    load INT NOT NULL DEFAULT 0
  )`,
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
  `ALTER TABLE app.engagements ADD COLUMN IF NOT EXISTS roadmap_settings JSONB`,
];

async function initSchema(appkit: AppKitServices) {
  // Statements run independently: legacy tables the app SP doesn't own can
  // reject an ALTER without blocking migrations on the tables it does own.
  for (const sql of [...SCHEMA_SQL, ...REPO_SCHEMA_SQL, ...AGENT_SCHEMA_SQL, ...TOOL_CALL_SCHEMA_SQL, ...COORDINATION_SCHEMA_SQL, ...STANDARDS_SCHEMA_SQL, ...TICKET_EVENTS_SCHEMA_SQL, ...LINKS_SCHEMA_SQL, ...ESTIMATE_SCHEMA_SQL, ...ATTACHMENT_SCHEMA_SQL]) {
    try {
      await appkit.lakebase.query(sql);
    } catch (err) {
      console.warn(`[api] schema statement failed (${sql.slice(0, 60).replace(/\s+/g, ' ')}…):`, (err as Error).message);
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
        e.id, e.client, e.name, e.health, e.health_reason, e.owner, e.phase, e.pct, e.burn, e.plan,
        e.next_milestone, e.blockers, e.sow_status, e.dates, e.value, e.hours, e.team_size,
        e.rm_start, e.rm_end,
        e.phases ? JSON.stringify(e.phases) : null,
        e.milestones ? JSON.stringify(e.milestones) : null,
        e.composer,
      ],
    );
  }
  for (const t of SEED_TICKETS) {
    await appkit.lakebase.query(
      `INSERT INTO app.tickets (key, engagement_id, title, status, assignee, est, workstream, agent, sources, description, ac, blocked, done_at)
       VALUES ($1,'cav',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $3 = 'done' THEN NOW() END)`,
      [t.key, t.title, t.status, t.assignee, t.est, t.workstream, t.agent, JSON.stringify(t.sources), t.description, JSON.stringify(t.ac), t.blocked],
    );
  }
  for (const s of SEED_SOURCES) {
    await appkit.lakebase.query(
      `INSERT INTO app.sources (engagement_id, name, type, status, status_color, last_sync, chunks, linked)
       VALUES ('cav',$1,$2,$3,$4,$5,$6,$7)`,
      [s.name, s.type, s.status, s.status_color, s.last_sync, s.chunks, s.linked],
    );
  }
  for (const f of SEED_FEED) {
    await appkit.lakebase.query(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
       VALUES ('cav',$1,$2,$3,$4,$5)`,
      [f.actor, f.text, f.time_label, f.source, f.reversible],
    );
  }
  for (const m of SEED_TEAM) {
    await appkit.lakebase.query(`INSERT INTO app.team_members (name, role, skills, load) VALUES ($1,$2,$3,$4)`, [
      m.name, m.role, JSON.stringify(m.skills), m.load,
    ]);
  }
  for (const g of SEED_SUGGESTIONS) {
    await appkit.lakebase.query(`INSERT INTO app.suggestions (id, ticket, person, rationale) VALUES ($1,$2,$3,$4)`, [
      g.id, g.ticket, g.person, g.rationale,
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
     ON CONFLICT DO NOTHING`,
  );
}

// ---------- LLM helpers ----------

function extractText(response: unknown): string {
  // Programmatic serving invoke returns ExecutionResult: { ok: true, data } | { ok: false, status, message }
  let payload = response;
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const wrapper = payload as { ok: boolean; data?: unknown; message?: string };
    if (!wrapper.ok) throw new Error(wrapper.message ?? 'model invocation failed');
    payload = wrapper.data;
  }
  const r = payload as { choices?: { message?: { content?: unknown } }[] };
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const part = c as { type?: string; text?: string };
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

/**
 * Ask the serving endpoint to turn a raw work request into a planned ticket:
 * derived title, markdown plan (Context / Approach / Dependencies) and
 * acceptance criteria. Returns null when the model is unavailable or the
 * response holds no usable JSON — callers fall back to the raw content.
 */
async function refinePlan(
  appkit: AppKitServices,
  content: string,
  roadmapItems: string[] = [],
): Promise<{ title: string; description: string; ac: string[]; estHours: number | null; roadmapItem: string | null } | null> {
  try {
    const response = await appkit.serving('default').invoke({
      messages: [
        {
          role: 'user',
          content: [
            'You are the delivery-planning agent for a consulting delivery board. A team member typed a work request into a chat box. Turn it into a well-formed delivery ticket.',
            'Respond with ONLY a JSON object, no code fences:',
            '{"title": "concise title, max 10 words, plain text", "description": "markdown", "acceptance_criteria": ["testable outcome", ...], "est_hours": number' +
              (roadmapItems.length > 0 ? ', "roadmap_item": "one of the roadmap items below"' : '') +
              '}',
            'The description becomes the prompt handed to an autonomous coding agent, so make it a compact plan in markdown with these sections (omit any that truly do not apply): ## Context (what exists today and why this is needed), ## Approach (how to implement, referencing systems/files/endpoints implied by the request), ## Dependencies (other tickets, credentials, decisions or unknowns the agent should check first).',
            'Plan only what the request implies — do not invent scope. 3-6 acceptance criteria.',
            'est_hours is the effort for an autonomous coding agent to complete the work, in agent-hours (a number, may be fractional, typically 0.5–40).',
            ...(roadmapItems.length > 0
              ? [`roadmap_item must be exactly one of: ${roadmapItems.map((p) => JSON.stringify(p)).join(', ')} — pick the item this work belongs to.`]
              : []),
            'Work request:',
            content,
          ].join('\n\n'),
        },
      ],
      max_tokens: 1500,
    });
    const text = extractText(response);
    const jsonMatch = /\{[\s\S]*\}/.exec(text);
    if (!jsonMatch) return null;
    const plan = JSON.parse(jsonMatch[0]) as {
      title?: unknown;
      description?: unknown;
      acceptance_criteria?: unknown;
      est_hours?: unknown;
      roadmap_item?: unknown;
    };
    const title = typeof plan.title === 'string' ? plan.title.trim().slice(0, 200) : '';
    const description = typeof plan.description === 'string' ? plan.description.trim() : '';
    const ac = Array.isArray(plan.acceptance_criteria)
      ? plan.acceptance_criteria.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 10)
      : [];
    const estHours =
      typeof plan.est_hours === 'number' && Number.isFinite(plan.est_hours) && plan.est_hours > 0
        ? Math.min(400, Math.round(plan.est_hours * 2) / 2)
        : null;
    // Only accept an item that actually exists on the roadmap — the model must not invent one.
    const roadmapItem =
      typeof plan.roadmap_item === 'string' && roadmapItems.includes(plan.roadmap_item.trim()) ? plan.roadmap_item.trim() : null;
    if (!title && !description) return null;
    return { title, description, ac, estHours, roadmapItem };
  } catch (err) {
    console.warn('[api] ticket refinement failed:', (err as Error).message);
    return null;
  }
}

/** Phase/roadmap-item names from an engagement row's phases JSONB, defensively parsed. */
function roadmapItemNames(phasesRaw: unknown): string[] {
  try {
    const arr: unknown = typeof phasesRaw === 'string' ? JSON.parse(phasesRaw) : phasesRaw;
    if (!Array.isArray(arr)) return [];
    return arr.map((p) => (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string' ? (p as { name: string }).name : '')).filter(Boolean);
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
        !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string' && typeof (p as { s?: unknown }).s === 'string' && typeof (p as { e?: unknown }).e === 'string',
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
 * tagging the commenter, 1-2 plain sentences on what changed. Runs in the
 * background after the comment posts; any failure leaves the comment as a
 * plain comment.
 */
async function applyCommentFeedback(appkit: AppKitServices, key: string, author: string, feedback: string): Promise<void> {
  const q = (text: string, params?: unknown[]) => appkit.lakebase.query(text, params);
  const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
  const t = (await q('SELECT * FROM app.tickets WHERE key = $1', [key])).rows[0];
  if (!t) return;
  if (!['backlog', 'progress', 'proposed'].includes(String(t.status))) return;
  // "Never picked up": no runner has ever claimed work on this ticket.
  const picked = (
    await q(`SELECT 1 FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('claimed','working','done','failed') LIMIT 1`, [key])
  ).rows;
  if (picked.length > 0) return;

  const existingAc = (() => {
    try {
      const raw: unknown = typeof t.ac === 'string' ? JSON.parse(t.ac) : (t.ac ?? []);
      return Array.isArray(raw) ? (raw as unknown[]).map((a) => asText(a)).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();

  const response = await appkit.serving('default').invoke({
    messages: [
      {
        role: 'user',
        content: [
          'You are the delivery-planning agent for a consulting delivery board. A team member left feedback on a planned ticket that no agent has started yet. Update the ticket to incorporate the feedback.',
          'Respond with ONLY a JSON object, no code fences:',
          '{"title": "concise title, max 10 words, plain text", "description": "markdown", "acceptance_criteria": ["testable outcome", ...], "reply": "1-2 short plain sentences telling the commenter what you changed — no jargon, no filler"}',
          'Keep the description in the planned format (## Context / ## Approach / ## Dependencies). If the current description contains an "## Original request" section, keep it verbatim at the end. Change only what the feedback calls for; keep everything else as-is.',
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
  });
  const text = extractText(response);
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) return;
  const plan = JSON.parse(jsonMatch[0]) as { title?: unknown; description?: unknown; acceptance_criteria?: unknown; reply?: unknown };
  const title = typeof plan.title === 'string' && plan.title.trim() ? plan.title.trim().slice(0, 200) : asText(t.title);
  const description = typeof plan.description === 'string' && plan.description.trim() ? plan.description.trim() : asText(t.description);
  const ac = Array.isArray(plan.acceptance_criteria)
    ? plan.acceptance_criteria.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 10)
    : existingAc;
  const reply = typeof plan.reply === 'string' && plan.reply.trim() ? plan.reply.trim().slice(0, 600) : 'Updated the ticket based on your comment.';

  console.log(`[api] comment feedback applied to ${key} — plan updated (${ac.length} AC)`);
  await q(`UPDATE app.tickets SET title = $2, description = $3, ac = $4 WHERE key = $1`, [key, title, description, JSON.stringify(ac)]);
  await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [key, 'Planning Agent', `@${author} — ${reply}`]);
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
    [String(t.engagement_id), `Planning agent reworked ${key} from ${author}'s feedback.`],
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

const PatchTicketBody = z.object({
  status: z.enum(['backlog', 'progress', 'review', 'done', 'proposed', 'dismissed']).optional(),
  assignee: z.string().optional(),
  roadmapItem: z.string().max(120).nullable().optional(),
  estHours: z.number().min(0).max(400).nullable().optional(),
  // Git refs cap out around 255 bytes; empty string clears the manual value so
  // the card falls back to the branch of the latest linked PR.
  branch: z.string().trim().max(255).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

const BulkBody = z.object({
  keys: z.array(z.string()).min(1),
  // Tags are excluded: a bulk patch replaces the whole tag list, which is
  // never what "tag these N tickets" means. Tags are edited per-ticket.
  patch: PatchTicketBody.omit({ tags: true }),
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
  .refine((b) => b.path || b.description, { message: 'Either an uploaded document path or a project description is required' });

const CreateEngagementBody = z.object({
  client: z.string().min(1),
  name: z.string().min(1),
  sowFile: z.string().optional(),
  phases: z.array(z.object({ name: z.string(), s: z.string(), e: z.string() })),
  milestones: z.array(z.object({ label: z.string(), d: z.string() })).optional(),
  proposals: z.array(z.object({ title: z.string(), phase: z.string(), est: z.string(), source: z.string() })).min(1),
});

const MembersBody = z.object({ memberIds: z.array(z.number().int()).max(50) });

const NewMemberBody = z.object({ name: z.string().min(1).max(80), role: z.string().min(1).max(80) });

const CommentBody = z.object({ body: z.string().min(1).max(4000) });

const CreateTicketBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4000).optional(),
    assignee: z.string().max(80).optional(),
    est: z.string().max(16).optional(),
    workstream: z.string().max(80).optional(),
  })
  .refine((b) => b.title?.trim() || b.description?.trim(), { message: 'A title or description is required' });

/** Fallback title when the model is unavailable: first line, clipped at a word boundary. */
function fallbackTitle(description: string): string {
  const line = description.split('\n').find((l) => l.trim()) ?? 'New ticket';
  const clean = line.replace(/^[#*\->\s]+/, '').trim();
  if (clean.length <= 80) return clean || 'New ticket';
  const cut = clean.slice(0, 80);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
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
  const requireLead = async (req: express.Request, res: express.Response, engagementId: string | null): Promise<Identity | null> => {
    const id = await resolveIdentity(req);
    if (id.role === 'admin') return id;
    if (id.role === 'lead' && engagementId) {
      const { rows } = await q('SELECT 1 FROM app.engagement_leads WHERE engagement_id = $1 AND LOWER(email) = LOWER($2)', [
        engagementId,
        id.email,
      ]);
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

  const ticketEngagement = async (key: string): Promise<string | null> => {
    const { rows } = await q('SELECT engagement_id FROM app.tickets WHERE key = $1', [key]);
    return rows.length > 0 ? String(rows[0].engagement_id) : null;
  };

  appkit.server.extend((app) => {
    app.get('/api/me', async (req, res) => {
      try {
        const id = await resolveIdentity(req);
        const leadOf = (await q('SELECT engagement_id FROM app.engagement_leads WHERE LOWER(email) = LOWER($1)', [id.email])).rows.map(
          (r) => String(r.engagement_id),
        );
        res.json({ ...id, leadOf });
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
        // cards, and waiting_on = unresolved blocking tickets for dependency chips.
        const tickets = (
          await q(
            `SELECT t.*, d.deploy_state, d.deploy_url,
                    p.number AS pr_number, p.title AS pr_title, p.state AS pr_state, p.branch AS pr_branch, p.url AS pr_url,
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
             WHERE t.engagement_id = $1 ORDER BY t.seq`,
            [id],
          )
        ).rows;
        const sources = (await q('SELECT * FROM app.sources WHERE engagement_id = $1 ORDER BY id', [id])).rows;
        const feed = (await q('SELECT * FROM app.feed_items WHERE engagement_id = $1 AND NOT reverted ORDER BY id', [id])).rows;
        const team = (
          await q(
            `SELECT t.* FROM app.team_members t
             JOIN app.engagement_members m ON m.member_id = t.id
             WHERE m.engagement_id = $1 ORDER BY t.id`,
            [id],
          )
        ).rows;
        const suggestions = (
          await q(
            `SELECT s.* FROM app.suggestions s
             JOIN app.tickets t ON t.key = s.ticket
             WHERE t.engagement_id = $1 ORDER BY s.id`,
            [id],
          )
        ).rows;
        const agentTasks = (await q('SELECT * FROM app.agent_tasks WHERE engagement_id = $1 ORDER BY id DESC LIMIT 50', [id])).rows;
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
          [id],
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
    app.get('/api/tickets', async (_req, res) => {
      try {
        const { rows } = await q(
          `SELECT t.*, e.client, e.name AS engagement_name FROM app.tickets t
           JOIN app.engagements e ON e.id = t.engagement_id
           ORDER BY e.created_at, e.id, t.seq`,
        );
        res.json(rows);
      } catch (err) {
        console.error('list tickets failed:', err);
        res.status(500).json({ error: 'Failed to load tickets' });
      }
    });

    app.get('/api/tickets/:key', async (req, res) => {
      try {
        const { rows } = await q(
          `SELECT t.*, e.client, e.name AS engagement_name FROM app.tickets t
           JOIN app.engagements e ON e.id = t.engagement_id
           WHERE t.key = $1`,
          [req.params.key],
        );
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
        res.status(400).json({ error: 'Invalid patch' });
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
          const current = (await q('SELECT engagement_id, status FROM app.tickets WHERE key = $1', [req.params.key])).rows[0];
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
          `[api] ticket ${updated.key} patched${status !== undefined ? ` — status → '${status}'` : ''}${assignee !== undefined ? ` — assignee → '${assignee}'` : ''}${branch !== undefined ? ` — branch → '${branch}'` : ''}${tags !== undefined ? ` — tags → [${tags.join(', ')}]` : ''}`,
        );
        if (enteredReview) {
          // Ready for review: log the actual LLM working time against the estimate.
          void recordActualHours(q, updated.key, 'status-patch');
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
            [review.engagementId, `${verb} ${updated.status === 'dismissed' ? 'proposed ' : ''}ticket ${updated.key} — ${updated.title}`],
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
        const result = await q('UPDATE app.engagements SET roadmap_settings = $2 WHERE id = $1 RETURNING roadmap_settings', [
          id,
          JSON.stringify(parsed.data),
        ]);
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
        console.log(`[api] refining ticket ${key} via the planning model (${content.length} chars of context)`);
        const engRow = (await q('SELECT phases FROM app.engagements WHERE id = $1', [String(t.engagement_id)])).rows[0];
        const plan = await refinePlan(appkit, content, roadmapItemNames(engRow?.phases));
        if (!plan) {
          res.status(502).json({ error: 'The planning model is unavailable — try again shortly' });
          return;
        }
        const description = plan.description
          ? `${plan.description}\n\n## Original request\n\n> ${original.replace(/\n/g, '\n> ')}`
          : original;
        const existingAc: unknown[] = (() => {
          try {
            const raw: unknown = typeof t.ac === 'string' ? JSON.parse(t.ac) : (t.ac ?? []);
            return Array.isArray(raw) ? (raw as unknown[]) : [];
          } catch {
            return [];
          }
        })();
        console.log(`[api] ticket ${key} refined — ${plan.ac.length > 0 ? plan.ac.length : existingAc.length} AC`);
        const updated = await q(
          `UPDATE app.tickets SET title = $2, description = $3, ac = $4,
             est_hours = COALESCE($5, est_hours), roadmap_item = COALESCE($6, roadmap_item)
           WHERE key = $1 RETURNING *`,
          [
            key,
            plan.title || String(t.title),
            description,
            JSON.stringify(plan.ac.length > 0 ? plan.ac : existingAc),
            plan.estHours,
            plan.roadmapItem,
          ],
        );
        // The plan (and so the scope) changed — re-estimate in the background.
        void estimateTicket(
          q,
          appkit.serving.bind(appkit),
          {
            key,
            engagementId: String(t.engagement_id),
            title: plan.title || String(t.title),
            description,
            ac: (plan.ac.length > 0 ? plan.ac : existingAc).map((a) => String(a)),
          },
          'revised',
        );
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [String(t.engagement_id), `Refined ${key} into a planned ticket.`],
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
        res.status(400).json({ error: 'A ticket title or description is required' });
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
        const existing = (await q('SELECT key FROM app.tickets WHERE engagement_id = $1 ORDER BY seq', [engId])).rows.map((r) =>
          String(r.key),
        );
        const prefix =
          existing[0]?.split('-')[0] ?? (String(eng.client).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'ENG');
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
        let estHours: number | null = null;
        let roadmapItem: string | null = null;
        if (!title) {
          // Single-chatbox flow: refine the raw request into a planned ticket.
          // The description doubles as the agent prompt, so it should read like
          // the output of planning: context, approach, dependencies, AC.
          const content = description;
          const plan = await refinePlan(appkit, content, roadmapItemNames(eng.phases));
          if (plan) {
            if (plan.title) title = plan.title;
            if (plan.description) {
              // Keep the human's words verbatim below the plan — they are the intent of record.
              description = `${plan.description}\n\n## Original request\n\n> ${content.replace(/\n/g, '\n> ')}`;
            }
            ac = plan.ac;
            estHours = plan.estHours;
            roadmapItem = plan.roadmapItem;
          }
          if (!title) title = fallbackTitle(content);
          console.log(`[api] chatbox ticket for ${engId} ${plan ? 'planned via model' : 'using fallback title'} (${content.length} chars)`);
        }
        // Every ticket lands on the roadmap: fall back to the phase active today.
        if (!roadmapItem) roadmapItem = activeRoadmapItem(eng.phases);
        const author = requestAuthor(req);
        const result = await q(
          `INSERT INTO app.tickets (key, engagement_id, title, status, assignee, est, workstream, agent, sources, description, ac, blocked, est_hours, roadmap_item)
           VALUES ($1,$2,$3,'backlog',$4,$5,$6,false,$7,$8,$9,false,$10,$11) RETURNING *`,
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
            estHours,
            roadmapItem,
          ],
        );
        console.log(`[api] created ticket ${key} in ${engId} (${ac.length} AC)`);
        // Estimate the ticket's LLM hours in the background — creation never
        // waits on (or fails with) the estimation model. Skip when the creator
        // supplied a manual estimate; the model must not clobber human input.
        if (!(est && est.trim() && est.trim() !== '—')) {
          void estimateTicket(
            q,
            appkit.serving.bind(appkit),
            { key, engagementId: engId, title: title.trim(), description, ac },
            'initial',
          );
        }
        await recordTicketEvent(q, key, engId, null, 'backlog');
        const who = assignee?.trim();
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [engId, `Created ticket ${key} — ${title.trim()}${who && who !== '—' ? `, assigned to ${who}` : ''}`],
        );
        res.status(201).json(result.rows[0]);
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
        await q('DELETE FROM app.suggestions WHERE ticket = $1', [key]);
        await q('UPDATE app.repo_prs SET ticket_key = NULL WHERE ticket_key = $1', [key]);
        await q('UPDATE app.repo_commits SET ticket_key = NULL WHERE ticket_key = $1', [key]);
        await q('DELETE FROM app.tickets WHERE key = $1', [key]);
        console.log(`[api] deleted ticket ${key} from ${engagementId}`);
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [engagementId, `Deleted ticket ${key} — ${String(current.title)}`],
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
          const targets = (await q('SELECT key, engagement_id, status FROM app.tickets WHERE key = ANY($1)', [keys])).rows;
          const gated = reviewStates.includes(patch.status)
            ? targets
            : targets.filter((t) => reviewStates.includes(String(t.status)));
          for (const engagementId of new Set(gated.map((t) => String(t.engagement_id)))) {
            if (!(await requireLead(req, res, engagementId))) return;
          }
          await q(
            `UPDATE app.tickets SET status = $1,
                    done_at = CASE WHEN $1 = 'done' THEN COALESCE(done_at, NOW()) END
             WHERE key = ANY($2)`,
            [patch.status, keys],
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
          `[api] bulk updated ${keys.length} ticket(s)${patch.status !== undefined ? ` — status → '${patch.status}'` : ''}${patch.assignee !== undefined ? ` — assignee → '${patch.assignee}'` : ''}`,
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
          [req.params.id],
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
        const tickets = (await q('SELECT key, title, status, assignee, blocked FROM app.tickets WHERE engagement_id = $1 ORDER BY seq', [id])).rows;
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
        const response = await appkit.serving('default').invoke({
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
        });
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
        const result = await q('UPDATE app.feed_items SET reverted = true WHERE id = $1 AND reversible RETURNING engagement_id, text', [idNum]);
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Feed item not found or not reversible' });
          return;
        }
        const item = result.rows[0] as { engagement_id: string; text: string };
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
           VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
          [item.engagement_id, `Reverted agent action: “${item.text}”`],
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
            res.status(502).json({ error: 'Could not read the uploaded document back from the volume — please re-upload the SOW.' });
            return;
          }
          docText = await extractSowText(path, buf);
        } else {
          docText = description ?? '';
        }
        console.log(`[api] SOW parse — source ${path ? `document ${path}` : 'written brief'}, ${docText.length} chars extracted`);
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
        const response = await appkit.serving('default').invoke({
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
          `[api] SOW plan validated — ${validated.data.phases.length} phases, ${validated.data.milestones?.length ?? 0} milestones, ${validated.data.proposals.length} proposals`,
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
        const base = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
          .slice(0, 24) || 'engagement';
        let id = base;
        let n = 2;
        while ((await q('SELECT 1 FROM app.engagements WHERE id = $1', [id])).rows.length > 0) {
          id = `${base}-${n++}`;
        }
        const prefix = (client.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'ENG');
        const rmStart = phases[0]?.s ?? '2026-08-01';
        const phaseEnd = phases[phases.length - 1]?.e ?? '2027-02-20';
        // The roadmap window must also cover milestones that land after the last
        // phase (e.g. an acceptance window); ISO dates compare lexically.
        const rmEnd = (milestones ?? []).reduce((max, m) => (m.d > max ? m.d : max), phaseEnd);
        const fmt = (d: string) =>
          new Date(`${d}T12:00:00`).toLocaleString('en', { month: 'short', day: '2-digit' }).toUpperCase();
        // Owner defaults to the creator; "nigel.silva@…" reads as "Nigel Silva".
        const owner = creator.email
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
              ).map((m) => ({ ...m, done: false })),
            ),
            owner,
            phases[0]?.name ?? 'Discover',
            sowFile ? 'SIGNED' : 'BRIEF',
          ],
        );
        let i = 101;
        for (const p of proposals) {
          const ticketKey = `${prefix}-${i++}`;
          await q(
            `INSERT INTO app.tickets (key, engagement_id, title, status, assignee, est, workstream, agent, sources, description, ac, blocked)
             VALUES ($1,$2,$3,'backlog','—',$4,$5,true,$6,$7,$8,false)`,
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
            ],
          );
          await recordTicketEvent(q, ticketKey, id, null, 'backlog');
        }
        if (sowFile) {
          await q(
            `INSERT INTO app.sources (engagement_id, name, type, status, status_color, last_sync, chunks, linked)
             VALUES ($1,$2,'SOW','SYNCED','ok','JUST NOW',0,$3)`,
            [id, sowFile, proposals.length],
          );
        }
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
           VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
          [id, `Seeded ${proposals.length} tickets, phase schedule and roadmap from ${planOrigin}.`, sowFile ?? 'Project brief'],
        );
        await q('INSERT INTO app.engagement_leads (engagement_id, email) VALUES ($1, LOWER($2)) ON CONFLICT DO NOTHING', [
          id,
          creator.email,
        ]);
        console.log(`[api] created engagement ${id} — ${proposals.length} tickets seeded from ${planOrigin} (${phases.length} phases)`);
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
        const ticketKeys = (await q('SELECT key FROM app.tickets WHERE engagement_id = $1', [id])).rows.map((r) => String(r.key));
        await deleteAttachmentFiles(q, appkit.files('files'), ticketKeys);
        await q('DELETE FROM app.suggestions WHERE ticket IN (SELECT key FROM app.tickets WHERE engagement_id = $1)', [id]);
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
        const engagements = (await q('SELECT id, client, name, phase, health FROM app.engagements ORDER BY created_at, id')).rows;
        const members = (await q('SELECT * FROM app.team_members ORDER BY id')).rows;
        const assignments = (await q('SELECT engagement_id, member_id FROM app.engagement_members')).rows;
        const leads = (await q('SELECT engagement_id, email FROM app.engagement_leads ORDER BY engagement_id, email')).rows;
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
          await q('INSERT INTO app.engagement_members (engagement_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, memberId]);
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
          await q('INSERT INTO app.engagement_leads (engagement_id, email) VALUES ($1, LOWER($2)) ON CONFLICT DO NOTHING', [id, email]);
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
          `INSERT INTO app.team_members (name, role, skills, load) VALUES ($1,$2,'[0,0,0,0,0,0]',0) RETURNING *`,
          [parsed.data.name.trim(), parsed.data.role.trim().toUpperCase()],
        );
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('add member failed:', err);
        res.status(500).json({ error: 'Failed to add team member' });
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
            [row.engagement_id],
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
        const { rows } = await q('SELECT * FROM app.ticket_comments WHERE ticket_key = $1 ORDER BY id', [req.params.key]);
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
        console.warn('[api] telemetry volume unavailable — tool-call logs stay in Postgres only:', (err as Error).message);
      }
    } else {
      console.log('[api] DATABRICKS_VOLUME_TELEMETRY not set — tool-call logs stay in Postgres only');
    }

    setupRepoRoutes(app, q, requireLead);
    setupTicketLinkRoutes(app, q);
    setupTicketOrderRoutes(app, q);
    setupGithubAppRoutes(app);
    setupAgentRoutes(app, q, appkit.files('files'), requireLead, telemetry);
    setupToolCallRoutes(app, q);
    setupCoordinationRoutes(app, q);
    setupPrConflictRoutes(app, q);
    setupEstimateRoutes(app, q);
    setupContextFileRoutes(app, q, appkit.files('files'), requireLead);
    setupTicketAttachmentRoutes(app, q, appkit.files('files'), requireLead);
    setupStandardsRoutes(app, q, appkit.files('files'), appkit.serving.bind(appkit), requireLead);

    app.post('/api/tickets/:key/comments', async (req, res) => {
      const parsed = CommentBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Comment body is required' });
        return;
      }
      try {
        const exists = await q('SELECT 1 FROM app.tickets WHERE key = $1', [req.params.key]);
        if (exists.rows.length === 0) {
          res.status(404).json({ error: 'Ticket not found' });
          return;
        }
        const author = requestAuthor(req);
        const result = await q(
          'INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3) RETURNING *',
          [req.params.key, author, parsed.data.body.trim()],
        );
        res.status(201).json(result.rows[0]);
        // Before a runner ever picks the ticket up, comments double as plan
        // feedback — the planning agent updates the ticket and replies here.
        void applyCommentFeedback(appkit, req.params.key, author, parsed.data.body.trim()).catch((err) =>
          console.warn('[api] comment feedback refinement failed:', (err as Error).message),
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
  if (process.env.DEMO_MOCK_RUNNER === '1') startMockRunner(q);
}
