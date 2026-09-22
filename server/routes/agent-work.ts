import { z } from 'zod';
import type express from 'express';
import { resolveCaller, type Caller } from './roles';
import { createNotification } from './notifications';
import { listContextFiles, type FilesVolume } from './context-files';
import { listTicketAttachments } from './ticket-attachments';
import { loadConnection } from './repos';
import { installationToken } from './github-app';
import { completeAgentBranches, postCoordinationMessage } from './coordination';
import { recordActualHours } from './estimates';
import { archiveToolCalls } from './tool-calls';
import { setTicketStatus } from './ticket-events';
import { runnerConfigForWorkPackage } from './project-config';
import { agentConfigForWorkPackage } from './agents';
import { humanDuration, recordRunnerPoll } from './fleet';
import { checkAgentAction, enforceAgentAction } from './agent-security';
import { runnerCanClaim } from './runner-load-balancing';
import { loadRejections, rejectionPromptSection, type TicketRejection } from './ticket-review';
import { commentStyleSection } from './comment-style';

/**
 * Agent work queue: leads queue tickets for autonomous agents; external agent
 * runners (the devbox platform — VMs running Claude Code) integrate over plain
 * HTTP. A runner authenticates through the Databricks Apps OAuth proxy like any
 * workspace caller, then polls the queue, atomically claims a task, reports
 * progress (heartbeats + ticket comments) and completes with an outcome.
 *
 * Lifecycle: queued → claimed → working → done | failed, or cancelled by a
 * lead. Completing with 'done' moves the ticket to Review for human sign-off
 * (merging a linked PR still auto-moves it to Done via the repo integration);
 * 'failed' returns the ticket to the backlog.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const AGENT_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.agent_tasks (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'queued',
    priority INT NOT NULL DEFAULT 0,
    instructions TEXT NOT NULL DEFAULT '',
    queued_by TEXT NOT NULL DEFAULT '',
    agent TEXT,
    agent_identity TEXT,
    claimed_at TIMESTAMPTZ,
    last_heartbeat TIMESTAMPTZ,
    result TEXT,
    result_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // One active run per ticket; completed/cancelled runs stay as history.
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_active_ticket
   ON app.agent_tasks (ticket_key) WHERE state IN ('queued','claimed','working')`,
  // Latest progress note, denormalized so board cards can show it live.
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS last_note TEXT`,
  // Runner-raised warning (reason text); NULL when nothing needs attention.
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS flag TEXT`,
  // How many times the fleet watch has released this task from a dead runner
  // (DAT-224) — past MAX_RECLAIMS it fails for a human instead of cycling.
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS reclaims INT NOT NULL DEFAULT 0`,
  // Optional owner (DAT-227): a task queued for a specific person is only
  // visible/claimable by callers whose workspace identity matches; NULL keeps
  // the shared fleet pool. Stored lowercased.
  `ALTER TABLE app.agent_tasks ADD COLUMN IF NOT EXISTS assignee TEXT`,
];

/**
 * The rank reserved for work that must be picked up before anything a human
 * ordered — today only the merge-conflict requeue (DAT-200). Claiming sorts
 * `priority DESC, id`: the lead-facing queue API caps priority at 9 and
 * drag-to-reorder can only reach the lane length (200 ids max), so this sits
 * above every rank the board can produce, while `id` still keeps FIFO among
 * several top-priority items.
 */
export const TOP_PRIORITY = 1000;

/**
 * A pre-DAT-224 runner long-polls without identifying itself, so it cannot be
 * counted as online while idle and the fleet looks emptier than it is. Say so
 * once per process rather than on every poll — it is an upgrade nudge, not an
 * error.
 */
let warnedAnonymousPoll = false;
function warnAnonymousPoll(): void {
  if (warnedAnonymousPoll) return;
  warnedAnonymousPoll = true;
  console.warn('[agent] a runner is long-polling without an agent id — update devbox-runner so its liveness is visible to the fleet monitor');
}

/**
 * Why a ticket cannot be queued right now, in terms a lead can act on: which
 * run holds it, who claimed it, how long that runner has been silent, and the
 * one action that clears it.
 */
export function blockedByRun(active: Record<string, unknown>, now: number = Date.now()): string {
  const state = typeof active.state === 'string' ? active.state : 'active';
  if (state === 'queued') return 'This ticket is already queued for agent work';
  const agent = typeof active.agent === 'string' && active.agent ? active.agent : 'a runner';
  const id = typeof active.id === 'number' ? String(active.id) : typeof active.id === 'string' ? active.id : '?';
  const hb = active.last_heartbeat;
  const beat = hb instanceof Date ? hb.getTime() : typeof hb === 'string' ? Date.parse(hb) : Number.NaN;
  const silence = Number.isFinite(beat) ? `, last heartbeat ${humanDuration(now - beat)} ago` : ', never heartbeated';
  return `${agent} is already working this ticket (run ${id}, state '${state}'${silence}). Recall it first (remove the card from the agent lane) to queue a fresh run.`;
}

const QueueBody = z.object({
  instructions: z.string().max(8000).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  /** Workspace identity email to route this task to (DAT-227); omit for the shared pool. */
  assignee: z.string().trim().min(3).max(200).optional(),
});

