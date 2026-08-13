#!/usr/bin/env node
// MCP server for the Delivery Console: lets AI tooling (devbox Claude Code,
// desktop clients) read boards, create/move/comment tickets, drive the agent
// work lifecycle, and pull engagement context files — all through the
// console's HTTP API, authenticated via the Databricks Apps OAuth proxy.
//
// Auth resolution order:
//   1. DATABRICKS_TOKEN env (pre-minted OAuth token)
//   2. `databricks auth token --host $DATABRICKS_HOST` via the CLI
//
// Env: DELIVERY_CONSOLE_URL, DATABRICKS_HOST, DATABRICKS_CLI (path override).
import { execFileSync } from 'child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const APP_URL = (process.env.DELIVERY_CONSOLE_URL ?? 'https://delivery-console-7474645607548631.aws.databricksapps.com').replace(/\/+$/, '');
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-96494b8f-6b86.cloud.databricks.com';
const CLI = process.env.DATABRICKS_CLI ?? 'databricks';

// Short TTL: workspace tokens live ~1h, so a 10-minute cache never hands out
// a token near death; a 401 busts the cache and retries once regardless.
let cachedTok = null; // { token, exp }
function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  if (cachedTok && Date.now() < cachedTok.exp) return cachedTok.token;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  cachedTok = { token: JSON.parse(out).access_token, exp: Date.now() + 10 * 60_000 };
  return cachedTok.token;
}

/** Authorized fetch with one transparent token refresh on 401. */
async function authedFetch(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token()}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    if (resp.status === 401 && attempt === 0 && !process.env.DATABRICKS_TOKEN) {
      cachedTok = null; // token died mid-flight — mint fresh and retry once
      continue;
    }
    return resp;
  }
}

async function call(method, path, body) {
  const resp = await authedFetch(`${APP_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await resp.text();
  if (!resp.ok) {
    let msg = `${resp.status}`;
    try {
      msg = JSON.parse(raw).error ?? msg;
    } catch {
      /* non-JSON error body — keep the status code */
    }
    throw new Error(msg);
  }
  return raw ? JSON.parse(raw) : null;
}

const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
const tool = (name, description, shape, fn) =>
  server.tool(name, description, shape, async (args) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  });

const trimTicket = (t) => ({
  key: t.key,
  title: t.title,
  status: t.status,
  assignee: t.assignee,
  est: t.est,
  workstream: t.workstream,
  blocked: t.blocked,
  description: t.description || undefined,
});

/** Resolve a ticket without a per-ticket endpoint: scan engagement boards. */
async function findTicket(key) {
  for (const eng of await call('GET', '/api/engagements')) {
    const detail = await call('GET', `/api/engagements/${encodeURIComponent(eng.id)}/detail`);
    const t = detail.tickets.find((x) => x.key === key);
    if (t) return { engagement: eng, ticket: t, agentTasks: detail.agentTasks ?? [] };
  }
  throw new Error(`Ticket ${key} not found`);
}

const server = new McpServer({ name: 'delivery-console', version: '1.0.0' });

// ---- read ----

tool('list_engagements', 'List engagements (id, client, name, phase, health).', {}, async () =>
  (await call('GET', '/api/engagements')).map((e) => ({ id: e.id, client: e.client, name: e.name, phase: e.phase, health: e.health })),
);

tool(
  'get_board',
  'Board snapshot for an engagement: tickets by status plus active agent work.',
  { engagement_id: z.string() },
  async ({ engagement_id }) => {
    const d = await call('GET', `/api/engagements/${encodeURIComponent(engagement_id)}/detail`);
    const active = (d.agentTasks ?? []).filter((a) => ['queued', 'claimed', 'working'].includes(a.state));
    return {
      tickets: d.tickets.filter((t) => !['dismissed'].includes(t.status)).map(trimTicket),
      agent_work: active.map((a) => ({ id: a.id, ticket: a.ticket_key, state: a.state, agent: a.agent, note: a.last_note })),
    };
  },
);

tool(
  'get_ticket',
  'Full ticket detail: fields, comments, linked PRs/commits, latest agent run.',
  { key: z.string() },
  async ({ key }) => {
    const { engagement, ticket, agentTasks } = await findTicket(key);
    const [comments, dev] = await Promise.all([
      call('GET', `/api/tickets/${encodeURIComponent(key)}/comments`),
      call('GET', `/api/tickets/${encodeURIComponent(key)}/dev`).catch(() => ({ prs: [], commits: [] })),
    ]);
    return {
      engagement: { id: engagement.id, client: engagement.client, name: engagement.name },
      ticket: { ...trimTicket(ticket), acceptance_criteria: ticket.ac, description: ticket.description },
      comments: comments.map((c) => ({ author: c.author, body: c.body, at: c.created_at })),
      dev,
      agent_run: agentTasks.find((a) => a.ticket_key === key) ?? null,
    };
  },
);

tool(
  'search_tickets',
  'Search an engagement board for tickets by keyword (title + description match). Returns key, title, status and a description snippet.',
  {
    engagement_id: z.string(),
    query: z.string().optional().describe('Keywords to match in title or description; omit to list the board'),
    status: z.enum(['backlog', 'proposed', 'progress', 'review', 'done']).optional(),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 30)'),
  },
  async ({ engagement_id, query, status, limit }) => {
    const d = await call('GET', `/api/engagements/${encodeURIComponent(engagement_id)}/detail`);
    const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const matches = d.tickets.filter((t) => {
      if (t.status === 'dismissed' || (status && t.status !== status)) return false;
      const haystack = `${t.title}\n${t.description ?? ''}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
    return matches
      .slice(0, limit ?? 30)
      .map((t) => ({ ...trimTicket(t), description: undefined, snippet: (t.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 280) || undefined }));
  },
);

