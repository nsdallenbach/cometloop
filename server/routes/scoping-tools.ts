import { addTicketLink, type LinkInput } from './ticket-links';
import { consolidateTickets } from './ticket-consolidate';

/**
 * Board tools for the ticket-scoping agent (DAT-173) — one definition list,
 * two consumers:
 *  - the serving-endpoint tool-calling loop (scoping-agent.ts), where the
 *    tools are scoped to one engagement and the ticket being refined;
 *  - the MCP endpoint (mcp.ts), where callers pass explicit keys and an
 *    engagement id.
 * The `parameters` blocks are plain JSON Schema, which is what both the
 * chat-completions `tools` array and MCP `inputSchema` expect.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface ScopingToolContext {
  q: Query;
  /** Restrict reads/writes to this engagement; when unset (MCP), search_tickets requires engagement_id. */
  engagementId?: string;
  /** The ticket being scoped — default subject for link_tickets/consolidate_tickets. */
  selfKey?: string;
  /** Comment author for link/consolidate side effects. */
  author: string;
  /** feed_items actor: 'AGENT' for the scoping loop, 'YOU' for humans via MCP. */
  feedActor?: string;
}

export type ScopingToolResult = { ok: true; summary: string; data: unknown } | { ok: false; summary: string; error: string };

/** Max tool calls honored from a single model turn — a runaway turn gets truncated, not obeyed. */
export const SCOPING_TOOL_LIMIT = 8;

const SEARCH_LIMIT_DEFAULT = 30;
const SEARCH_LIMIT_MAX = 100;
const SNIPPET_CHARS = 280;

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface ScopingToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Tool definitions. With `selfKey` set (agent loop) the link/consolidate
 * subject defaults to the ticket being scoped and search is engagement-bound;
 * without it (MCP) every subject is explicit.
 */
export function scopingToolDefs(opts: { selfKey?: string } = {}): ScopingToolDef[] {
  const self = opts.selfKey;
  return [
    {
      name: 'search_tickets',
      description: self
        ? `Search the engagement board for tickets by keyword (title + description match, most recent first). Returns key, title, status and a description snippet. ${self} itself is excluded.`
        : 'Search an engagement board for tickets by keyword (title + description match, most recent first). Returns key, title, status and a description snippet.',
      parameters: {
        type: 'object',
        properties: {
          ...(self ? {} : { engagement_id: { type: 'string', description: 'Engagement (board) id to search' } }),
          query: { type: 'string', description: 'Keywords to match in title or description; omit to list the board' },
          status: { type: 'string', enum: ['backlog', 'proposed', 'progress', 'review', 'done'], description: 'Only tickets in this status' },
          limit: { type: 'integer', minimum: 1, maximum: SEARCH_LIMIT_MAX, description: `Max results (default ${SEARCH_LIMIT_DEFAULT})` },
        },
        required: self ? [] : ['engagement_id'],
      },
    },
    {
      name: 'get_ticket',
      description: 'Full detail for one ticket: description, acceptance criteria, status, links to other tickets, recent comments.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Ticket key, e.g. DAT-42' } },
        required: ['key'],
      },
    },
    {
      name: 'link_tickets',
      description: self
        ? `Record a relationship between ${self} and another board ticket. Types: relates (related work), blocks (${self} blocks the other), blocked_by (${self} is blocked by the other).`
        : 'Record a relationship between two tickets on the same board. Types: relates, blocks (key blocks other_key), blocked_by (key is blocked by other_key).',
      parameters: {
        type: 'object',
        properties: {
          ...(self
            ? { key: { type: 'string', description: `Subject ticket (defaults to ${self})` } }
            : { key: { type: 'string', description: 'Subject ticket key' } }),
          other_key: { type: 'string', description: 'The other ticket key' },
          type: { type: 'string', enum: ['relates', 'blocks', 'blocked_by'] },
        },
        required: self ? ['other_key', 'type'] : ['key', 'other_key', 'type'],
      },
    },
    {
      name: 'consolidate_tickets',
      description: self
        ? `Merge duplicate/overlapping tickets into ${self}: their descriptions and acceptance criteria fold into ${self} and they leave the board (dismissed, with a comment pointing here). Only for tickets that describe substantially the same work.`
        : 'Merge duplicate/overlapping source tickets into a surviving target: descriptions and acceptance criteria fold into the target and the sources are dismissed with a pointer comment. Only for tickets that describe substantially the same work.',
      parameters: {
        type: 'object',
        properties: {
          ...(self
            ? { target_key: { type: 'string', description: `Surviving ticket (defaults to ${self})` } }
            : { target_key: { type: 'string', description: 'Surviving ticket key' } }),
          source_keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Tickets to merge into the target' },
        },
        required: self ? ['source_keys'] : ['target_key', 'source_keys'],
      },
    },
  ];
}

const fail = (summary: string, error: string): ScopingToolResult => ({ ok: false, summary, error });

