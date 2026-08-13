import { z } from 'zod';
import type express from 'express';
import { resolveIdentity } from './roles';
import { activeEngagementFor, enforceAgentAction } from './agent-security';

/**
 * Inter-agent coordination channel (DAT-149).
 *
 * Multiple autonomous agents work concurrently on different branches of the
 * same repository. This module gives them a shared, durable coordination
 * store in Lakebase Postgres:
 *
 *   - app.coordination_messages — append-only message log (status updates,
 *     conflict warnings, requests for info, handoffs, pokes). Rows are never
 *     deleted, so the full conversation stays queryable for audit.
 *   - app.branch_activity — who is working which branch right now, with a
 *     heartbeat, so agents can check for overlapping work before starting.
 *
 * Agents reach the store through the console's HTTP API (authenticated via
 * the Databricks Apps OAuth proxy, exactly like the agent work-queue
 * endpoints); the console executes the SQL against Lakebase through the
 * appkit lakebase plugin, which owns connection management and OAuth token
 * refresh. New messages are detected by polling with an indexed id cursor —
 * see docs/agent-coordination.md for why polling was chosen over
 * LISTEN/NOTIFY and why agents need no client-side connection pooling.
 *
 * Attention without deadlock: every agent has an id (its runner name). A
 * message can target a recipient agent and carry an SLA — 'interrupt' (react
 * before continuing) or 'wait' (react before completing the ticket) — so an
 * agent can poke another to get an answer without both sides blocking.
 * Targeted messages are mirrored as @-tagged comments on the ticket the
 * recipient is working (or has in review), so humans can follow and review
 * the whole exchange from the board, like a developer conversation.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const COORDINATION_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.coordination_messages (
    id BIGSERIAL PRIMARY KEY,
    sender_agent_id TEXT NOT NULL,
    recipient_agent_id TEXT,
    branch_name TEXT,
    ticket_key TEXT,
    message_type TEXT NOT NULL,
    sla TEXT,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Cursor polling reads WHERE id > $since; created_at serves time-window audit queries.
  `CREATE INDEX IF NOT EXISTS coordination_messages_created_at ON app.coordination_messages (created_at)`,
  `CREATE INDEX IF NOT EXISTS coordination_messages_recipient ON app.coordination_messages (recipient_agent_id, id)`,
  `CREATE TABLE IF NOT EXISTS app.branch_activity (
    branch_name TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    ticket_key TEXT,
    task_description TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'active'
  )`,
  `CREATE INDEX IF NOT EXISTS branch_activity_status ON app.branch_activity (status)`,
];

export const MESSAGE_TYPES = ['status_update', 'conflict_warning', 'request_for_info', 'handoff', 'poke', 'response'] as const;
export const SLAS = ['interrupt', 'wait'] as const;

export interface CoordinationMessage {
  sender: string;
  type: (typeof MESSAGE_TYPES)[number];
  body: string;
  recipient?: string | null;
  branch?: string | null;
  ticket?: string | null;
  sla?: (typeof SLAS)[number] | null;
  data?: Record<string, unknown> | null;
}

/**
 * Append a message to the coordination log and mirror it into the ticket
 * conversation when there is a ticket to mirror to. Mirroring is best-effort:
 * a comment failure never loses the coordination message itself.
 */