// ---- ticket mutations ----

tool(
  'link_tickets',
  'Record a relationship between two tickets on the same board: relates, blocks (key blocks other_key) or blocked_by (key is blocked by other_key).',
  { key: z.string(), other_key: z.string(), type: z.enum(['relates', 'blocks', 'blocked_by']) },
  async ({ key, other_key, type }) => call('POST', `/api/tickets/${encodeURIComponent(key)}/links`, { key: other_key, type }),
);

tool(
  'consolidate_tickets',
  'Merge duplicate/overlapping source tickets into a surviving target (lead only): descriptions and acceptance criteria fold into the target and the sources are dismissed with a pointer comment.',
  { target_key: z.string(), source_keys: z.array(z.string()).min(1).max(20) },
  async ({ target_key, source_keys }) => call('POST', `/api/tickets/${encodeURIComponent(target_key)}/consolidate`, { sources: source_keys }),
);

tool(
  'create_ticket',
  'Create a ticket in an engagement backlog. Time estimates are optional — omit them and the ticket agent estimates the work (DAT-207); a ticket it cannot estimate comes back tagged needs-estimate-review. Returns the new key.',
  {
    engagement_id: z.string(),
    title: z.string().min(3),
    description: z.string().optional(),
    assignee: z.string().optional(),
    est: z.string().optional().describe('Estimate label, e.g. "3d"'),
    workstream: z.string().optional(),
    est_hours: z
      .number()
      .gt(0)
      .max(400)
      .optional()
      .describe('Agent (LLM) time estimate in hours — optional; the ticket agent estimates when omitted'),
    human_est_hours: z
      .number()
      .gt(0)
      .max(999)
      .optional()
      .describe('Human developer time estimate in hours — optional; supply it only together with est_hours'),
  },
  async ({ engagement_id, est_hours, human_est_hours, ...payload }) => {
    // Pass through only what was supplied and let the API's both-or-neither
    // rule be the single source of truth on a lone figure.
    const estimates = {};
    if (est_hours != null) estimates.estHours = est_hours;
    if (human_est_hours != null) estimates.humanEstHours = human_est_hours;
    const t = await call('POST', `/api/engagements/${encodeURIComponent(engagement_id)}/tickets`, {
      ...payload,
      ...estimates,
    });
    return trimTicket(t);
  },
);

tool(
  'move_ticket',
  'Move a ticket to a board status.',
  { key: z.string(), status: z.enum(['backlog', 'progress', 'review', 'done']) },
  async ({ key, status }) => trimTicket(await call('PATCH', `/api/tickets/${encodeURIComponent(key)}`, { status })),
);

tool(
  'assign_ticket',
  'Assign a ticket to a team member (use "—" to unassign).',
  { key: z.string(), assignee: z.string() },
  async ({ key, assignee }) => trimTicket(await call('PATCH', `/api/tickets/${encodeURIComponent(key)}`, { assignee })),
);

