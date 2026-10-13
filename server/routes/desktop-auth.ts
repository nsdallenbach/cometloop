import { createHash, randomBytes } from 'node:crypto';
import type express from 'express';
import { identityOf, setDesktopSessionStore, type Identity } from '../identity';

/**
 * Desktop sessions: how the desktop app signs in through the system browser.
 *
 * Google (and any other social provider) refuses to sign in inside an
 * embedded browser, and the desktop should not hold the auth host's cookies
 * anyway. So the desktop opens `<console>/desktop-signin?port=<loopback>` in
 * the user's own browser; the console page runs its normal sign-in (Google
 * or email), then — now holding a JWT — asks this module for a one-time
 * **handoff code** and sends the browser to `http://127.0.0.1:<port>/…` with
 * it. The desktop exchanges the code for a long-lived **desktop session
 * token** (`cldt_…`), which it sends as its bearer from then on;
 * `desktopSessionVerifier` in identity.ts turns that token back into the
 * same person. Tokens are stored hashed; a code is single-use and lives two
 * minutes; a session lives 90 days from last use and dies on sign-out.
 *
 * Both tables are global (read before any tenant is known), like the tenant
 * directory, and are queried on the owner connection.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const DESKTOP_AUTH_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.desktop_handoffs (
    code_hash TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    expires_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app.desktop_sessions (
    id SERIAL PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  )`,
];

export const HANDOFF_TTL_MS = 2 * 60_000;
export const SESSION_TTL_MS = 90 * 24 * 3_600_000;
/** `last_used_at` is bumped at most this often, so a busy desktop is one write an hour. */
const TOUCH_EVERY_MS = 3_600_000;
export const DESKTOP_TOKEN_PREFIX = 'cldt_';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(str(v)));

export const isDesktopToken = (bearer: string): boolean => bearer.startsWith(DESKTOP_TOKEN_PREFIX) && /^[a-z]+_[A-Za-z0-9_-]{40,}$/.test(bearer);

export interface DesktopDeps {
  now: () => number;
  random: (bytes: number) => string;
}
export const defaultDesktopDeps = (): DesktopDeps => ({ now: () => Date.now(), random: (n) => randomBytes(n).toString('base64url') });

/** A one-time code for the signed-in caller, to be exchanged by the desktop within two minutes. */
export async function createHandoff(q: Query, id: Identity, label: string, deps: DesktopDeps = defaultDesktopDeps()): Promise<string> {
  const code = deps.random(32);
  await q(`DELETE FROM app.desktop_handoffs WHERE expires_at < $1`, [new Date(deps.now()).toISOString()]);
  await q(`INSERT INTO app.desktop_handoffs (code_hash, subject, email, name, label, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
    sha256(code),
    id.subject,
    id.email,
    id.name,
    label.slice(0, 80),
    new Date(deps.now() + HANDOFF_TTL_MS).toISOString(),
  ]);
  return code;
}

/** Burn a code; mint the session. Null when the code is unknown, used or expired. */
export async function exchangeHandoff(q: Query, code: string, deps: DesktopDeps = defaultDesktopDeps()): Promise<{ token: string; user: { email: string; name: string } } | null> {
  const row = (await q(`DELETE FROM app.desktop_handoffs WHERE code_hash = $1 RETURNING subject, email, name, label, expires_at`, [sha256(code)])).rows[0];
  if (!row || ms(row.expires_at) < deps.now()) return null;
  const token = `${DESKTOP_TOKEN_PREFIX}${deps.random(48)}`;
  await q(`INSERT INTO app.desktop_sessions (token_hash, subject, email, name, label, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
    sha256(token),
    str(row.subject),
    str(row.email),
    str(row.name),
    str(row.label),
    new Date(deps.now() + SESSION_TTL_MS).toISOString(),
  ]);
  return { token, user: { email: str(row.email), name: str(row.name) || str(row.email) } };
}

/** The identity behind a desktop token, or null. Touches `last_used_at` and slides the expiry about once an hour. */
export async function lookupDesktopSession(q: Query, token: string, deps: DesktopDeps = defaultDesktopDeps()): Promise<Omit<Identity, 'tenantId'> | null> {
  const row = (await q(`SELECT id, subject, email, name, last_used_at, expires_at FROM app.desktop_sessions WHERE token_hash = $1`, [sha256(token)])).rows[0];
  if (!row) return null;
  const now = deps.now();
  if (ms(row.expires_at) < now) {
    await q(`DELETE FROM app.desktop_sessions WHERE id = $1`, [row.id]);
    return null;
  }
  if (now - ms(row.last_used_at) > TOUCH_EVERY_MS) {
    await q(`UPDATE app.desktop_sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1`, [row.id, new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString()]);
  }
  return { subject: str(row.subject), email: str(row.email), name: str(row.name) || str(row.email), source: 'desktop' };
}

export async function revokeDesktopSession(q: Query, token: string): Promise<boolean> {
  return (await q(`DELETE FROM app.desktop_sessions WHERE token_hash = $1 RETURNING id`, [sha256(token)])).rows.length > 0;
}

const bearerOf = (req: express.Request): string => {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return m ? m[1].trim() : '';
};

/**
 * Routes. `adminQ` is the owner connection: both tables are global.
 * `/exchange` is reachable signed-out (the desktop has nothing yet) and is
 * listed as sign-in exempt in identity.ts; `/handoff` needs the browser's
 * JWT; `/session` DELETE needs the desktop token itself.
 */
export function setupDesktopAuthRoutes(app: express.Application, adminQ: Query): void {
  setDesktopSessionStore((token) => lookupDesktopSession(adminQ, token));

  app.post('/api/auth/desktop/handoff', async (req, res) => {
    try {
      const id = identityOf(req);
      if (!id) {
        res.status(401).json({ error: 'Sign in required' });
        return;
      }
      const body = (req.body ?? {}) as { label?: unknown };
      const label = typeof body.label === 'string' ? body.label : '';
      const code = await createHandoff(adminQ, id, label);
      console.log(`[desktop-auth] handoff code issued for ${id.email}${label ? ` (${label})` : ''}`);
      res.json({ code, expiresInSeconds: HANDOFF_TTL_MS / 1000 });
    } catch (err) {
      console.error('desktop handoff failed:', err);
      res.status(500).json({ error: 'Could not start the desktop sign-in' });
    }
  });

  app.post('/api/auth/desktop/exchange', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { code?: unknown };
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!code) {
        res.status(400).json({ error: 'code required' });
        return;
      }
      const session = await exchangeHandoff(adminQ, code);
      if (!session) {
        res.status(401).json({ error: 'That sign-in link has expired or was already used. Start again from the app.' });
        return;
      }
      console.log(`[desktop-auth] desktop session issued for ${session.user.email}`);
      res.json(session);
    } catch (err) {
      console.error('desktop exchange failed:', err);
      res.status(500).json({ error: 'Could not complete the desktop sign-in' });
    }
  });

  app.delete('/api/auth/desktop/session', async (req, res) => {
    try {
      const token = bearerOf(req);
      if (!isDesktopToken(token)) {
        res.status(400).json({ error: 'No desktop session on this request' });
        return;
      }
      await revokeDesktopSession(adminQ, token);
      res.json({ ok: true });
    } catch (err) {
      console.error('desktop sign-out failed:', err);
      res.status(500).json({ error: 'Could not sign the desktop out' });
    }
  });
}