export async function postCoordinationMessage(
  q: Query,
  msg: CoordinationMessage,
  opts: { mirror?: boolean } = {},
): Promise<Record<string, unknown>> {
  const payload = { body: msg.body, ...(msg.data ? { data: msg.data } : {}) };
  const inserted = (
    await q(
      `INSERT INTO app.coordination_messages (sender_agent_id, recipient_agent_id, branch_name, ticket_key, message_type, sla, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [msg.sender, msg.recipient ?? null, msg.branch ?? null, msg.ticket ?? null, msg.type, msg.sla ?? null, JSON.stringify(payload)],
    )
  ).rows[0];
  if (opts.mirror !== false) {
    try {
      await mirrorToTicketComment(q, msg);
    } catch (err) {
      console.warn('[coordination] ticket-comment mirror failed:', (err as Error).message);
    }
  }
  return inserted;
}

/** The ticket an agent is currently working, or (failing that) has in review. */
async function agentTicket(q: Query, agent: string): Promise<string | null> {
  const active = (
    await q(`SELECT ticket_key FROM app.agent_tasks WHERE agent = $1 AND state IN ('claimed','working') ORDER BY id DESC LIMIT 1`, [agent])
  ).rows[0];
  if (active) return String(active.ticket_key);
  const review = (
    await q(`SELECT key FROM app.tickets WHERE assignee = $1 AND status = 'review' ORDER BY seq DESC LIMIT 1`, [agent])
  ).rows[0];
  return review ? String(review.key) : null;
}

/**
 * Human-review mirror: every coordination message appears as a ticket comment
 * so the whole cross-agent conversation is visible on the board — no need to
 * open the channel. A message lands on the sender's active ticket (so an agent
 * sees its own outgoing messages) and, for targeted messages, the recipient's
 * ticket too; an explicit `ticket` on the message is always included. Distinct
 * tickets each get one comment. A message with no resolvable ticket at all
 * stays in the coordination log only.
 */
async function mirrorToTicketComment(q: Query, msg: CoordinationMessage): Promise<void> {
  const tickets = new Set<string>();
  if (msg.ticket) tickets.add(msg.ticket);
  const fromSender = await agentTicket(q, msg.sender);
  if (fromSender) tickets.add(fromSender);
  if (msg.recipient) {
    const fromRecipient = await agentTicket(q, msg.recipient);
    if (fromRecipient) tickets.add(fromRecipient);
  }
  if (tickets.size === 0) return;
  // Structured sentinel: the client parses the metadata into a styled agent-
  // comment header (type badge, → recipient, branch) and renders the message
  // body with ticket-key and @mention highlighting. A client without support
  // still shows the plain header line after the sentinel.
  const header = `${msg.recipient ? `→ @${msg.recipient}` : 'broadcast'} · ${msg.type.replace(/_/g, ' ')}${msg.sla ? ` · SLA ${msg.sla}` : ''}${msg.branch ? ` · ${msg.branch}` : ''}`;
  const meta = JSON.stringify({ type: msg.type, to: msg.recipient ?? null, branch: msg.branch ?? null, sla: msg.sla ?? null });
  const body = `::coord::${meta}\n${header}\n${msg.body}`;
  for (const ticketKey of tickets) {
    await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [ticketKey, msg.sender, body]);
  }
  // Surface in each affected engagement's status feed too, so agent-to-agent
  // traffic is visible on the feed, not just inside ticket threads.
  const engagements = (
    await q('SELECT DISTINCT engagement_id FROM app.tickets WHERE key = ANY($1)', [[...tickets]])
  ).rows;
  const short = msg.body.replace(/\s+/g, ' ').trim().slice(0, 140);
  const feedText = `${msg.sender} ${msg.recipient ? `→ @${msg.recipient}` : '(broadcast)'} · ${msg.type.replace(/_/g, ' ')}: ${short}`;
  for (const e of engagements) {
    await q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
       VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
      [String(e.engagement_id), feedText],
    );
  }
}

export interface FetchOptions {
  sinceId?: number;
  /** Return messages addressed to this agent (broadcasts included, own messages excluded). */
  forAgent?: string;
  branch?: string;
  type?: string;
  limit?: number;
}

/**
 * Cursor poll: everything newer than the last seen id, oldest first. Pass the
 * returned nextSinceId back on the next call — the (recipient, id) and pk
 * indexes make each poll incremental, never a table scan.
 */
export async function fetchCoordinationMessages(
  q: Query,
  opts: FetchOptions,
): Promise<{ messages: Record<string, unknown>[]; nextSinceId: number }> {
  const sinceId = opts.sinceId ?? 0;
  const filters = ['id > $1'];
  const params: unknown[] = [sinceId];
  if (opts.forAgent) {
    params.push(opts.forAgent);
    filters.push(`(recipient_agent_id IS NULL OR recipient_agent_id = $${params.length})`);
    filters.push(`sender_agent_id <> $${params.length}`);
  }
  if (opts.branch) {
    params.push(opts.branch);
    filters.push(`branch_name = $${params.length}`);
  }
  if (opts.type) {
    params.push(opts.type);
    filters.push(`message_type = $${params.length}`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  const { rows } = await q(
    `SELECT * FROM app.coordination_messages WHERE ${filters.join(' AND ')} ORDER BY id LIMIT $${params.length}`,
    params,
  );
  const last = rows.length > 0 ? Number(rows[rows.length - 1].id) : sinceId;
  return { messages: rows, nextSinceId: last };
}

export interface BranchAnnouncement {
  branch: string;
  agent: string;
  ticket?: string | null;
  description?: string | null;
  status?: 'active' | 'completed';
}

/**
 * Announce or refresh work on a branch. Re-announcing is the heartbeat: the
 * same call updates last_heartbeat, so runners can ping it periodically.
 * Announcing an existing branch as 'active' again (e.g. a second run on the
 * same ticket) takes it over and restarts the clock.
 */
export async function announceBranchActivity(q: Query, a: BranchAnnouncement): Promise<Record<string, unknown>> {
  const { rows } = await q(
    `INSERT INTO app.branch_activity AS ba (branch_name, agent_id, ticket_key, task_description, status)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (branch_name) DO UPDATE SET
       agent_id = EXCLUDED.agent_id,
       ticket_key = COALESCE(EXCLUDED.ticket_key, ba.ticket_key),
       task_description = CASE WHEN EXCLUDED.task_description <> '' THEN EXCLUDED.task_description ELSE ba.task_description END,
       started_at = CASE WHEN ba.status = 'completed' AND EXCLUDED.status = 'active' THEN NOW() ELSE ba.started_at END,
       last_heartbeat = NOW(),
       status = EXCLUDED.status
     RETURNING *`,
    [a.branch, a.agent, a.ticket ?? null, a.description ?? '', a.status ?? 'active'],
  );
  return rows[0];
}

/** Currently active branches (or completed history), most recent work first. */
export async function listBranchActivity(q: Query, status = 'active'): Promise<Record<string, unknown>[]> {
  return (await q(`SELECT * FROM app.branch_activity WHERE status = $1 ORDER BY last_heartbeat DESC`, [status])).rows;
}

/**
 * Close out an agent's active branches (all of them, or just one ticket's)
 * when its run completes. Wired into the agent work-queue completion
 * endpoint so branch_activity stays honest even if the agent forgets.
 */
export async function completeAgentBranches(q: Query, agent: string, ticket?: string | null): Promise<string[]> {
  const params: unknown[] = [agent];
  let where = `agent_id = $1 AND status = 'active'`;
  if (ticket) {
    params.push(ticket);
    where += ` AND ticket_key = $${params.length}`;
  }
  const { rows } = await q(`UPDATE app.branch_activity SET status = 'completed', last_heartbeat = NOW() WHERE ${where} RETURNING branch_name`, params);
  return rows.map((r) => String(r.branch_name));
}

const MessageBody = z.object({
  sender: z.string().min(1).max(80),
  type: z.enum(MESSAGE_TYPES),
  body: z.string().min(1).max(8000),
  recipient: z.string().min(1).max(80).optional(),
  branch: z.string().min(1).max(200).optional(),
  ticket: z.string().min(1).max(40).optional(),
  sla: z.enum(SLAS).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const BranchBody = z.object({
  branch: z.string().min(1).max(200),
  agent: z.string().min(1).max(80),
  ticket: z.string().min(1).max(40).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'completed']).optional(),
});

/**
 * Runner-facing endpoints, authenticated through the Databricks Apps OAuth
 * proxy like the rest of /api/agent. Acting as an agent name additionally
 * requires owning an active claim under that name: the claim records the
 * caller's workspace identity (agent_identity), so senders can't be spoofed,
 * targeted inboxes can't be read by other principals, and branch
 * announcements can't be taken over.
 */
export function setupCoordinationRoutes(app: express.Application, q: Query) {
  /** True while the caller's workspace identity owns an active claim as `agent`. */
  async function callerOwnsAgent(req: express.Request, agent: string): Promise<boolean> {
    const who = await resolveIdentity(req);
    const rows = (
      await q(
        `SELECT 1 FROM app.agent_tasks WHERE agent = $1 AND agent_identity = $2 AND state IN ('claimed','working') LIMIT 1`,
        [agent, who.email],
      )
    ).rows;
    return rows.length > 0;
  }

  /**
   * Security gate (DAT-212): the agent's own settings must allow 'coordination'.
   * Scoped to the engagement of the claim it is working — callerOwnsAgent has
   * already established there is one.
   */
  async function coordinationAllowed(res: express.Response, agent: string, detail: string): Promise<boolean> {
    const engagementId = await activeEngagementFor(q, agent);
    if (!engagementId) return true;
    return await enforceAgentAction(res, q, { engagementId, agent, action: 'coordination', detail });
  }

  app.post('/api/agent/coordination/messages', async (req, res) => {
    const parsed = MessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'sender, type and body are required (type: ' + MESSAGE_TYPES.join('|') + ')' });
      return;
    }
    try {
      const m = parsed.data;
      if (!(await callerOwnsAgent(req, m.sender))) {
        res.status(403).json({ error: 'sender must own an active claimed task under that agent name' });
        return;
      }
      if (!(await coordinationAllowed(res, m.sender, `${m.type} → ${m.recipient ?? 'all'}`))) return;
      const row = await postCoordinationMessage(q, m);
      console.log(
        `[coordination] ${m.sender} → ${m.recipient ?? 'all'}: ${m.type}${m.sla ? ` (SLA ${m.sla})` : ''}${m.branch ? ` on ${m.branch}` : ''} (message ${String(row.id)})`,
      );
      res.status(201).json(row);
    } catch (err) {
      console.error('coordination post failed:', err);
      res.status(500).json({ error: 'Failed to post coordination message' });
    }
  });

  app.get('/api/agent/coordination/messages', async (req, res) => {
    try {
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const forAgent = str(req.query.agent);
      // Reading a named inbox requires owning that agent's active claim;
      // anonymous reads see broadcasts only, never targeted messages.
      if (forAgent && !(await callerOwnsAgent(req, forAgent))) {
        res.status(403).json({ error: 'reading an agent inbox requires an active claimed task under that name' });
        return;
      }
      const sinceRaw = Number(str(req.query.since_id) ?? 0);
      const result = await fetchCoordinationMessages(q, {
        sinceId: Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0,
        forAgent,
        branch: str(req.query.branch),
        type: str(req.query.type),
        limit: Number(str(req.query.limit)) || undefined,
      });
      const messages = forAgent ? result.messages : result.messages.filter((m) => m.recipient == null);
      res.json({ messages, next_since_id: result.nextSinceId });
    } catch (err) {
      console.error('coordination fetch failed:', err);
      res.status(500).json({ error: 'Failed to fetch coordination messages' });
    }
  });

  app.post('/api/agent/coordination/branches', async (req, res) => {
    const parsed = BranchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'branch and agent are required' });
      return;
    }
    try {
      if (!(await callerOwnsAgent(req, parsed.data.agent))) {
        res.status(403).json({ error: 'announcing requires an active claimed task under that agent name' });
        return;
      }
      if (!(await coordinationAllowed(res, parsed.data.agent, parsed.data.branch))) return;
      // A branch actively announced by another agent can't be taken over or
      // marked completed on its behalf.
      const existing = (
        await q('SELECT agent_id, status FROM app.branch_activity WHERE branch_name = $1', [parsed.data.branch])
      ).rows[0];
      if (existing && String(existing.status) === 'active' && String(existing.agent_id) !== parsed.data.agent) {
        res.status(409).json({ error: `Branch is actively announced by ${String(existing.agent_id)}` });
        return;
      }
      const row = await announceBranchActivity(q, parsed.data);
      console.log(`[coordination] ${parsed.data.agent} announced ${parsed.data.branch} (${String(row.status)})`);
      res.json(row);
    } catch (err) {
      console.error('branch announce failed:', err);
      res.status(500).json({ error: 'Failed to announce branch activity' });
    }
  });

  app.get('/api/agent/coordination/branches', async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : 'active';
      res.json({ branches: await listBranchActivity(q, status) });
    } catch (err) {
      console.error('branch list failed:', err);
      res.status(500).json({ error: 'Failed to list branch activity' });
    }
  });
}
