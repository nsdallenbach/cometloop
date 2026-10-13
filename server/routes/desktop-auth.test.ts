import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { DESKTOP_AUTH_SCHEMA_SQL, createHandoff, exchangeHandoff, isDesktopToken, lookupDesktopSession, revokeDesktopSession, type DesktopDeps } from './desktop-auth';
import type { Identity } from '../identity';

/**
 * The desktop sign-in handoff against pg-mem: a code is single-use and
 * short-lived, a session comes back as the same person, expires, slides on
 * use, and dies on sign-out. Tokens never sit in the tables in the clear.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

let q: Query;
let clock = Date.parse('2026-10-13T12:00:00Z');
let counter = 0;
const deps: DesktopDeps = { now: () => clock, random: (n) => `r${n}_${String(++counter).padStart(44, '0')}` };
const nigel: Identity = { subject: 'usr_1', email: 'nigel@example.com', name: 'Nigel', source: 'better-auth', tenantId: 't_cometloop' };

beforeEach(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  q = (text, params) => pool.query(text, params);
  await q('CREATE SCHEMA IF NOT EXISTS app');
  for (const sql of DESKTOP_AUTH_SCHEMA_SQL) await q(sql);
  clock = Date.parse('2026-10-13T12:00:00Z');
  counter = 0;
});

describe('handoff → session', () => {
  it('exchanges a code once for a desktop token that resolves to the same person', async () => {
    const code = await createHandoff(q, nigel, 'Nigel’s laptop', deps);
    expect((await q('SELECT code_hash FROM app.desktop_handoffs')).rows[0].code_hash).not.toContain(code);
    const session = await exchangeHandoff(q, code, deps);
    expect(session?.user).toEqual({ email: 'nigel@example.com', name: 'Nigel' });
    expect(session?.token.startsWith('cldt_')).toBe(true);
    expect(isDesktopToken(session?.token ?? '')).toBe(true);
    expect((await q('SELECT token_hash FROM app.desktop_sessions')).rows[0].token_hash).not.toContain(session?.token);
    // Second use of the code: refused.
    expect(await exchangeHandoff(q, code, deps)).toBeNull();
    const who = await lookupDesktopSession(q, session?.token ?? '', deps);
    expect(who).toEqual({ subject: 'usr_1', email: 'nigel@example.com', name: 'Nigel', source: 'desktop' });
  });

  it('refuses an expired or unknown code', async () => {
    const code = await createHandoff(q, nigel, '', deps);
    clock += 3 * 60_000;
    expect(await exchangeHandoff(q, code, deps)).toBeNull();
    expect(await exchangeHandoff(q, 'nope', deps)).toBeNull();
  });

  it('a session slides on use, expires after 90 idle days, and dies on sign-out', async () => {
    const code = await createHandoff(q, nigel, '', deps);
    const { token } = (await exchangeHandoff(q, code, deps)) as { token: string };
    clock += 10 * 24 * 3_600_000;
    expect(await lookupDesktopSession(q, token, deps)).not.toBeNull();
    const after = (await q('SELECT expires_at FROM app.desktop_sessions')).rows[0].expires_at as Date;
    expect(after.getTime()).toBe(clock + 90 * 24 * 3_600_000);
    clock += 91 * 24 * 3_600_000;
    expect(await lookupDesktopSession(q, token, deps)).toBeNull();
    expect((await q('SELECT id FROM app.desktop_sessions')).rows).toHaveLength(0);

    const code2 = await createHandoff(q, nigel, '', deps);
    const { token: t2 } = (await exchangeHandoff(q, code2, deps)) as { token: string };
    expect(await revokeDesktopSession(q, t2)).toBe(true);
    expect(await lookupDesktopSession(q, t2, deps)).toBeNull();
    expect(await revokeDesktopSession(q, t2)).toBe(false);
  });

  it('only accepts the desktop token shape', () => {
    expect(isDesktopToken('cldt_' + 'a'.repeat(40))).toBe(true);
    expect(isDesktopToken('eyJhbGciOi.eyJzdWIi.sig')).toBe(false);
    expect(isDesktopToken('cldt_short')).toBe(false);
  });
});
