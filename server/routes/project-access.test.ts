import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { accessibleProjectIds, canAccessProject } from './project-access';

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
let q: Query;

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as unknown as {
    Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  };
  const pool = new Pool();
  q = (text, params) => pool.query(text, params);
  await q('CREATE SCHEMA app');
  await q('CREATE TABLE app.team_members (id SERIAL PRIMARY KEY, email TEXT)');
  await q('CREATE TABLE app.engagement_members (engagement_id TEXT, member_id INT)');
  await q('CREATE TABLE app.engagement_leads (engagement_id TEXT, email TEXT)');
  await q("INSERT INTO app.team_members (email) VALUES ('dev@datavail.com'), (NULL)");
  await q("INSERT INTO app.engagement_members VALUES ('project-a', 1), ('project-b', 2)");
  await q("INSERT INTO app.engagement_leads VALUES ('project-c', 'lead@datavail.com')");
});

describe('project runner access inheritance', () => {
  it('grants an assigned developer only that project', async () => {
    const developer = { email: 'DEV@datavail.com', role: 'developer' as const };
    expect(await canAccessProject(q, developer, 'project-a')).toBe(true);
    expect(await canAccessProject(q, developer, 'project-b')).toBe(false);
    expect(await accessibleProjectIds(q, developer)).toEqual(['project-a']);
  });

  it('lets assigned leads and admins inherit access', async () => {
    expect(await canAccessProject(q, { email: 'lead@datavail.com', role: 'lead' }, 'project-c')).toBe(true);
    expect(await accessibleProjectIds(q, { email: 'admin@datavail.com', role: 'admin' })).toBeNull();
  });

  it('does not grant access from a name-only legacy membership', async () => {
    expect(await canAccessProject(q, { email: 'someone@datavail.com', role: 'developer' }, 'project-b')).toBe(false);
  });
});
