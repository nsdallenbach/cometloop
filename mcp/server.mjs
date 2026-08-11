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

let cachedTok = null; // { token, exp }
function token() {
  if (process.env.DATABRICKS_TOKEN) return process.env.DATABRICKS_TOKEN;
  if (cachedTok && Date.now() < cachedTok.exp) return cachedTok.token;
  const out = execFileSync(CLI, ['auth', 'token', '--host', HOST], { encoding: 'utf8' });
  cachedTok = { token: JSON.parse(out).access_token, exp: Date.now() + 45 * 60_000 };
  return cachedTok.token;
}

async function call(method, path, body) {
  const resp = await fetch(`${APP_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
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

// ---- ticket mutations ----

tool(
  'create_ticket',
  'Create a ticket in an engagement backlog. Returns the new key.',
  {
    engagement_id: z.string(),
    title: z.string().min(3),
    description: z.string().optional(),
    assignee: z.string().optional(),
    est: z.string().optional().describe('Estimate label, e.g. "3d"'),
    workstream: z.string().optional(),
  },
  async ({ engagement_id, ...payload }) => {
    const t = await call('POST', `/api/engagements/${encodeURIComponent(engagement_id)}/tickets`, payload);
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
  'Queue a ticket in the Deploy to Agent lane (lead only). Higher priority claims first.',
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
  'get_git_credential',
  'Vend a short-lived (~1h) git clone/push token for a claimed task (GitHub App connections only).',
  { task_id: z.number().int(), agent: z.string() },
  async ({ task_id, agent }) => call('POST', `/api/agent/work/${task_id}/git-credential`, { agent }),
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
    const resp = await fetch(
      `${APP_URL}/api/engagements/${encodeURIComponent(engagement_id)}/context-files/${encodeURIComponent(name)}`,
      { headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(30_000) },
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
