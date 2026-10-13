/**
 * Console sign-in (docs/platform-architecture.md §5): Neon Auth (managed
 * Better Auth) in the browser, a short-lived JWT on every API call.
 *
 * The auth URL is runtime config, not a build-time constant: one client
 * bundle serves production, staging and local, each on its own Neon branch
 * with its own auth endpoint. `GET /api/auth/config` (open, no sign-in
 * needed) says which provider fronts this deployment:
 *
 *   { provider: 'none' }                 — the Databricks Apps proxy (or
 *                                          DEV_IDENTITY_EMAIL) identifies the
 *                                          caller; nothing to do here.
 *   { provider: 'neon-auth', url }       — sign in with the Neon Auth SDK,
 *                                          then send `Authorization: Bearer
 *                                          <jwt>`, which server/identity.ts
 *                                          verifies against the branch JWKS.
 *
 * The JWT lives ~15 minutes; `accessToken()` caches it and mints a new one
 * through the SDK a minute before expiry (the Better Auth session behind it
 * is what actually persists, in the auth host's cookies).
 */

/**
 * `provider: 'none'` with an `error` means the config request itself failed
 * (server down, network) — not that the deployment has no sign-in. The
 * signed-out screen shows the error rather than guessing.
 */
export type AuthConfig = { provider: 'none'; error?: string } | { provider: 'neon-auth'; url: string };

/** `{ data, error }` as every Better Auth client call returns it. */
export interface AuthResult<T = unknown> {
  data: T | null;
  error: { message?: string; status?: number } | null;
}

/**
 * The slice of the Better Auth client the console uses. Declared here rather
 * than inferred from the SDK so the sign-in screen does not depend on the
 * SDK's (beta) type surface — the methods are Better Auth's stable public
 * API, exposed unchanged by `@neondatabase/auth`.
 */
export interface ConsoleAuthClient {
  signIn: {
    email(input: { email: string; password: string }): Promise<AuthResult>;
    social(input: { provider: 'google' | 'github'; callbackURL?: string }): Promise<AuthResult>;
  };
  signUp: {
    email(input: { email: string; password: string; name: string }): Promise<AuthResult>;
  };
  signOut(): Promise<AuthResult>;
  /** The auth host's view of the current session (who is signed in there). */
  getSession(): Promise<AuthResult<{ user?: { email?: string; name?: string } }>>;
  /** JWT plugin: a fresh token for the current session. */
  token(): Promise<AuthResult<{ token?: string }>>;
}

let configPromise: Promise<AuthConfig> | null = null;
let clientPromise: Promise<ConsoleAuthClient | null> | null = null;
let cached: { token: string; exp: number } | null = null;

export function authConfig(): Promise<AuthConfig> {
  configPromise ??= fetch('/api/auth/config')
    .then(async (r): Promise<AuthConfig> => {
      if (r.ok) return (await r.json()) as AuthConfig;
      return { provider: 'none', error: `The sign-in configuration request failed (HTTP ${r.status}).` };
    })
    .catch((e: unknown): AuthConfig => ({
      provider: 'none',
      error: `The console could not be reached to load its sign-in configuration (${e instanceof Error ? e.message : 'network error'}).`,
    }));
  return configPromise;
}

/**
 * The last reason a token could not be minted, if the most recent attempt
 * failed — surfaced by the sign-in screen when the console still answers
 * 401 after a successful sign-in at the auth host (third-party cookies
 * blocked, auth host unreachable, …). Null after a successful mint.
 */
let lastTokenError: string | null = null;
export function lastAccessTokenError(): string | null {
  return lastTokenError;
}

/** The Neon Auth client, or null when this deployment does not use it. */
export function authClient(): Promise<ConsoleAuthClient | null> {
  clientPromise ??= authConfig().then(async (cfg) => {
    if (cfg.provider !== 'neon-auth') return null;
    // Lazy: the SDK is only downloaded on deployments that sign in with it.
    const { createAuthClient } = await import('@neondatabase/auth');
    return createAuthClient(cfg.url) as unknown as ConsoleAuthClient;
  });
  return clientPromise;
}

const jwtExp = (token: string): number => {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now() + 10 * 60_000;
  } catch {
    return Date.now() + 10 * 60_000;
  }
};

/**
 * A bearer token for the API, or null when the deployment needs none (or
 * nobody is signed in — the server then answers 401 and the app shows the
 * sign-in screen). `force` drops the cache: used once after a 401.
 */
export async function accessToken(force = false): Promise<string | null> {
  const client = await authClient();
  if (!client) return null;
  if (!force && cached && Date.now() < cached.exp - 60_000) return cached.token;
  try {
    const { data, error } = await client.token();
    const token = data?.token;
    if (!token) {
      cached = null;
      lastTokenError = error?.message
        ? `The auth host refused to issue a token: ${error.message}`
        : 'The auth host has no session for this browser (sign in again; if it keeps happening, the browser is blocking the sign-in cookie).';
      return null;
    }
    cached = { token, exp: jwtExp(token) };
    lastTokenError = null;
    return token;
  } catch (e) {
    cached = null;
    lastTokenError = `Could not reach the auth host for a token (${e instanceof Error ? e.message : 'network error'}).`;
    return null;
  }
}

/** `Authorization` for a hand-rolled fetch (the typed client adds it itself). */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Append the token for transports that cannot carry a header (EventSource). */
export async function withAccessToken(url: string): Promise<string> {
  const token = await accessToken();
  if (!token) return url;
  const u = new URL(url, window.location.origin);
  u.searchParams.set('access_token', token);
  return u.pathname + u.search;
}

export async function signOut(): Promise<void> {
  cached = null;
  const client = await authClient();
  if (client) await client.signOut().catch(() => undefined);
}

/** Forget the cached token (after sign-in / sign-out) so the next call mints a fresh one. */
export function resetAccessToken(): void {
  cached = null;
}