async function searchTickets(ctx: ScopingToolContext, args: Record<string, unknown>): Promise<ScopingToolResult> {
  const engagementId = ctx.engagementId ?? txt(args.engagement_id);
  if (!engagementId) return fail('search_tickets', 'engagement_id is required');
  const query = txt(args.query).trim();
  const status = txt(args.status).trim();
  const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : SEARCH_LIMIT_DEFAULT;
  const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, limitRaw));

  const where: string[] = [`engagement_id = $1`, `status <> 'dismissed'`];
  const params: unknown[] = [engagementId];
  if (ctx.selfKey) {
    params.push(ctx.selfKey);
    where.push(`key <> $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  // Every term must appear somewhere in title+description (AND of ORs).
  for (const term of query.split(/\s+/).filter(Boolean).slice(0, 8)) {
    params.push(`%${term}%`);
    where.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
  }
  params.push(limit);
  const rows = (
    await ctx.q(
      `SELECT key, title, status, assignee, est, workstream, blocked, description
       FROM app.tickets WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const tickets = rows.map((r) => ({
    key: txt(r.key),
    title: txt(r.title),
    status: txt(r.status),
    assignee: txt(r.assignee),
    est: txt(r.est),
    workstream: txt(r.workstream) || undefined,
    blocked: r.blocked === true || undefined,
    snippet: txt(r.description).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS) || undefined,
  }));
  return { ok: true, summary: `search_tickets(${query || 'all'}) → ${tickets.length}`, data: { tickets } };
}

async function getTicket(ctx: ScopingToolContext, args: Record<string, unknown>): Promise<ScopingToolResult> {
  const key = txt(args.key).trim();
  if (!key) return fail('get_ticket', 'key is required');
  const row = (await ctx.q('SELECT * FROM app.tickets WHERE key = $1', [key])).rows[0];
  if (!row || (ctx.engagementId && txt(row.engagement_id) !== ctx.engagementId)) {
    return fail(`get_ticket(${key})`, `Ticket ${key} not found on this board`);
  }
  const ac = (() => {
    try {
      const arr: unknown = typeof row.ac === 'string' ? JSON.parse(row.ac) : row.ac;
      return Array.isArray(arr) ? arr.map(txt).filter(Boolean) : [];
    } catch {
      return [];
    }
  })();
  const links = (
    await ctx.q('SELECT ticket_key, linked_key, type FROM app.ticket_links WHERE ticket_key = $1 OR linked_key = $1 ORDER BY id', [key])
  ).rows.map((l) => {
    const outgoing = txt(l.ticket_key) === key;
    const type = txt(l.type) === 'blocks' ? (outgoing ? 'blocks' : 'blocked_by') : 'relates';
    return { key: outgoing ? txt(l.linked_key) : txt(l.ticket_key), type };
  });
  const comments = (
    await ctx.q('SELECT author, body FROM app.ticket_comments WHERE ticket_key = $1 ORDER BY id DESC LIMIT 5', [key])
  ).rows.map((c) => ({ author: txt(c.author), body: txt(c.body).slice(0, 600) }));
  return {
    ok: true,
    summary: `get_ticket(${key})`,
    data: {
      key,
      title: txt(row.title),
      status: txt(row.status),
      assignee: txt(row.assignee),
      est: txt(row.est),
      workstream: txt(row.workstream) || undefined,
      description: txt(row.description),
      acceptance_criteria: ac,
      links,
      recent_comments: comments.reverse(),
    },
  };
}

async function linkTickets(ctx: ScopingToolContext, args: Record<string, unknown>): Promise<ScopingToolResult> {
  const key = txt(args.key).trim() || ctx.selfKey || '';
  const otherKey = txt(args.other_key).trim();
  const type = txt(args.type).trim() as LinkInput;
  if (!key || !otherKey) return fail('link_tickets', 'key and other_key are required');
  if (!['relates', 'blocks', 'blocked_by'].includes(type)) return fail('link_tickets', 'type must be relates, blocks or blocked_by');
  const result = await addTicketLink(ctx.q, key, otherKey, type, ctx.author, ctx.feedActor ?? 'YOU');
  if (!result.ok) return fail(`link_tickets(${key}, ${otherKey})`, result.error);
  return { ok: true, summary: `link_tickets: ${result.described}`, data: { linked: result.described } };
}

async function consolidate(ctx: ScopingToolContext, args: Record<string, unknown>): Promise<ScopingToolResult> {
  const targetKey = txt(args.target_key).trim() || ctx.selfKey || '';
  const sourceKeys = Array.isArray(args.source_keys) ? args.source_keys.map(txt).filter(Boolean) : [];
  if (!targetKey || sourceKeys.length === 0) return fail('consolidate_tickets', 'target_key and a non-empty source_keys list are required');
  if (ctx.engagementId) {
    // Engagement-scoped callers only touch their own board; cross-board
    // sources fail inside consolidateTickets anyway, this fails the target too.
    const row = (await ctx.q('SELECT engagement_id FROM app.tickets WHERE key = $1', [targetKey])).rows[0];
    if (!row || txt(row.engagement_id) !== ctx.engagementId) {
      return fail(`consolidate_tickets(${targetKey})`, `Ticket ${targetKey} not found on this board`);
    }
  }
  const result = await consolidateTickets(ctx.q, targetKey, sourceKeys, ctx.author, ctx.feedActor ?? 'YOU');
  if (!result.ok) return fail(`consolidate_tickets(${targetKey})`, result.error);
  return {
    ok: true,
    summary: `consolidate_tickets: ${result.merged.map((m) => m.key).join(', ')} → ${result.targetKey}`,
    data: { target: result.targetKey, merged: result.merged, acceptance_criteria_count: result.acCount },
  };
}

export async function executeScopingTool(ctx: ScopingToolContext, name: string, args: Record<string, unknown>): Promise<ScopingToolResult> {
  try {
    switch (name) {
      case 'search_tickets':
        return await searchTickets(ctx, args);
      case 'get_ticket':
        return await getTicket(ctx, args);
      case 'link_tickets':
        return await linkTickets(ctx, args);
      case 'consolidate_tickets':
        return await consolidate(ctx, args);
      default:
        return fail(name || '(unnamed tool)', `Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(name, (err as Error).message);
  }
}
