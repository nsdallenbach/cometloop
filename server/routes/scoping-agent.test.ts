import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePlan, refineTicketWithBoard } from './scoping-agent';
import { ProviderError, type ChatRequest, type ToolCall } from '../llm/provider';
import { installFakeProvider, memDbWithModels, resetLlm, seedProvider, type FakeReply } from '../llm/test-support';

/**
 * The board-aware refinement loop end-to-end against pg-mem, with a scripted
 * provider adapter behind the real `invokeModel('planning', …)`: a freshly
 * created ticket is refined while the "model" searches the board, reads a
 * related ticket, links it, consolidates a duplicate into the new ticket and
 * finally answers with a plan citing the board context — the DAT-173
 * acceptance path in one test.
 */

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

let q: Query;

/** Scripted planning model: answers the queued assistant turns in order and records every request. */
function scriptedModel(script: (FakeReply | string)[]) {
  const fake = installFakeProvider(q, 'anthropic', script);
  return { invocations: fake.calls.map((c) => c.request), requests: (): ChatRequest[] => fake.calls.map((c) => c.request) };
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: args });
const turn = (toolCalls: ToolCall[]): FakeReply => ({ text: '', toolCalls });

afterEach(resetLlm);

const FINAL_PLAN: FakeReply = {
  text: JSON.stringify({
    title: 'Add dark mode toggle',
    description:
      '## Context\n\nDAT-2 already tracks the theme-token groundwork this builds on.\n\n## Approach\n\nExtend the settings menu.\n\n## Dependencies\n\n- DAT-2 (theme tokens) should land first.',
    acceptance_criteria: ['Toggle persists across sessions', 'Respects system preference by default'],
    est_hours: 2,
    human_est_hours: 8,
    roadmap_item: 'Platform Hardening & Release',
  }),
};

