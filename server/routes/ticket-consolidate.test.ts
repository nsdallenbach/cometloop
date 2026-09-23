import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { consolidateTickets, consolidatedTail, mergeAcceptanceCriteria } from './ticket-consolidate';
import { tenancyTestSql } from '../db/tenancy';

/**
 * Consolidation against pg-mem — the same SQL the console runs on Lakebase.
 * Minimal stand-ins for the console tables (no FKs; the real schema's
 * references don't change the merge logic under test).
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

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;

async function seedTicket(key: string, fields: Partial<{ engagement: string; title: string; status: string; description: string; ac: string[] }> = {}) {
  await q(`INSERT INTO app.tickets (key, engagement_id, title, status, description, ac) VALUES ($1,$2,$3,$4,$5,$6)`, [
    key,
    fields.engagement ?? 'exec',
    fields.title ?? `Ticket ${key}`,
    fields.status ?? 'backlog',
    fields.description ?? '',
    JSON.stringify(fields.ac ?? []),
  ]);
}

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of SUPPORT_SQL) await q(sql);
  for (const sql of tenancyTestSql(SUPPORT_SQL)) await q(sql);
});

describe('consolidateTickets', () => {
  it('folds source description + AC into the target and dismisses the source', async () => {
    await seedTicket('DAT-1', { description: 'Build the thing.', ac: ['Thing builds'] });
    await seedTicket('DAT-2', { title: 'Duplicate ask', description: 'Also build the thing.', ac: ['Thing builds', 'Thing ships'] });
    const result = await consolidateTickets(q, 'DAT-1', ['DAT-2'], 'Planning Agent', 'AGENT');
    expect(result).toMatchObject({ ok: true, targetKey: 'DAT-1', merged: [{ key: 'DAT-2', title: 'Duplicate ask' }], acCount: 2 });

    const target = (await q('SELECT description, ac, status FROM app.tickets WHERE key = $1', ['DAT-1'])).rows[0];
    expect(String(target.description)).toContain('## Consolidated from DAT-2 — Duplicate ask');
    expect(String(target.description)).toContain('Also build the thing.');
    const ac = typeof target.ac === 'string' ? (JSON.parse(target.ac) as string[]) : (target.ac as string[]);
    expect(ac).toEqual(['Thing builds', 'Thing ships']);

    const source = (await q('SELECT status FROM app.tickets WHERE key = $1', ['DAT-2'])).rows[0];
    expect(source.status).toBe('dismissed');
    const comments = (await q('SELECT ticket_key, body FROM app.ticket_comments ORDER BY id', [])).rows;
    expect(comments.some((c) => c.ticket_key === 'DAT-2' && String(c.body).includes('Consolidated into DAT-1'))).toBe(true);
    expect(comments.some((c) => c.ticket_key === 'DAT-1' && String(c.body).includes('Consolidated DAT-2'))).toBe(true);
    const feed = (await q('SELECT actor, text FROM app.feed_items', [])).rows;
    expect(feed).toHaveLength(1);
    expect(feed[0].actor).toBe('AGENT');
  });

  it('repoints the source links onto the target, dropping would-be self-links', async () => {
    await seedTicket('DAT-1');
    await seedTicket('DAT-2');
    await seedTicket('DAT-3');
    // DAT-2 blocks DAT-3, and DAT-2 relates to the target itself.
    await q(`INSERT INTO app.ticket_links (ticket_key, linked_key, type) VALUES ('DAT-2','DAT-3','blocks'), ('DAT-2','DAT-1','relates')`, []);
    const result = await consolidateTickets(q, 'DAT-1', ['DAT-2'], 'lead');
    expect(result.ok).toBe(true);
    const links = (await q('SELECT ticket_key, linked_key, type FROM app.ticket_links ORDER BY id', [])).rows;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ ticket_key: 'DAT-1', linked_key: 'DAT-3', type: 'blocks' });
  });

  it('consolidates several sources at once', async () => {
    await seedTicket('DAT-1', { ac: ['A'] });
    await seedTicket('DAT-2', { ac: ['B'] });
    await seedTicket('DAT-3', { ac: ['a'], status: 'proposed' });
    const result = await consolidateTickets(q, 'DAT-1', ['DAT-2', 'DAT-3'], 'lead');
    expect(result).toMatchObject({ ok: true, acCount: 2 }); // 'a' dedupes against 'A'
    const statuses = (await q(`SELECT key, status FROM app.tickets ORDER BY key`, [])).rows;
    expect(statuses.map((r) => `${String(r.key)}:${String(r.status)}`)).toEqual(['DAT-1:backlog', 'DAT-2:dismissed', 'DAT-3:dismissed']);
  });

  it('refuses cross-engagement sources, missing tickets, done sources and self-merge', async () => {
    await seedTicket('DAT-1');
    await seedTicket('OTH-1', { engagement: 'other' });
    await seedTicket('DAT-4', { status: 'done' });
    expect((await consolidateTickets(q, 'DAT-1', ['OTH-1'], 'lead')).ok).toBe(false);
    expect((await consolidateTickets(q, 'DAT-1', ['DAT-99'], 'lead')).ok).toBe(false);
    expect((await consolidateTickets(q, 'DAT-1', ['DAT-4'], 'lead')).ok).toBe(false);
    expect((await consolidateTickets(q, 'DAT-1', ['DAT-1'], 'lead')).ok).toBe(false);
    expect((await consolidateTickets(q, 'DAT-99', ['DAT-1'], 'lead')).ok).toBe(false);
  });

  it('refuses sources with active agent work', async () => {
    await seedTicket('DAT-1');
    await seedTicket('DAT-2');
    await q(`INSERT INTO app.agent_tasks (ticket_key, state) VALUES ('DAT-2','working')`, []);
    const result = await consolidateTickets(q, 'DAT-1', ['DAT-2'], 'lead');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('active agent work');
    // A finished run does not block.
    await q(`UPDATE app.agent_tasks SET state = 'done'`, []);
    expect((await consolidateTickets(q, 'DAT-1', ['DAT-2'], 'lead')).ok).toBe(true);
  });
});

describe('mergeAcceptanceCriteria', () => {
  it('unions with first-occurrence-wins dedupe, case/whitespace-insensitive', () => {
    expect(mergeAcceptanceCriteria(['A ships', 'B works'], ['  a ships  ', 'C done'])).toEqual(['A ships', 'B works', 'C done']);
  });

  it('drops empties and caps the union', () => {
    const many = Array.from({ length: 30 }, (_, i) => `AC ${i}`);
    expect(mergeAcceptanceCriteria(['', '  '], many)).toHaveLength(20);
  });
});

describe('consolidatedTail', () => {
  it('returns the consolidated sections tail', () => {
    const desc = '## Context\n\nStuff.\n\n## Consolidated from DAT-2 — Dup\n\nBody.\n\n## Consolidated from DAT-3 — Dup2\n\nMore.';
    expect(consolidatedTail(desc)).toBe('## Consolidated from DAT-2 — Dup\n\nBody.\n\n## Consolidated from DAT-3 — Dup2\n\nMore.');
  });

  it('returns empty when no consolidated sections exist', () => {
    expect(consolidatedTail('## Context\n\nJust a plan.')).toBe('');
  });
});