/**
 * Board-facing owner of a routed task (DAT-231): tickets are assigned to
 * PEOPLE, not runners. A task with an assignee email resolves to the team
 * member's display name (falling back to the email); pool tasks have no
 * person, so the runner name remains the visible assignee as before.
 */
async function taskOwnerName(q: Query, task: { assignee?: unknown }): Promise<string | null> {
  const email = typeof task.assignee === 'string' && task.assignee ? task.assignee : null;
  if (!email) return null;
  const row = (await q(`SELECT name FROM app.team_members WHERE LOWER(email) = LOWER($1)`, [email])).rows[0];
  return typeof row?.name === 'string' && row.name ? row.name : email;
}

/**
 * SQL predicate for queue visibility (DAT-227): unassigned tasks are the
 * shared fleet pool; assigned tasks exist only for the matching workspace
 * identity. Pushes the identity param (lowercased) and returns the clause.
 */
export function assigneeScope(params: unknown[], email: string | null | undefined): string {
  if (!email) return `assignee IS NULL`;
  params.push(email.toLowerCase());
  return `(assignee IS NULL OR LOWER(assignee) = $${params.length})`;
}

const OrderBody = z.object({
  order: z.array(z.number().int().positive()).min(1).max(200),
});

const ClaimBody = z.object({
  agent: z.string().min(1).max(80),
  engagement: z.string().max(80).optional(),
  /** Project scope a desktop agent is configured for (DAT-280); several ids, any of them. */
  engagements: z.array(z.string().min(1).max(80)).max(50).optional(),
  ticket: z.string().max(40).optional(),
});

/** `?engagement=a` or `?engagements=a,b` → the ids a runner will take work from (empty = any). */
function engagementScope(query: Record<string, unknown>, body?: { engagement?: string; engagements?: string[] }): string[] {
  const fromBody = body?.engagements?.length ? body.engagements : body?.engagement ? [body.engagement] : [];
  if (fromBody.length) return fromBody;
  const many = typeof query.engagements === 'string' ? query.engagements.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (many.length) return many;
  return typeof query.engagement === 'string' && query.engagement ? [query.engagement] : [];
}

/** SQL fragment restricting to the scope, pushing its ids onto params; '' when unscoped. */
function scopeFilter(params: unknown[], scope: string[]): string {
  if (!scope.length) return '';
  const placeholders = scope.map((id) => {
    params.push(id);
    return `$${params.length}`;
  });
  return ` AND engagement_id IN (${placeholders.join(', ')})`;
}

const ProgressBody = z.object({
  agent: z.string().min(1).max(80),
  note: z.string().min(1).max(8000),
});

const FlagBody = z.object({
  agent: z.string().min(1).max(80),
  reason: z.string().min(1).max(2000),
});

const CompleteBody = z.object({
  agent: z.string().min(1).max(80),
  outcome: z.enum(['done', 'failed']),
  summary: z.string().min(1).max(8000),
  url: z.string().url().max(500).optional(),
});

/**
 * Simulated runner (DEMO_MOCK_RUNNER=1): claims queued tasks ~10s after they
 * are queued and flips them to working ~10s later, so the board's states can
 * be exercised without a devbox. Simulated runs stay 'working' until a lead
 * drags the card to Review (done) or out of the lane (cancelled). Disable the
 * flag before pointing real runners at the queue.
 */
export function startMockRunner(q: Query): void {
  const AGENT = 'sim-runner';
  const tick = async () => {
    try {
      const claimed = (
        await q(
          `UPDATE app.agent_tasks
           SET state = 'claimed', agent = $1, agent_identity = $1, claimed_at = NOW(), last_heartbeat = NOW(), updated_at = NOW()
           WHERE state = 'queued' AND created_at < NOW() - INTERVAL '10 seconds' RETURNING ticket_key`,
          [AGENT],
        )
      ).rows;
      for (const t of claimed) {
        await setTicketStatus(q, String(t.ticket_key), 'progress', { assignee: AGENT });
      }
      await q(
        `UPDATE app.agent_tasks
         SET state = 'working', last_note = 'Simulated runner — working the ticket. Drag the card to Review to finish it.',
             last_heartbeat = NOW(), updated_at = NOW()
         WHERE state = 'claimed' AND agent = $1 AND claimed_at < NOW() - INTERVAL '10 seconds'`,
        [AGENT],
      );
      await q(`UPDATE app.agent_tasks SET last_heartbeat = NOW() WHERE state = 'working' AND agent = $1`, [AGENT]);
    } catch (err) {
      console.warn('[mock-runner] tick failed:', (err as Error).message);
    }
  };
  setInterval(() => void tick(), 5000).unref?.();
  console.log('[agent] DEMO_MOCK_RUNNER active — queued tickets are claimed by sim-runner');
}

/**
 * The prompt a runner hands to Claude Code, rendered server-side so prompt
 * changes ship with console deploys instead of devbox fleet updates. The
 * runner materializes work-package.json, ./context/ and ./repo/ in the
 * working directory before launching Claude with this text.
 */