beforeEach(async () => {
  q = await memDbWithModels(SUPPORT_SQL);
  await seedProvider(q, { roles: 'all' });
  // The board the agent will look at.
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status, description, ac) VALUES
    ('DAT-2', 'exec', 'Theme token groundwork', 'progress', 'Introduce dark-capable theme tokens across the client.', '[]'),
    ('DAT-3', 'exec', 'Dark mode switch', 'backlog', 'Add a dark mode switch to settings.', '["Switch persists"]'),
    ('OTH-1', 'other', 'Unrelated board', 'backlog', 'Dark mode elsewhere.', '[]')`);
  // The ticket being scoped, inserted raw exactly like the creation flow does.
  await q(`INSERT INTO app.tickets (key, engagement_id, title, description) VALUES ('DAT-10', 'exec', 'add dark mode', 'add dark mode')`);
});

describe('refineTicketWithBoard', () => {
  it('refines a new ticket using board context: search, read, link, consolidate, plan', async () => {
    const { requests } = scriptedModel([
      turn([toolCall('c1', 'search_tickets', { query: 'dark mode' })]),
      turn([
        toolCall('c2', 'get_ticket', { key: 'DAT-2' }),
        toolCall('c3', 'link_tickets', { other_key: 'DAT-2', type: 'blocked_by' }),
        toolCall('c4', 'consolidate_tickets', { source_keys: ['DAT-3'] }),
      ]),
      FINAL_PLAN,
    ]);
    const result = await refineTicketWithBoard(q, {
      key: 'DAT-10',
      engagementId: 'exec',
      content: 'add dark mode',
      roadmapItems: ['Platform Hardening & Release'],
      author: 'Planning Agent',
    });

    expect(result).not.toBeNull();
    if (!result) return;
    // The plan cites board context pulled from other tickets (e2e AC).
    expect(result.plan.title).toBe('Add dark mode toggle');
    expect(result.plan.description).toContain('DAT-2');
    expect(result.plan.roadmapItem).toBe('Platform Hardening & Release');
    expect(result.actions.map((a) => a.tool)).toEqual(['search_tickets', 'get_ticket', 'link_tickets', 'consolidate_tickets']);
    expect(result.actions.every((a) => a.ok)).toBe(true);

    // Working link tool call: DAT-10 blocked_by DAT-2 stores as DAT-2 blocks DAT-10.
    const links = (await q(`SELECT ticket_key, linked_key, type FROM app.ticket_links ORDER BY id`, [])).rows;
    expect(links).toContainEqual(expect.objectContaining({ ticket_key: 'DAT-2', linked_key: 'DAT-10', type: 'blocks' }));

    // Working consolidate tool call: DAT-3 folded into DAT-10 and dismissed.
    const dat3 = (await q(`SELECT status FROM app.tickets WHERE key = 'DAT-3'`, [])).rows[0];
    expect(dat3.status).toBe('dismissed');
    const dat10 = (await q(`SELECT description, ac FROM app.tickets WHERE key = 'DAT-10'`, [])).rows[0];
    expect(String(dat10.description)).toContain('## Consolidated from DAT-3 — Dark mode switch');
    const ac = typeof dat10.ac === 'string' ? (JSON.parse(dat10.ac) as string[]) : (dat10.ac as string[]);
    expect(ac).toContain('Switch persists');

    // The search results the model saw came from its own board only, self excluded.
    const invocations = requests();
    const searchReply = invocations[1].messages.find((m) => m.role === 'tool');
    expect(searchReply?.content).toContain('DAT-3');
    expect(searchReply?.content).not.toContain('OTH-1');
    expect(searchReply?.content).not.toContain('DAT-10');
    // Tool definitions rode along on every invoke, and the planning role asked for JSON.
    expect(invocations[0].tools?.length).toBe(4);
    expect(invocations[0].json).toBe(true);
  });

  it('keeps going when a tool call fails and still returns the plan', async () => {
    scriptedModel([
      turn([toolCall('c1', 'link_tickets', { other_key: 'DAT-999', type: 'relates' })]),
      turn([toolCall('c2', 'no_such_tool', {})]),
      FINAL_PLAN,
    ]);
    const result = await refineTicketWithBoard(q, { key: 'DAT-10', engagementId: 'exec', content: 'add dark mode' });
    expect(result).not.toBeNull();
    expect(result?.actions.map((a) => a.ok)).toEqual([false, false]);
  });

  it('returns null when the provider fails (caller falls back to single-shot)', async () => {
    scriptedModel([new ProviderError('endpoint down', 401)]);
    expect(await refineTicketWithBoard(q, { key: 'DAT-10', engagementId: 'exec', content: 'x' })).toBeNull();
  });

  it('returns null when no provider is mapped to the planning role', async () => {
    await q('DELETE FROM app.model_roles');
    scriptedModel([FINAL_PLAN]);
    expect(await refineTicketWithBoard(q, { key: 'DAT-10', engagementId: 'exec', content: 'x' })).toBeNull();
  });

  it('returns null when the loop never produces a parseable plan', async () => {
    scriptedModel(['no json here']);
    expect(await refineTicketWithBoard(q, { key: 'DAT-10', engagementId: 'exec', content: 'x' })).toBeNull();
  });
});

describe('parsePlan', () => {
  it('parses the contract and clamps fields', () => {
    const plan = parsePlan('{"title":"T","description":"D","acceptance_criteria":["a",""],"est_hours":1.3,"human_est_hours":5.2}');
    expect(plan).toEqual({ title: 'T', description: 'D', ac: ['a'], estHours: 1.5, humanEstHours: 5, roadmapItem: null });
  });

  it('rejects invented roadmap items and non-JSON', () => {
    expect(parsePlan('{"title":"T","description":"D","roadmap_item":"Made Up"}', ['Real'])?.roadmapItem).toBeNull();
    expect(parsePlan('nothing to see')).toBeNull();
  });
});
