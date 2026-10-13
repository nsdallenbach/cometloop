import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { AGENT_SCHEMA_SQL, assigneeScope } from './agent-work';

/**
 * Assignee-scoped queue (DAT-227) against pg-mem: the real schema SQL runs
 * (FKs stripped, partial index skipped — pg-mem limitation), then the exact
 * predicate wait/claim build is exercised the way runners will hit it.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

const SUPPORT_SQL = [
  `CREATE SCHEMA IF NOT EXISTS app`,
  `CREATE TABLE app.tickets (key TEXT PRIMARY KEY)`,
  `CREATE TABLE app.engagements (id TEXT PRIMARY KEY)`,
];

// FKs reference tables pg-mem seeds minimally; the partial unique index uses
// a WHERE clause pg-mem cannot parse, so it is skipped — column shape and the
// DAT-227 ALTER run verbatim.
const TABLE_SQL = AGENT_SCHEMA_SQL.filter((s) => !s.includes('UNIQUE INDEX')).map((s) =>
  s
    .replace(' REFERENCES app.tickets(key) ON DELETE CASCADE', '')
    .replace(' REFERENCES app.engagements(id) ON DELETE CASCADE', ''),
);

let q: Query;

async function boot(): Promise<void> {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text: string, params?: unknown[]) => pool.query(text, params);
  for (const sql of [...SUPPORT_SQL, ...TABLE_SQL]) await q(sql);
  // Three queued tasks: shared pool, the developer's, and someone else's.
  await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, state, assignee) VALUES
    ('DAT-1', 'eng-a', 'queued', NULL),
    ('DAT-2', 'eng-a', 'queued', 'dev@example.com'),
    ('DAT-3', 'eng-a', 'queued', 'other@example.com')`);
}

/** Run the same shape of query wait/claim/work build. */
async function visibleTo(email: string | null): Promise<string[]> {
  const params: unknown[] = [];
  const where = `state = 'queued' AND ${assigneeScope(params, email)}`;
  const rows = (await q(`SELECT ticket_key FROM app.agent_tasks WHERE ${where} ORDER BY id`, params)).rows;
  return rows.map((r) => String(r.ticket_key));
}

beforeEach(async () => {
  await boot();
});

describe('assigneeScope', () => {
  it('shows an identified caller the shared pool plus their own tasks only', async () => {
    expect(await visibleTo('dev@example.com')).toEqual(['DAT-1', 'DAT-2']);
  });

  it('matches identity case-insensitively (proxy headers vary)', async () => {
    expect(await visibleTo('Dev@Example.COM')).toEqual(['DAT-1', 'DAT-2']);
  });

  it('shows an anonymous caller only the shared pool', async () => {
    expect(await visibleTo(null)).toEqual(['DAT-1']);
    expect(await visibleTo('')).toEqual(['DAT-1']);
  });

  it('never leaks another person’s assigned task', async () => {
    const seen = await visibleTo('other@example.com');
    expect(seen).toContain('DAT-3');
    expect(seen).not.toContain('DAT-2');
  });

  it('claim-style UPDATE respects the same scope', async () => {
    // other@ tries to claim with a scoped candidate list — DAT-2 is not a candidate.
    const params: unknown[] = [];
    const where = `state = 'queued' AND ${assigneeScope(params, 'other@example.com')}`;
    const candidates = (await q(`SELECT id, ticket_key FROM app.agent_tasks WHERE ${where} ORDER BY id`, params)).rows;
    expect(candidates.map((r) => String(r.ticket_key))).toEqual(['DAT-1', 'DAT-3']);
  });
});