/** Lint-safe coercion for unknown row values (never [object Object]). */
function txt(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

/** Comments rendered into the prompt: newest-N window so steering posted last always survives the cap. */
const PROMPT_COMMENT_LIMIT = 20;
const PROMPT_COMMENT_CHARS = 1500;

export function renderPrompt(
  task: Record<string, unknown>,
  ticket: Record<string, unknown> | null,
  engagement: Record<string, unknown> | null,
  repo: Record<string, unknown> | null,
  contextFiles: { name: string }[],
  comments: Record<string, unknown>[] = [],
  attachments: { filename: string; size: number }[] = [],
  rejections: TicketRejection[] = [],
): string {
  const key = txt(task.ticket_key);
  const ac = (() => {
    try {
      const raw: unknown = typeof ticket?.ac === 'string' ? JSON.parse(ticket.ac) : (ticket?.ac ?? []);
      return Array.isArray(raw) ? raw.map((a) => txt(a)) : [];
    } catch {
      return [];
    }
  })();
  const recent = comments.slice(-PROMPT_COMMENT_LIMIT);
  const commentLines = recent
    .filter((c) => txt(c.body).trim())
    .map((c) => {
      const at = c.created_at instanceof Date ? c.created_at.toISOString() : txt(c.created_at);
      return `- ${txt(c.author) || 'unknown'}${at ? ` (${at})` : ''}: ${txt(c.body).trim().slice(0, PROMPT_COMMENT_CHARS)}`;
    });
  const lines = [
    `You are an autonomous delivery agent working ticket ${key} — "${txt(ticket?.title)}" for ${txt(engagement?.client)} / ${txt(engagement?.name)}.`,
    '',
    '## Ticket',
    txt(ticket?.description).trim() || '(no description — the title is the scope)',
    ...(ac.length > 0 ? ['', 'Acceptance criteria:', ...ac.map((a) => `- ${a}`)] : []),
    // Rework context (DAT-217): a ticket that came back from review says why,
    // ahead of the lead instructions and the comment thread — the agent should
    // read the reviewer's words before anything else about how to work.
    ...rejectionPromptSection(rejections),
    ...(txt(task.instructions).trim() ? ['', '## Lead instructions', txt(task.instructions).trim()] : []),
    ...(commentLines.length > 0
      ? [
          '',
          `## Ticket comments${comments.length > recent.length ? ` (latest ${recent.length} of ${comments.length})` : ''}`,
          ...commentLines,
          'Comments from leads or teammates are steering — treat them as instructions that refine the ticket.',
        ]
      : []),
    '',
    '## Your working directory',
    `- work-package.json — full task payload (task id ${txt(task.id)}; you are agent "${txt(task.agent) || 'agent'}")`,
    ...(contextFiles.length > 0 ? [`- ./context/ — engagement reference files: ${contextFiles.map((f) => f.name).join(', ')}`] : []),
    ...(repo ? [`- ./repo/ — clone of ${txt(repo.repo_name)} (default branch ${txt(repo.default_branch)})`] : []),
    ...(attachments.length > 0
      ? [
          `- Ticket attachments (fetch via the list_ticket_attachments / read_ticket_attachment MCP tools or GET /api/tickets/${key}/attachments): ${attachments.map((a) => `${a.filename} (${Math.ceil(a.size / 1024)} KB)`).join(', ')}`,
        ]
      : []),
    '',
    '## Delivery expectations',
    `- Work in ./repo. Create a branch named ${key}-<short-slug> — the branch or PR title MUST contain ${key} so the console auto-links your work.`,
    '- Commit with clear messages, push the branch, and open a PR (do NOT merge it).',
    '- If the GIT_TOKEN environment variable is set, push with https://x-access-token:$GIT_TOKEN@github.com/<owner>/<repo>.git and open the PR via the GitHub REST API with that token; otherwise use local git credentials / gh.',
    '- If delivery-console MCP tools are available, post report_agent_progress at plan time and before pushing, and raise flag_agent_work if you get blocked instead of guessing.',
    `- Steering via comments: leads may post new ticket comments while you work. If delivery-console MCP tools are available, re-read the comments with get_ticket (key ${key}) before pushing and apply any new guidance; your own progress notes also appear there — ignore those.`,
    '- Before finishing, write RESULT.md in the working directory (not the repo): 2–4 sentences on what you did, plus the PR URL on its own line. The runner reports this as your completion summary.',
    '- Your agent identity carries security settings a lead controls on the agent map. If an action comes back 403 with a security reason (claiming work, vending a git credential, posting coordination messages), that is a deliberate restriction, not a bug: do not retry it in a loop or work around it — raise a flag saying which scope you need and stop. Reporting progress and completing the task you already hold are never blocked.',
    '',
    ...commentStyleSection(),
    '',
    '## Coordinating with other agents',
    `Other agents may be working other branches of the same repo right now. Your agent id is "${txt(task.agent) || 'agent'}". Use the delivery-console MCP coordination tools (or the /api/agent/coordination REST endpoints) to avoid colliding with them:`,
    '- Before creating your branch, call list_active_branches and check whether an active branch/task overlaps your scope; if it does, message that agent (request_for_info) before duplicating or contradicting its work.',
    '- As soon as you create your branch, announce it with announce_branch_activity (branch, your agent id, ticket key, one-line task description). Re-announce to heartbeat if you work for a long time.',
    '- Check get_coordination_messages (pass your agent id and the last next_since_id you saw) at natural checkpoints: after planning, before pushing, and before finishing. All targeted messages are also mirrored as comments on the relevant ticket so humans can follow along.',
    "- If another agent pokes you or asks for info: SLA 'interrupt' means answer (post_coordination_message type response) before continuing your work; SLA 'wait' means answer before you complete your ticket. Never finish a task while an unanswered 'interrupt' request addressed to you is pending.",
    "- If you discover you are touching the same files as another active branch, post a conflict_warning naming the files. If you need another agent's attention, use poke_agent with an SLA chosen by real urgency — 'interrupt' only when you are blocked.",
    '- Post a final status_update (your branch, PR URL) before completing, so waiting agents are released.',
    ...(repo
      ? [
          '',
          '## After the PR is open — merge conflicts',
          `- Check the PR for merge conflicts against ${txt(repo.default_branch) || 'the base branch'}: run \`git fetch origin\` then \`git merge-tree $(git merge-base HEAD origin/<base>) HEAD origin/<base>\` (conflict markers in the output = conflicted files), and POST /api/agent/work/${txt(task.id)}/pr/<number>/conflicts with {"agent","conflict_files"} (also available as the check_pr_conflicts MCP tool). The report cross-references other open/recent PRs touching the same files, the tickets they are linked to, and returns an auto-resolve vs developer-review assessment.`,
          '- If there are conflicts, review the overlapping PRs listed in the report before touching anything, to understand where the conflicting changes came from.',
          '- Auto-resolve ONLY when the report recommends auto-resolve (no overlapping open PR, no other ticket impacted) AND the conflicts are trivially mergeable (non-overlapping hunks, imports, lockfiles, formatting). Then merge origin/<base> into your branch, resolve, re-run the relevant build/tests, push, and document the resolution with a PR comment (comment_on_pr tool or POST .../pr/<number>/comment).',
          '- If resolution is not safe — overlapping logic changes, or a conflicting PR belongs to another ticket — do NOT resolve or merge. Escalate with escalate_pr_conflict (or POST .../pr/<number>/escalate with {"agent","reason","conflicting_prs"}): this comments on the PR naming the conflicting PR(s)/ticket(s), labels it merge-conflict, requests review from the developers who own the conflicting changes, and flags the ticket on the board. Then finish normally with the PR left open for developer review, and say in RESULT.md that the PR is flagged.',
        ]
      : []),
  ];
  return lines.join('\n');
}

export function setupAgentRoutes(
  app: express.Application,
  q: Query,
  files: FilesVolume,
  requireProjectAccess: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
  telemetry: FilesVolume | null = null,
) {
  /** Fire-and-forget: archive a finished run's tool-call log to the telemetry volume. */
  const archive = (taskId: number) => void archiveToolCalls(q, telemetry, taskId);
  const feed = (engagementId: string, actor: string, text: string) =>
    q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
       VALUES ($1, $2, $3, 'JUST NOW', false)`,
      [engagementId, actor, text],
    );

  /** Everything a runner needs to work a task, in one payload. */
  const workPackage = async (task: Record<string, unknown>) => {
    const ticketKey = String(task.ticket_key);
    const engagementId = String(task.engagement_id);
    const ticket = (await q('SELECT * FROM app.tickets WHERE key = $1', [ticketKey])).rows[0] ?? null;
    const engagement = (await q('SELECT id, client, name, phase, dates, health FROM app.engagements WHERE id = $1', [engagementId])).rows[0] ?? null;
    const comments = (await q('SELECT author, body, created_at FROM app.ticket_comments WHERE ticket_key = $1 ORDER BY id', [ticketKey])).rows;
    // Repo coordinates without the stored token — the runner brings its own git credentials.
    const repo =
      (await q('SELECT provider, repo_url, repo_name, default_branch, status FROM app.repo_connections WHERE engagement_id = $1', [engagementId])).rows[0] ??
      null;
    const contextFiles = await listContextFiles(files, engagementId);
    const attachments = await listTicketAttachments(q, ticketKey).catch(() => []);
    // The project's Config tab, resolved to a base image plus ready-to-spawn
    // install argv — the runner provisions from this before the agent starts.
    const runnerConfig = await runnerConfigForWorkPackage(q, engagementId);
    // Prior review rejections ride along so a re-claimed ticket arrives with the
    // reviewer's feedback instead of a cold re-read (DAT-217).
    const rejections = await loadRejections(q, ticketKey).catch(() => []);
    // The claiming agent's own configuration (DAT-279): the model a lead
    // picked for it and its registry attachments, resolved to full entries so
    // the runner can write them into the workdir without another round trip.
    const agentConfig = await agentConfigForWorkPackage(q, engagementId, typeof task.agent === 'string' ? task.agent : '');
    return {
      task,
      ticket,
      engagement,
      comments,
      repo,
      contextFiles,
      attachments,
      runnerConfig,
      agentConfig,
      rejections,
      prompt: renderPrompt(task, ticket, engagement, repo, contextFiles, comments, attachments, rejections),
    };
  };

  // ---------- console side (lead actions) ----------

  app.post('/api/tickets/:key/queue', async (req, res) => {
    const parsed = QueueBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid queue request' });
      return;
    }
    try {
      const key = req.params.key;
      const ticket = (await q('SELECT engagement_id, title, status FROM app.tickets WHERE key = $1', [key])).rows[0];
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const engagementId = String(ticket.engagement_id);
      const user = await requireProjectAccess(req, res, engagementId);
      if (!user) return;
      // Review tickets are queueable so review feedback (posted as comments)
      // can be sent back to a runner as rework — the comments ride along in
      // the work package and the rendered prompt.
      if (!['backlog', 'progress', 'review'].includes(String(ticket.status))) {
        res.status(409).json({
          error: `Only backlog, in-progress or review tickets can be queued (this one is ${String(ticket.status)})`,
        });
        return;
      }
      const active = (
        await q(
          `SELECT id, state, agent, last_heartbeat FROM app.agent_tasks
           WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`,
          [key],
        )
      ).rows[0];
      if (active) {
        // Say which run is in the way and how to clear it. A run held by a
        // runner that has since died is invisible in the queue listing, so
        // "already queued" alone left leads with no way to discover the block
        // (DAT-224) — the fleet watch reclaims these, but the answer to
        // "why can't I queue this?" must stand on its own.
        res.status(409).json({ error: blockedByRun(active) });
        return;
      }
      const assignee = parsed.data.assignee?.toLowerCase() ?? null;
      const inserted = await q(
        `INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority, instructions, queued_by, assignee)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [key, engagementId, parsed.data.priority ?? 0, parsed.data.instructions?.trim() ?? '', user.email, assignee],
      );
      // Routing is assignment (DAT-231): the ticket belongs to the person the
      // moment it is queued for them, not only once their runner claims it.
      const ownerName = assignee ? await taskOwnerName(q, { assignee }) : null;
      if (ownerName) await q('UPDATE app.tickets SET assignee = $2 WHERE key = $1', [key, ownerName]);
      console.log(`[agent] queued ${key} as task ${String(inserted.rows[0].id)} (engagement ${engagementId}, priority ${parsed.data.priority ?? 0}${assignee ? `, assigned to ${assignee}` : ''})`);
      await feed(engagementId, 'YOU', `Queued ${key} — ${String(ticket.title)} for agent work${ownerName ? ` (assigned to ${ownerName})` : ''}.`);
      res.status(201).json(inserted.rows[0]);
    } catch (err) {
      console.error('queue ticket failed:', err);
      res.status(500).json({ error: 'Failed to queue ticket' });
    }
  });

  /** Lead marks the active run done from the board (drag the card to Review). */
  app.post('/api/tickets/:key/queue/complete', async (req, res) => {
    try {
      const key = req.params.key;
      const task = (await q(`SELECT * FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`, [key])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active agent task for this ticket' });
        return;
      }
      const engagementId = String(task.engagement_id);
      if (!(await requireProjectAccess(req, res, engagementId))) return;
      await q(`UPDATE app.agent_tasks SET state = 'done', result = $2, flag = NULL, last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`, [
        task.id,
        'Marked done from the board.',
      ]);
      await setTicketStatus(q, key, 'review');
      if (typeof task.queued_by === 'string') {
        await createNotification(q, {
          recipient: task.queued_by,
          type: 'agent_review',
          title: `${key} is ready for sign-off`,
          message: 'Agent work reached Review.',
          ticketKey: key,
          engagementId,
        });
      }
      // Ready for review: log the actual LLM working time against the estimate.
      void recordActualHours(q, key, 'board-complete');
      console.log(`[agent] task ${String(task.id)} (${key}) marked done from the board — ticket moved to review`);
      archive(Number(task.id));
      await feed(engagementId, 'YOU', `Marked agent work on ${key} done — moved to Review.`);
      res.json({ ok: true });
    } catch (err) {
      console.error('queue complete failed:', err);
      res.status(500).json({ error: 'Failed to complete agent task' });
    }
  });

  app.delete('/api/tickets/:key/queue', async (req, res) => {
    try {
      const key = req.params.key;
      const task = (await q(`SELECT * FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`, [key])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active agent task for this ticket' });
        return;
      }
      const engagementId = String(task.engagement_id);
      if (!(await requireProjectAccess(req, res, engagementId))) return;
      await q(`UPDATE app.agent_tasks SET state = 'cancelled', updated_at = NOW() WHERE id = $1`, [task.id]);
      // A claimed ticket goes back to the backlog. Pool runs drop the runner
      // as assignee; a routed run keeps its person — cancelling the agent
      // work does not un-assign the human (DAT-231).
      if (task.state !== 'queued') {
        const owner = await taskOwnerName(q, task);
        if (!owner) {
          await setTicketStatus(q, key, 'backlog', {
            assignee: '—',
            onlyIfAssignee: typeof task.agent === 'string' ? task.agent : '',
          });
        }
        await setTicketStatus(q, key, 'backlog', { onlyIfStatus: 'progress' });
      }
      console.log(`[agent] task ${String(task.id)} (${key}) cancelled from state '${String(task.state)}'`);
      archive(Number(task.id));
      await feed(engagementId, 'YOU', `Cancelled agent work on ${key}.`);
      res.json({ ok: true });
    } catch (err) {
      console.error('cancel queue failed:', err);
      res.status(500).json({ error: 'Failed to cancel agent task' });
    }
  });

  /** Reorder the queued lane: body.order is task ids top-first; top claims first. */
  app.put('/api/engagements/:id/agent-queue/order', async (req, res) => {
    const parsed = OrderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'order (array of task ids) is required' });
      return;
    }
    try {
      const engagementId = req.params.id;
      if (!(await requireProjectAccess(req, res, engagementId))) return;
      const { order } = parsed.data;
      console.log(`[agent] reordering queue for engagement ${engagementId} (${order.length} task(s))`);
      // Claiming sorts priority DESC, so the top of the lane gets the highest
      // number. Newly queued tasks default to 0 and land at the bottom.
      for (let i = 0; i < order.length; i++) {
        await q(
          `UPDATE app.agent_tasks SET priority = $3, updated_at = NOW()
           WHERE id = $1 AND engagement_id = $2 AND state = 'queued'`,
          [order[i], engagementId, order.length - i],
        );
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('queue reorder failed:', err);
      res.status(500).json({ error: 'Failed to reorder the queue' });
    }
  });

  // ---------- runner side (devbox platform) ----------

  /**
   * Long-poll pickup: hold the request up to ~55s and answer the moment
   * matching work is queued. Runners loop on this for push-like latency
   * with outbound-only connections (no ingress, no registration).
   *
   * The optional `agent` parameter is the fleet liveness ping (DAT-224): an
   * idle-but-alive runner reaches this endpoint every ~70s anyway, so stamping
   * it here is what separates 'idle' from 'the process exited hours ago'
   * without a single extra request.
   */
  app.get('/api/agent/work/wait', async (req, res) => {
    try {
      const scope = engagementScope(req.query as Record<string, unknown>);
      const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
      if (agent) await recordRunnerPoll(q, agent, scope[0] ?? null, 'poll');
      else warnAnonymousPoll();
      const caller = await resolveCaller(req);
      const deadline = Date.now() + 55_000;
      for (;;) {
        const params: unknown[] = [];
        let where = `state = 'queued'`;
        where += scopeFilter(params, scope);
        where += ` AND ${assigneeScope(params, caller?.email)}`;
        const queued = (await q(`SELECT * FROM app.agent_tasks WHERE ${where} ORDER BY priority DESC, id`, params)).rows;
        if (queued.length > 0) {
          console.log(`[agent] wait poll answered with ${queued.length} queued task(s)${scope.length ? ` (engagements ${scope.join(', ')})` : ''}`);
          res.json({ queued });
          return;
        }
        if (Date.now() >= deadline || req.destroyed) {
          res.status(204).end();
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('agent wait failed:', err);
      res.status(500).json({ error: 'Failed to wait for work' });
    }
  });

  app.get('/api/agent/work', async (req, res) => {
    try {
      const scope = engagementScope(req.query as Record<string, unknown>);
      const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
      if (agent) await recordRunnerPoll(q, agent, scope[0] ?? null, 'poll');
      const caller = await resolveCaller(req);
      const params: unknown[] = [];
      let where = `state = 'queued'`;
      where += scopeFilter(params, scope);
      where += ` AND ${assigneeScope(params, caller?.email)}`;
      const queued = (await q(`SELECT * FROM app.agent_tasks WHERE ${where} ORDER BY priority DESC, id`, params)).rows;
      const active = agent ? (await q(`SELECT * FROM app.agent_tasks WHERE agent = $1 AND state IN ('claimed','working') ORDER BY id`, [agent])).rows : [];
      res.json({ queued, active });
    } catch (err) {
      console.error('agent poll failed:', err);
      res.status(500).json({ error: 'Failed to read the queue' });
    }
  });

  app.post('/api/agent/work/claim', async (req, res) => {
    const parsed = ClaimBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent (runner name) is required' });
      return;
    }
    try {
      const { agent, ticket } = parsed.data;
      const scope = engagementScope({}, parsed.data);
      await recordRunnerPoll(q, agent, scope[0] ?? null, 'claim');
      const caller = await resolveCaller(req);
      const filters: string[] = [`state = 'queued'`];
      const params: unknown[] = [];
      const scoped = scopeFilter(params, scope);
      if (scoped) filters.push(scoped.replace(/^ AND /, ''));
      if (ticket) {
        params.push(ticket);
        filters.push(`ticket_key = $${params.length}`);
      }
      filters.push(assigneeScope(params, caller?.email));
      const candidates = (await q(`SELECT id, engagement_id FROM app.agent_tasks WHERE ${filters.join(' AND ')} ORDER BY priority DESC, id`, params)).rows;
      let claimed: Record<string, unknown> | undefined;
      const eligibility = new Map<string, boolean>();
      for (const candidate of candidates) {
        const candidateEngagement = String(candidate.engagement_id);
        if (!eligibility.has(candidateEngagement)) eligibility.set(candidateEngagement, await runnerCanClaim(q, candidateEngagement, agent));
        if (!eligibility.get(candidateEngagement)) continue;
        claimed = (
          await q(
            `UPDATE app.agent_tasks SET state = 'claimed', agent = $1, agent_identity = $2,
               claimed_at = NOW(), last_heartbeat = NOW(), updated_at = NOW()
             WHERE id = $3 AND state = 'queued' RETURNING *`,
            [agent, caller?.email ?? null, candidate.id],
          )
        ).rows[0];
        if (claimed) break;
      }
      if (!claimed) {
        res.status(404).json({ error: 'No queued work matches' });
        return;
      }
      const key = String(claimed.ticket_key);
      // Security gate (DAT-212). The claim is atomic and the engagement is only
      // known once it lands, so a denied agent has its claim released here — the
      // ticket returns to 'queued' untouched, without ever moving to progress.
      const decision = await checkAgentAction(q, {
        engagementId: String(claimed.engagement_id),
        agent,
        action: 'claim_work',
        detail: key,
      });
      if (!decision.allowed) {
        await q(
          `UPDATE app.agent_tasks SET state = 'queued', agent = NULL, agent_identity = NULL, claimed_at = NULL,
             last_heartbeat = NULL, updated_at = NOW() WHERE id = $1`,
          [claimed.id],
        );
        res.status(403).json({ error: decision.reason, action: 'claim_work', agent });
        return;
      }
      console.log(`[agent] ${agent} claimed task ${String(claimed.id)} (${key}) — ticket moved to progress`);
      // Routed task: the ticket belongs to the person; the runner is machinery.
      const owner = await taskOwnerName(q, claimed);
      await setTicketStatus(q, key, 'progress', { assignee: owner ?? agent });
      await feed(String(claimed.engagement_id), 'AGENT', `${agent} claimed ${key} and started work${owner ? ` for ${owner}` : ''}.`);
      res.json(await workPackage(claimed));
    } catch (err) {
      console.error('claim failed:', err);
      res.status(500).json({ error: 'Failed to claim work' });
    }
  });

  /** Re-fetch the work package for a claimed task (e.g. after a runner restart). */
  app.get('/api/agent/work/:id', async (req, res) => {
    try {
      const task = (await q('SELECT * FROM app.agent_tasks WHERE id = $1', [Number(req.params.id)])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'Task not found' });
        return;
      }
      console.log(`[agent] work package re-fetched for task ${String(task.id)} (${String(task.ticket_key)}, state '${String(task.state)}')`);
      res.json(await workPackage(task));
    } catch (err) {
      console.error('work package failed:', err);
      res.status(500).json({ error: 'Failed to load work package' });
    }
  });

  /**
   * Vend a short-lived git credential for the claimed task's repo. Only
   * GitHub App connections can vend — runners on PAT-connected repos bring
   * their own git credentials. The token is an installation token (~1h TTL)
   * scoped to the repos the App is installed on.
   */
  app.post('/api/agent/work/:id/git-credential', async (req, res) => {
    const parsed = z.object({ agent: z.string().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent (runner name) is required' });
      return;
    }
    try {
      const task = (await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      if (String(task.agent) !== parsed.data.agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
      // Repo write access is the most privileged thing the console hands an
      // agent — gate it before minting anything (DAT-212).
      const allowed = await enforceAgentAction(res, q, {
        engagementId: String(task.engagement_id),
        agent: parsed.data.agent,
        action: 'git_credential',
        detail: String(task.ticket_key),
      });
      if (!allowed) return;
      const conn = await loadConnection(q, String(task.engagement_id));
      if (!conn) {
        res.status(404).json({ error: 'No repository connected to this engagement' });
        return;
      }
      if (conn.provider !== 'github' || conn.auth_type !== 'app' || conn.installation_id == null) {
        res.status(409).json({ error: 'Repository is not connected via the GitHub App — bring your own git credentials' });
        return;
      }
      const { token, expiresAt } = await installationToken(conn.installation_id);
      // Log the vend event only — never the token itself.
      console.log(`[agent] vended git credential for task ${String(task.id)} (repo ${conn.repo_name}, expires ${expiresAt})`);
      res.json({
        provider: 'github',
        repo: conn.repo_name,
        defaultBranch: conn.default_branch,
        token,
        expiresAt,
        cloneUrl: `https://x-access-token:${token}@github.com/${conn.repo_name}.git`,
      });
    } catch (err) {
      console.error('git-credential failed:', err);
      res.status(500).json({ error: 'Failed to vend a git credential' });
    }
  });

  app.post('/api/agent/work/:id/progress', async (req, res) => {
    const parsed = ProgressBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent and note are required' });
      return;
    }
    try {
      const task = (await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      if (String(task.agent) !== parsed.data.agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
      console.log(
        `[agent] progress on task ${String(task.id)} (${String(task.ticket_key)}) from ${parsed.data.agent} — note ${parsed.data.note.trim().length} chars, state '${String(task.state)}' → 'working'`,
      );
      await recordRunnerPoll(q, parsed.data.agent, null, 'heartbeat');
      await q(`UPDATE app.agent_tasks SET state = 'working', last_note = $2, last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`, [
        task.id,
        parsed.data.note.trim(),
      ]);
      await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
        String(task.ticket_key),
        parsed.data.agent,
        parsed.data.note.trim(),
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.error('progress failed:', err);
      res.status(500).json({ error: 'Failed to record progress' });
    }
  });

  /**
   * Silent liveness ping: updates last_heartbeat without posting a comment.
   * Runners call this every couple of minutes during long Claude runs so the
   * board's STALLED detector stays honest without spamming the ticket. It also
   * stamps fleet liveness — a runner deep in a long task is not long-polling
   * for new work, so these heartbeats are the only proof it is still up.
   */
  app.post('/api/agent/work/:id/heartbeat', async (req, res) => {
    const parsed = z.object({ agent: z.string().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent is required' });
      return;
    }
    try {
      const updated = (
        await q(
          `UPDATE app.agent_tasks SET last_heartbeat = NOW(), updated_at = NOW()
           WHERE id = $1 AND agent = $2 AND state IN ('claimed','working') RETURNING id`,
          [Number(req.params.id), parsed.data.agent],
        )
      ).rows[0];
      if (!updated) {
        res.status(404).json({ error: 'No active task with this id for this agent' });
        return;
      }
      await recordRunnerPoll(q, parsed.data.agent, null, 'heartbeat');
      res.json({ ok: true });
    } catch (err) {
      console.error('heartbeat failed:', err);
      res.status(500).json({ error: 'Failed to heartbeat' });
    }
  });

  /**
   * Raise a warning on the active task — stuck, erroring, needs input. Shows
   * as yellow attention treatment on the board card without changing lanes
   * (Review stays reserved for finished work awaiting human sign-off).
   */
  app.post('/api/agent/work/:id/flag', async (req, res) => {
    const parsed = FlagBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent and reason are required' });
      return;
    }
    try {
      const task = (await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      const { agent, reason } = parsed.data;
      if (String(task.agent) !== agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
      const key = String(task.ticket_key);
      console.log(`[agent] task ${String(task.id)} (${key}) flagged by ${agent}: ${reason.trim().slice(0, 140)}`);
      await q(`UPDATE app.agent_tasks SET flag = $2, last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`, [task.id, reason.trim()]);
      await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [key, agent, `⚠ Flagged: ${reason.trim()}`]);
      await feed(String(task.engagement_id), 'AGENT', `⚠ ${agent} flagged ${key} — ${reason.trim().slice(0, 140)}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('flag failed:', err);
      res.status(500).json({ error: 'Failed to flag task' });
    }
  });

  /** Clear a previously raised flag (the runner recovered or got its answer). */
  app.delete('/api/agent/work/:id/flag', async (req, res) => {
    const parsed = z.object({ agent: z.string().min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent is required' });
      return;
    }
    try {
      const task = (await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      if (String(task.agent) !== parsed.data.agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
      console.log(`[agent] flag cleared on task ${String(task.id)} (${String(task.ticket_key)}) by ${parsed.data.agent}`);
      await q(`UPDATE app.agent_tasks SET flag = NULL, last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`, [task.id]);
      await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [String(task.ticket_key), parsed.data.agent, 'Flag cleared.']);
      res.json({ ok: true });
    } catch (err) {
      console.error('flag clear failed:', err);
      res.status(500).json({ error: 'Failed to clear flag' });
    }
  });

  app.post('/api/agent/work/:id/complete', async (req, res) => {
    const parsed = CompleteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent, outcome and summary are required' });
      return;
    }
    try {
      const task = (await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      const { agent, outcome, summary, url } = parsed.data;
      if (String(task.agent) !== agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
      const key = String(task.ticket_key);
      const engagementId = String(task.engagement_id);
      console.log(`[agent] task ${String(task.id)} (${key}) completed by ${agent}: ${outcome} — ticket → ${outcome === 'done' ? 'review' : 'backlog'}`);
      await q(
        `UPDATE app.agent_tasks SET state = $2, result = $3, result_url = $4, flag = NULL, last_heartbeat = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [task.id, outcome, summary.trim(), url ?? null],
      );
      // Coordination channel: close the agent's branch announcements and tell
      // the other agents this run is over, so nobody waits on it (best-effort).
      try {
        const closed = await completeAgentBranches(q, agent, key);
        // The complete endpoint already posts its own ticket comment — log the
        // broadcast without mirroring it a second time.
        await postCoordinationMessage(
          q,
          {
            sender: agent,
            type: 'status_update',
            body: `Finished ${key} (${outcome}).${url ? ` ${url}` : ''}`,
            ticket: key,
            branch: closed[0] ?? null,
          },
          { mirror: false },
        );
      } catch (err) {
        console.warn('[agent] coordination close-out failed:', (err as Error).message);
      }
      archive(Number(task.id));
      if (outcome === 'done') {
        await setTicketStatus(q, key, 'review');
        if (typeof task.queued_by === 'string') {
          await createNotification(q, {
            recipient: task.queued_by,
            type: 'agent_review',
            title: `${key} is ready for sign-off`,
            message: summary,
            ticketKey: key,
            engagementId: String(task.engagement_id),
          });
        }
        // Ready for review: log the actual LLM working time against the estimate.
        void recordActualHours(q, key, 'agent-complete');
      } else {
        // Failed pool run: clear the runner from the ticket. Failed routed
        // run: the person keeps the ticket (DAT-231) — it just leaves progress.
        if (!(await taskOwnerName(q, task))) {
          await setTicketStatus(q, key, 'backlog', { assignee: '—', onlyIfAssignee: agent });
        }
        await setTicketStatus(q, key, 'backlog', { onlyIfStatus: 'progress' });
      }
      await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
        key,
        agent,
        `${outcome === 'done' ? 'Completed' : 'Failed'}: ${summary.trim()}${url ? `\n${url}` : ''}`,
      ]);
      await feed(
        engagementId,
        'AGENT',
        outcome === 'done' ? `${agent} finished ${key} — moved to Review.${url ? ` ${url}` : ''}` : `${agent} could not complete ${key} — returned to Backlog.`,
      );
      res.json({ ok: true, ticketStatus: outcome === 'done' ? 'review' : 'backlog' });
    } catch (err) {
      console.error('complete failed:', err);
      res.status(500).json({ error: 'Failed to complete task' });
    }
  });
}