tool(
  'comment_on_ticket',
  'Add a comment to a ticket.',
  { key: z.string(), body: z.string().min(1) },
  async ({ key, body }) => call('POST', `/api/tickets/${encodeURIComponent(key)}/comments`, { body }),
);

// ---- agent queue (console side) ----

tool(
  'queue_ticket_for_agent',
  'Queue a ticket in the Deploy to Agent lane (lead only). Higher priority claims first. Works for backlog, in-progress and review tickets — queueing from Review sends the ticket back to a runner as rework, with review comments included in the work package.',
  { key: z.string(), instructions: z.string().optional(), priority: z.number().int().min(0).max(9).optional() },
  async ({ key, ...body }) => call('POST', `/api/tickets/${encodeURIComponent(key)}/queue`, body),
);

tool('cancel_agent_work', 'Cancel/recall the active agent task on a ticket (lead only).', { key: z.string() }, async ({ key }) =>
  call('DELETE', `/api/tickets/${encodeURIComponent(key)}/queue`),
);

tool(
  'complete_agent_work',
  'Mark the active agent run on a ticket done — ticket moves to Review (lead only).',
  { key: z.string() },
  async ({ key }) => call('POST', `/api/tickets/${encodeURIComponent(key)}/queue/complete`, {}),
);

// ---- agent runner lifecycle (devbox side) ----

tool(
  'get_agent_queue',
  'List queued agent tasks (optionally per engagement) and a runner\'s active claims.',
  { engagement_id: z.string().optional(), agent: z.string().optional() },
  async ({ engagement_id, agent }) => {
    const qs = new URLSearchParams();
    if (engagement_id) qs.set('engagement', engagement_id);
    if (agent) qs.set('agent', agent);
    return call('GET', `/api/agent/work${qs.size ? `?${qs}` : ''}`);
  },
);

tool(
  'claim_agent_work',
  'Atomically claim the next queued task as a runner. Returns the work package (ticket, instructions, repo, context files).',
  { agent: z.string().describe('Runner name, e.g. devbox-1'), engagement_id: z.string().optional(), ticket: z.string().optional() },
  async ({ agent, engagement_id, ticket }) => call('POST', '/api/agent/work/claim', { agent, engagement: engagement_id, ticket }),
);

tool(
  'report_agent_progress',
  'Post a progress note for a claimed task — shows live on the board card and as a ticket comment.',
  { task_id: z.number().int(), agent: z.string(), note: z.string().min(1) },
  async ({ task_id, agent, note }) => call('POST', `/api/agent/work/${task_id}/progress`, { agent, note }),
);

tool(
  'finish_agent_work',
  'Complete a claimed task: done parks the ticket in Review, failed returns it to Backlog.',
  { task_id: z.number().int(), agent: z.string(), outcome: z.enum(['done', 'failed']), summary: z.string().min(1), url: z.string().url().optional() },
  async ({ task_id, ...body }) => call('POST', `/api/agent/work/${task_id}/complete`, body),
);

tool(
  'flag_agent_work',
  'Raise a warning on your claimed task — stuck, erroring, or needs human input. Shows yellow attention treatment on the board card without changing lanes; also posts a ticket comment.',
  { task_id: z.number().int(), agent: z.string(), reason: z.string().min(1).max(2000) },
  async ({ task_id, agent, reason }) => call('POST', `/api/agent/work/${task_id}/flag`, { agent, reason }),
);

tool(
  'clear_agent_flag',
  'Clear a previously raised flag on your claimed task (you recovered or got the input you needed).',
  { task_id: z.number().int(), agent: z.string() },
  async ({ task_id, agent }) => call('DELETE', `/api/agent/work/${task_id}/flag`, { agent }),
);

tool(
  'check_pr_conflicts',
  'Analyze merge conflicts on a PR opened for your claimed task: provider mergeability, other open/recent PRs touching the same files, the tickets they are linked to, and a safe-to-auto-resolve vs developer-review assessment. Pass conflict_files from `git merge-tree` for a precise overlap basis.',
  {
    task_id: z.number().int(),
    agent: z.string(),
    pr_number: z.number().int(),
    conflict_files: z.array(z.string()).optional().describe('Conflicted paths from git merge-tree; defaults to every file the PR touches'),
  },
  async ({ task_id, agent, pr_number, conflict_files }) =>
    call('POST', `/api/agent/work/${task_id}/pr/${pr_number}/conflicts`, { agent, conflict_files }),
);

