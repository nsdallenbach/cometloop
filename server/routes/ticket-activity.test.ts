import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { clearTicketActivity, setTicketActivity, TICKET_ACTIVITY_SCHEMA_SQL } from './ticket-activity';
import { tenancyTestSql } from '../db/tenancy';

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

describe('ticket activity', () => {
  let q: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

  beforeEach(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg() as MemPg;
    const pool = new Pool();
    q = (text: string, params?: unknown[]) => pool.query(text, params);
    await q('CREATE SCHEMA app');
    await q('CREATE TABLE app.tickets (key TEXT PRIMARY KEY)');
    for (const sql of TICKET_ACTIVITY_SCHEMA_SQL) await q(sql);
    for (const sql of tenancyTestSql(['tickets', ...TICKET_ACTIVITY_SCHEMA_SQL.filter((s) => s.includes('CREATE TABLE'))])) await q(sql);
    await q("INSERT INTO app.tickets (key) VALUES ('DAT-219')");
  });

  it('keeps concurrent activity types independent', async () => {
    await setTicketActivity(q, 'DAT-219', 'refinement_in_progress');
    await setTicketActivity(q, 'DAT-219', 'planning_response_in_progress');
    await clearTicketActivity(q, 'DAT-219', 'refinement_in_progress');

    const { rows } = await q('SELECT activity_type FROM app.ticket_activity ORDER BY activity_type');
    expect(rows).toEqual([{ activity_type: 'planning_response_in_progress' }]);
  });

  it('is idempotent when the same flow retries', async () => {
    await setTicketActivity(q, 'DAT-219', 'refinement_in_progress');
    await setTicketActivity(q, 'DAT-219', 'refinement_in_progress');

    const { rows } = await q('SELECT activity_type FROM app.ticket_activity');
    expect(rows).toHaveLength(1);
  });
});
