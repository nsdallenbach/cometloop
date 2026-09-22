import type express from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Who is calling — one module, one answer, fail closed.
 *
 * Every `/api/*` request passes through `requireSignIn` (below), which runs
 * the verifiers in order and stores the result on the request. Nothing else
 * in the server reads the identity headers or cookies directly: routes ask
 * `identityOf(req)` / `resolveIdentity(req)`, and the role logic in
 * `routes/roles.ts` builds on the `Identity` this module returns.
 *
 * Verifiers, in order — each returns null when its inputs are absent:
 *
 * 1. `databricks` — the `x-forwarded-*` headers the Databricks Apps OAuth
 *    proxy sets after authenticating the caller (browser users, the desktop
 *    client, MCP clients and runners all arrive this way in production).
 * 2. `better-auth` — a Better Auth / Neon Auth JWT, either `Authorization:
 *    Bearer <jwt>` or the session cookie, verified against the JWKS at
 *    `NEON_AUTH_JWKS_URL`. Inactive until that variable is set.
 * 3. `dev` — `DEV_IDENTITY_EMAIL`, for local development only. It is never a
 *    default: without the variable a proxy-less local server answers 401.
 */

export type IdentitySource = 'databricks' | 'better-auth' | 'dev';

export interface Identity {
  /** Stable id from the verifier (Databricks user id, JWT `sub`, or the dev email). */
  subject: string;
  email: string;
  name: string;
  source: IdentitySource;
  /**
   * Databricks only: the user's workspace access token the proxy forwarded,
   * which `roles.ts` uses for the group lookup. Never logged or echoed.
   */
  accessToken?: string;
}

export type Verifier = (req: express.Request) => Identity | null | Promise<Identity | null>;

function headerValue(req: express.Request, name: string): string {
  const h = req.headers[name];
  const v = Array.isArray(h) ? h[0] : h;
  return v?.trim() ?? '';
}

/** Databricks Apps proxy headers. Same precedence the console has always used. */
export const databricksVerifier = (req: express.Request): Identity | null => {
  const email = headerValue(req, 'x-forwarded-preferred-username') || headerValue(req, 'x-forwarded-email');
  if (!email) return null;
  const token = headerValue(req, 'x-forwarded-access-token');
  return {
    subject: headerValue(req, 'x-forwarded-user') || email,
    email,
    name: email,
    source: 'databricks',
    ...(token ? { accessToken: token } : {}),
  };
};