tool(
  'escalate_pr_conflict',
  'Flag a conflicted PR for developer review instead of auto-resolving: posts a PR comment naming the conflicting PR(s)/ticket(s), adds a merge-conflict label, requests review from the developers who own the conflicting changes, flags your task on the board, and comments on the impacted tickets.',
  {
    task_id: z.number().int(),
    agent: z.string(),
    pr_number: z.number().int(),
    reason: z.string().min(1).max(2000).describe('Why auto-resolution was not safe'),
    conflicting_prs: z.array(z.number().int()).optional().describe('PR numbers from check_pr_conflicts that overlap the conflict'),
  },
  async ({ task_id, agent, pr_number, reason, conflicting_prs }) =>
    call('POST', `/api/agent/work/${task_id}/pr/${pr_number}/escalate`, { agent, reason, conflicting_prs }),
);

tool(
  'comment_on_pr',
  "Post a comment on a PR belonging to your claimed task's repo — e.g. to document an auto-resolved merge conflict.",
  { task_id: z.number().int(), agent: z.string(), pr_number: z.number().int(), body: z.string().min(1) },
  async ({ task_id, agent, pr_number, body }) => call('POST', `/api/agent/work/${task_id}/pr/${pr_number}/comment`, { agent, body }),
);

tool(
  'get_git_credential',
  'Vend a short-lived (~1h) git clone/push token for a claimed task (GitHub App connections only).',
  { task_id: z.number().int(), agent: z.string() },
  async ({ task_id, agent }) => call('POST', `/api/agent/work/${task_id}/git-credential`, { agent }),
);

// ---- inter-agent coordination (Lakebase-backed) ----

const MESSAGE_TYPES = ['status_update', 'conflict_warning', 'request_for_info', 'handoff', 'poke', 'response'];

tool(
  'post_coordination_message',
  'Post a message on the shared inter-agent channel (Lakebase Postgres). Omit recipient to broadcast to every agent; targeted messages are mirrored as an @-tagged comment on the ticket the recipient is working, so humans can review the exchange.',
  {
    sender: z.string().describe('Your agent id (runner name)'),
    type: z.enum(MESSAGE_TYPES),
    body: z.string().min(1).describe('Human-readable message'),
    recipient: z.string().optional().describe('Target agent id; omit to broadcast'),
    branch: z.string().optional().describe('Branch this message is about'),
    ticket: z.string().optional().describe('Ticket key context'),
    sla: z.enum(['interrupt', 'wait']).optional().describe("How urgently the recipient should react: 'interrupt' = before continuing, 'wait' = before completing their ticket"),
    data: z.record(z.string(), z.unknown()).optional().describe('Structured payload (stored as JSONB)'),
  },
  async (args) => call('POST', '/api/agent/coordination/messages', args),
);

tool(
  'get_coordination_messages',
  'Fetch new inter-agent messages since your last cursor: broadcasts plus messages addressed to you (your own excluded). Pass the returned next_since_id back on the next call.',
  {
    agent: z.string().describe('Your agent id'),
    since_id: z.number().int().min(0).optional().describe('Last next_since_id you saw (0 or omit for everything)'),
    branch: z.string().optional().describe('Only messages about this branch'),
    limit: z.number().int().min(1).max(500).optional(),
  },
  async ({ agent, since_id, branch, limit }) => {
    const qs = new URLSearchParams({ agent });
    if (since_id) qs.set('since_id', String(since_id));
    if (branch) qs.set('branch', branch);
    if (limit) qs.set('limit', String(limit));
    return call('GET', `/api/agent/coordination/messages?${qs}`);
  },
);

tool(
  'poke_agent',
  "Get another agent's attention (deadlock-breaker): posts a targeted poke with an SLA and mirrors it onto their active ticket. Use sla 'interrupt' only when you are blocked on them; 'wait' means answer before they complete their ticket.",
  {
    sender: z.string().describe('Your agent id'),
    recipient: z.string().describe('Agent id to poke'),
    body: z.string().min(1).describe('What you need from them'),
    sla: z.enum(['interrupt', 'wait']),
    branch: z.string().optional(),
  },
  async ({ sender, recipient, body, sla, branch }) =>
    call('POST', '/api/agent/coordination/messages', { sender, recipient, body, sla, branch, type: 'poke' }),
);

