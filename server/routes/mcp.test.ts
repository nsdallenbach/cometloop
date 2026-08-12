import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { handleMcpMessage } from './mcp';

/** The MCP JSON-RPC surface against pg-mem: handshake, discovery, tool calls. */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const SUPPORT_SQL = [
  `CREATE SCHEMA app`,
  `CREATE TABLE app.tickets (
    key TEXT PRIMARY KEY,
    engagement_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'backlog',
    assignee TEXT NOT NULL DEFAULT '—',
    est TEXT NOT NULL DEFAULT '—',
    workstream TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    ac JSONB NOT NULL DEFAULT '[]',
    blocked BOOLEAN NOT NULL DEFAULT false,
    seq SERIAL
  )`,
  `CREATE TABLE app.ticket_links (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL,
    linked_key TEXT NOT NULL,
    type TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    UNIQUE (ticket_key, linked_key, type)
  )`,
  `CREATE TABLE app.ticket_comments (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE TABLE app.feed_items (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    text TEXT NOT NULL,
    time_label TEXT NOT NULL,
    reversible BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE TABLE app.agent_tasks (id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, state TEXT NOT NULL)`,
];

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of SUPPORT_SQL) await q(sql);
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status, description) VALUES
    ('DAT-1', 'exec', 'Dark mode toggle', 'backlog', 'Add a dark mode toggle to settings.'),
    ('DAT-2', 'exec', 'Billing export', 'backlog', 'Export invoices as CSV.')`);
});

const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, params });

function toolText(response: Record<string, unknown> | null): string {
  const result = response?.result as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
}

describe('handleMcpMessage', () => {
  it('answers initialize with capabilities and echoes a known protocol version', async () => {
    const response = await handleMcpMessage(q, rpc('initialize', { protocolVersion: '2025-03-26' }), 'tester');
    expect(response?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'delivery-console' },
    });
    const fallback = await handleMcpMessage(q, rpc('initialize', { protocolVersion: '1999-01-01' }), 'tester');
    expect((fallback?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it('ignores notifications (no id → no response)', async () => {
    expect(await handleMcpMessage(q, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'tester')).toBeNull();
  });

  it('lists the four board tools with JSON Schema inputs', async () => {
    const response = await handleMcpMessage(q, rpc('tools/list'), 'tester');
    const tools = (response?.result as { tools: { name: string; inputSchema: { type: string } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(['search_tickets', 'get_ticket', 'link_tickets', 'consolidate_tickets']);
    expect(tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
  });

  it('calls search_tickets with an explicit engagement id', async () => {
    const response = await handleMcpMessage(
      q,
      rpc('tools/call', { name: 'search_tickets', arguments: { engagement_id: 'exec', query: 'dark' } }),
      'tester',
    );
    const text = toolText(response);
    expect(text).toContain('DAT-1');
    expect(text).not.toContain('DAT-2');
  });

  it('calls link_tickets and reports tool errors with isError', async () => {
    const linked = await handleMcpMessage(
      q,
      rpc('tools/call', { name: 'link_tickets', arguments: { key: 'DAT-1', other_key: 'DAT-2', type: 'relates' } }),
      'tester',
    );
    expect(toolText(linked)).toContain('DAT-1 relates to DAT-2');
    const links = (await q('SELECT ticket_key, linked_key FROM app.ticket_links', [])).rows;
    expect(links).toHaveLength(1);

    const bad = await handleMcpMessage(q, rpc('tools/call', { name: 'link_tickets', arguments: { key: 'DAT-1' } }), 'tester');
    expect(bad?.result).toMatchObject({ isError: true });
  });

  it('rejects unknown methods', async () => {
    const response = await handleMcpMessage(q, rpc('resources/list'), 'tester');
    expect(response?.error).toMatchObject({ code: -32601 });
  });
});