// One remote JWKS per URL, cached by jose (keys are refetched on unknown kid,
// rate-limited) — so verification does not hit the auth host per request.
let jwks: { url: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;
function jwksFor(url: string) {
  if (!jwks || jwks.url !== url) jwks = { url, set: createRemoteJWKSet(new URL(url)) };
  return jwks.set;
}

/** Test seam: forget the cached JWKS so a new URL / stub takes effect. */
export function resetJwksCache(): void {
  jwks = null;
}

const SESSION_COOKIES = ['__Secure-better-auth.session_token', 'better-auth.session_token'];

function cookieValue(req: express.Request, name: string): string {
  const raw = headerValue(req, 'cookie');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return '';
}

/** A compact JWS has exactly three base64url segments; anything else is not a JWT. */
const looksLikeJwt = (s: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(s);

function betterAuthToken(req: express.Request): string {
  const auth = headerValue(req, 'authorization');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && looksLikeJwt(m[1].trim())) return m[1].trim();
  const cookieName = process.env.NEON_AUTH_COOKIE?.trim();
  for (const name of cookieName ? [cookieName] : SESSION_COOKIES) {
    const v = cookieValue(req, name);
    if (v && looksLikeJwt(v)) return v;
  }
  return '';
}

const claimString = (payload: JWTPayload, key: string): string => {
  const v = payload[key];
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * Better Auth / Neon Auth JWT, verified against `NEON_AUTH_JWKS_URL`.
 * `NEON_AUTH_ISSUER` and `NEON_AUTH_AUDIENCE`, when set, are enforced too.
 * An expired, unsigned, or foreign token resolves to null — never to an error.
 */
export const betterAuthVerifier: Verifier = async (req) => {
  const jwksUrl = process.env.NEON_AUTH_JWKS_URL?.trim();
  if (!jwksUrl) return null;
  const token = betterAuthToken(req);
  if (!token) return null;
  try {
    const issuer = process.env.NEON_AUTH_ISSUER?.trim();
    const audience = process.env.NEON_AUTH_AUDIENCE?.trim();
    const { payload } = await jwtVerify(token, jwksFor(jwksUrl), {
      ...(issuer ? { issuer } : {}),
      ...(audience ? { audience } : {}),
    });
    const subject = claimString(payload, 'sub');
    const email = claimString(payload, 'email');
    if (!subject || !email) return null;
    return { subject, email, name: claimString(payload, 'name') || email, source: 'better-auth' };
  } catch (err) {
    console.warn('[identity] better-auth token rejected:', (err as Error).message);
    return null;
  }
};

/**
 * LOCAL DEVELOPMENT ONLY. `DEV_IDENTITY_EMAIL=you@example.com` stands in for
 * the proxy on a laptop where no `x-forwarded-*` headers exist. It must be set
 * explicitly and is never inferred; leave it unset everywhere that is deployed.
 */
export const devVerifier = (_req: express.Request): Identity | null => {
  const email = process.env.DEV_IDENTITY_EMAIL?.trim();
  if (!email) return null;
  return { subject: email, email, name: process.env.DEV_IDENTITY_NAME?.trim() || email, source: 'dev' };
};

export const VERIFIERS: readonly Verifier[] = [databricksVerifier, betterAuthVerifier, devVerifier];

// Per-request memo so the middleware, the role lookup and the author helper
// all share one verification (and one JWKS round trip at most).
const resolved = new WeakMap<express.Request, Promise<Identity | null>>();

/** Run the verifiers in order; the first identity wins, none → null. */
export function resolveIdentity(req: express.Request, verifiers: readonly Verifier[] = VERIFIERS): Promise<Identity | null> {
  const hit = resolved.get(req);
  if (hit) return hit;
  const p = (async () => {
    for (const verify of verifiers) {
      const id = await verify(req);
      if (id) return id;
    }
    return null;
  })();
  resolved.set(req, p);
  return p;
}

const settled = new WeakMap<express.Request, Identity | null>();

/**
 * The identity `requireSignIn` already resolved for this request, or — for a
 * request that never passed through it (tests, non-/api paths) — whatever the
 * synchronous verifiers (databricks, dev) say. Never triggers a network call.
 */
export function identityOf(req: express.Request): Identity | null {
  if (settled.has(req)) return settled.get(req) ?? null;
  return databricksVerifier(req) ?? devVerifier(req) ?? null;
}

/** Display name for attribution (comments, feed items, audit lines). */
export function requestAuthor(req: express.Request, fallback = 'You'): string {
  return identityOf(req)?.email || fallback;
}

/**
 * Routes that stay reachable without a console sign-in. Everything the
 * runner / desktop machinery calls with its own workspace credentials lives
 * under `/api/agent/` (docs/devbox-integration.md); those routes keep the auth
 * they had — the Databricks Apps proxy in front, and `resolveIdentity` for
 * attribution and assignee scoping inside. AppKit's `/health` is not under
 * `/api` and is listed for completeness.
 */
export const SIGN_IN_EXEMPT_PREFIXES: readonly string[] = ['/health', '/api/health', '/api/agent/'];

export function isSignInExempt(path: string): boolean {
  return SIGN_IN_EXEMPT_PREFIXES.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/**
 * Fail-closed gate for `/api/*`: resolves the identity once per request,
 * then answers 401 unless one was found or the path is exempt. Mount before
 * every route module, and only there — the exemption list is the single
 * place that says what is open.
 */
export function requireSignIn(): express.RequestHandler {
  return (req, res, next) => {
    resolveIdentity(req).then(
      (id) => {
        settled.set(req, id);
        // req.path is relative to the mount point; the exemption list is absolute.
        if (id || isSignInExempt(`${req.baseUrl}${req.path}`)) {
          next();
          return;
        }
        res.status(401).json({ error: 'Sign in required' });
      },
      (err: unknown) => {
        console.error('[identity] resolution failed:', err);
        res.status(401).json({ error: 'Sign in required' });
      },
    );
  };
}