tool(
  'announce_branch_activity',
  'Announce (or heartbeat) that you are working a branch — upserts app.branch_activity in Lakebase so other agents see your in-progress work before they start overlapping changes. Set status completed when you stop.',
  {
    branch: z.string().describe('Branch name, e.g. DAT-149-my-change'),
    agent: z.string().describe('Your agent id'),
    ticket: z.string().optional().describe('Ticket key you are working'),
    description: z.string().optional().describe('One-line task description'),
    status: z.enum(['active', 'completed']).optional(),
  },
  async (args) => call('POST', '/api/agent/coordination/branches', args),
);

tool(
  'list_active_branches',
  'List branches other agents are actively working (agent, ticket, task description, last heartbeat). Check this before starting work that could overlap.',
  { status: z.enum(['active', 'completed']).optional().describe('Defaults to active') },
  async ({ status }) => call('GET', `/api/agent/coordination/branches${status ? `?status=${status}` : ''}`),
);

// ---- context files ----

tool('list_context_files', 'List an engagement\'s uploaded context files.', { engagement_id: z.string() }, async ({ engagement_id }) =>
  call('GET', `/api/engagements/${encodeURIComponent(engagement_id)}/context-files`),
);

tool(
  'read_context_file',
  'Read a context file as text (up to 200 KB; binary files are refused).',
  { engagement_id: z.string(), name: z.string() },
  async ({ engagement_id, name }) => {
    const resp = await authedFetch(
      `${APP_URL}/api/engagements/${encodeURIComponent(engagement_id)}/context-files/${encodeURIComponent(name)}`,
    );
    if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 200 * 1024) throw new Error(`File is ${Math.round(buf.length / 1024)} KB — over the 200 KB read limit`);
    if (buf.includes(0)) throw new Error('File looks binary — download it via the console instead');
    return buf.toString('utf8');
  },
);

// ---- ticket attachments ----

tool(
  'list_ticket_attachments',
  "List a ticket's file attachments (id, filename, size, uploader, sha256).",
  { key: z.string() },
  async ({ key }) => call('GET', `/api/tickets/${encodeURIComponent(key)}/attachments`),
);

tool(
  'attach_file_to_ticket',
  'Attach a file to a ticket. Provide content as text, or content_base64 for binary data (max 25 MB; executable file types are rejected).',
  {
    key: z.string(),
    filename: z.string().min(1),
    content: z.string().optional().describe('UTF-8 text content'),
    content_base64: z.string().optional().describe('Base64-encoded binary content'),
    content_type: z.string().optional().describe('MIME type, e.g. image/png'),
  },
  async ({ key, filename, content, content_base64, content_type }) => {
    if ((content == null) === (content_base64 == null)) throw new Error('Provide exactly one of content or content_base64');
    const body = content != null ? Buffer.from(content, 'utf8') : Buffer.from(content_base64, 'base64');
    const resp = await fetch(`${APP_URL}/api/tickets/${encodeURIComponent(key)}/attachments?filename=${encodeURIComponent(filename)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        'Content-Type': 'application/octet-stream',
        ...(content_type ? { 'X-Attachment-Content-Type': content_type } : {}),
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await resp.text();
    if (!resp.ok) {
      let msg = `${resp.status}`;
      try {
        msg = JSON.parse(raw).error ?? msg;
      } catch {
        /* non-JSON error body — keep the status code */
      }
      throw new Error(msg);
    }
    return JSON.parse(raw);
  },
);

tool(
  'read_ticket_attachment',
  'Read a ticket attachment as text (up to 200 KB; binary files are refused — note the download URL instead).',
  { key: z.string(), attachment_id: z.string() },
  async ({ key, attachment_id }) => {
    const resp = await fetch(
      `${APP_URL}/api/tickets/${encodeURIComponent(key)}/attachments/${encodeURIComponent(attachment_id)}`,
      { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 200 * 1024) throw new Error(`File is ${Math.round(buf.length / 1024)} KB — over the 200 KB read limit`);
    if (buf.includes(0)) throw new Error('File looks binary — download it via the console instead');
    return buf.toString('utf8');
  },
);

tool(
  'delete_ticket_attachment',
  'Delete a ticket attachment (lead only). Removes the file from storage and the attachment list.',
  { key: z.string(), attachment_id: z.string() },
  async ({ key, attachment_id }) =>
    call('DELETE', `/api/tickets/${encodeURIComponent(key)}/attachments/${encodeURIComponent(attachment_id)}`),
);

await server.connect(new StdioServerTransport());
