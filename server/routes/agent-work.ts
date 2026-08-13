import { z } from 'zod';
import type express from 'express';
import { resolveIdentity, type Identity } from './roles';
import { listContextFiles, type FilesVolume } from './context-files';
import { listTicketAttachments } from './ticket-attachments';
import { loadConnection } from './repos';
import { installationToken } from './github-app';
import { completeAgentBranches, postCoordinationMessage } from './coordination';
import { recordActualHours } from './estimates';
import { archiveToolCalls } from './tool-calls';
import { setTicketStatus } from './ticket-events';

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
];

const QueueBody = z.object({
  instructions: z.string().max(8000).optional(),
  priority: z.number().int().min(0).max(9).optional(),
});

const OrderBody = z.object({
  order: z.array(z.number().int().positive()).min(1).max(200),
});

const ClaimBody = z.object({
  agent: z.string().min(1).max(80),
  engagement: z.string().max(80).optional(),
  ticket: z.string().max(40).optional(),
});

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
  requireProjectAccess: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>,
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
    const engagement =
      (await q('SELECT id, client, name, phase, dates, health FROM app.engagements WHERE id = $1', [engagementId])).rows[0] ?? null;
    const comments = (
      await q('SELECT author, body, created_at FROM app.ticket_comments WHERE ticket_key = $1 ORDER BY id', [ticketKey])
    ).rows;
    // Repo coordinates without the stored token — the runner brings its own git credentials.
    const repo =
      (
        await q('SELECT provider, repo_url, repo_name, default_branch, status FROM app.repo_connections WHERE engagement_id = $1', [
          engagementId,
        ])
      ).rows[0] ?? null;
    const contextFiles = await listContextFiles(files, engagementId);
    const attachments = await listTicketAttachments(q, ticketKey).catch(() => []);
    return {
      task,
      ticket,
      engagement,
      comments,
      repo,
      contextFiles,
      attachments,
      prompt: renderPrompt(task, ticket, engagement, repo, contextFiles, comments, attachments),
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
        res.status(409).json({ error: `Only backlog, in-progress or review tickets can be queued (this one is ${String(ticket.status)})` });
        return;
      }
      const active = (
        await q(`SELECT id FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`, [key])
      ).rows[0];
      if (active) {
        res.status(409).json({ error: 'This ticket is already queued for agent work' });
        return;
      }
      const inserted = await q(
        `INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority, instructions, queued_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [key, engagementId, parsed.data.priority ?? 0, parsed.data.instructions?.trim() ?? '', user.email],
      );
      console.log(
        `[agent] queued ${key} as task ${String(inserted.rows[0].id)} (engagement ${engagementId}, priority ${parsed.data.priority ?? 0})`,
      );
      await feed(engagementId, 'YOU', `Queued ${key} — ${String(ticket.title)} for agent work.`);
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
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`, [key])
      ).rows[0];
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
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`, [key])
      ).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active agent task for this ticket' });
        return;
      }
      const engagementId = String(task.engagement_id);
      if (!(await requireProjectAccess(req, res, engagementId))) return;
      await q(`UPDATE app.agent_tasks SET state = 'cancelled', updated_at = NOW() WHERE id = $1`, [task.id]);
      // A claimed ticket goes back to the backlog; drop the agent as assignee.
      if (task.state !== 'queued') {
        await setTicketStatus(q, key, 'backlog', { assignee: '—', onlyIfAssignee: typeof task.agent === 'string' ? task.agent : '' });
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
   */
  app.get('/api/agent/work/wait', async (req, res) => {
    try {
      const engagement = typeof req.query.engagement === 'string' ? req.query.engagement : null;
      const deadline = Date.now() + 55_000;
      for (;;) {
        const params: unknown[] = [];
        let where = `state = 'queued'`;
        if (engagement) {
          params.push(engagement);
          where += ` AND engagement_id = $${params.length}`;
        }
        const queued = (await q(`SELECT * FROM app.agent_tasks WHERE ${where} ORDER BY priority DESC, id`, params)).rows;
        if (queued.length > 0) {
          console.log(`[agent] wait poll answered with ${queued.length} queued task(s)${engagement ? ` (engagement ${engagement})` : ''}`);
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
      const engagement = typeof req.query.engagement === 'string' ? req.query.engagement : null;
      const agent = typeof req.query.agent === 'string' ? req.query.agent : null;
      const params: unknown[] = [];
      let where = `state = 'queued'`;
      if (engagement) {
        params.push(engagement);
        where += ` AND engagement_id = $${params.length}`;
      }
      const queued = (
        await q(`SELECT * FROM app.agent_tasks WHERE ${where} ORDER BY priority DESC, id`, params)
      ).rows;
      const active = agent
        ? (await q(`SELECT * FROM app.agent_tasks WHERE agent = $1 AND state IN ('claimed','working') ORDER BY id`, [agent])).rows
        : [];
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
      const { agent, engagement, ticket } = parsed.data;
      const identity = await resolveIdentity(req);
      const filters: string[] = [`state = 'queued'`];
      const params: unknown[] = [agent, identity.email];
      if (engagement) {
        params.push(engagement);
        filters.push(`engagement_id = $${params.length}`);
      }
      if (ticket) {
        params.push(ticket);
        filters.push(`ticket_key = $${params.length}`);
      }
      // SKIP LOCKED keeps concurrent runners from claiming the same task.
      const claimed = (
        await q(
          `UPDATE app.agent_tasks SET state = 'claimed', agent = $1, agent_identity = $2,
             claimed_at = NOW(), last_heartbeat = NOW(), updated_at = NOW()
           WHERE id = (
             SELECT id FROM app.agent_tasks WHERE ${filters.join(' AND ')}
             ORDER BY priority DESC, id LIMIT 1 FOR UPDATE SKIP LOCKED
           ) RETURNING *`,
          params,
        )
      ).rows[0];
      if (!claimed) {
        res.status(404).json({ error: 'No queued work matches' });
        return;
      }
      const key = String(claimed.ticket_key);
      console.log(`[agent] ${agent} claimed task ${String(claimed.id)} (${key}) — ticket moved to progress`);
      await setTicketStatus(q, key, 'progress', { assignee: agent });
      await feed(String(claimed.engagement_id), 'AGENT', `${agent} claimed ${key} and started work.`);
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
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])
      ).rows[0];
      if (!task) {
        res.status(404).json({ error: 'No active task with this id' });
        return;
      }
      if (String(task.agent) !== parsed.data.agent) {
        res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
        return;
      }
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
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])
      ).rows[0];
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
   * board's STALLED detector stays honest without spamming the ticket.
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
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])
      ).rows[0];
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
      await q(`UPDATE app.agent_tasks SET flag = $2, last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`, [
        task.id,
        reason.trim(),
      ]);
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
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])
      ).rows[0];
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
      await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
        String(task.ticket_key),
        parsed.data.agent,
        'Flag cleared.',
      ]);
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
      const task = (
        await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])
      ).rows[0];
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
      console.log(
        `[agent] task ${String(task.id)} (${key}) completed by ${agent}: ${outcome} — ticket → ${outcome === 'done' ? 'review' : 'backlog'}`,
      );
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
        // Ready for review: log the actual LLM working time against the estimate.
        void recordActualHours(q, key, 'agent-complete');
      } else {
        await setTicketStatus(q, key, 'backlog', { assignee: '—', onlyIfAssignee: agent });
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
        outcome === 'done'
          ? `${agent} finished ${key} — moved to Review.${url ? ` ${url}` : ''}`
          : `${agent} could not complete ${key} — returned to Backlog.`,
      );
      res.json({ ok: true, ticketStatus: outcome === 'done' ? 'review' : 'backlog' });
    } catch (err) {
      console.error('complete failed:', err);
      res.status(500).json({ error: 'Failed to complete task' });
    }
  });
}
