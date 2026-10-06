// Console account sign-in for deployments where the console signs users in
// itself (Neon Auth — managed Better Auth), as opposed to the Databricks
// Apps proxy. The desktop is the identity holder here, the same way it is
// for Databricks: it signs in natively, keeps the session encrypted at rest,
// mints the short-lived JWT the console verifies, and injects it into every
// request — the embedded console's own requests included — so the user is
// one person everywhere in the app and signs out in one place.
//
// Plain HTTP against Better Auth's routes, no SDK: the session is the signed
// `__Secure-neon-auth.session_token` cookie the sign-in response sets (the
// bearer form of the session token is not accepted by the managed host), and
// a JWT comes from GET /token with that cookie. Which host to talk to is
// discovered from the console's own `GET /api/auth/config`, so one build
// follows whichever Neon branch an environment runs on.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

export interface ConsoleAuthConfig {
  provider: 'none' | 'neon-auth';
  url?: string;
  error?: string;
}

export interface ConsoleUser {
  email: string;
  name: string;
}

interface StoredSession {
  cookie: string; // "name=value" of the session cookie, replayed verbatim
  user: ConsoleUser;
  authUrl: string;
}

export class ConsoleAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ConsoleAuthError';
  }
}

export class ConsoleAuth {
  private config: ConsoleAuthConfig | null = null;
  private session: StoredSession | null = null;

  constructor(private readonly consoleUrl: string) {
    this.session = this.readSession();
  }

  /** Ask the console which sign-in fronts it. Cached for the process lifetime. */
  async discover(): Promise<ConsoleAuthConfig> {
    if (this.config) return this.config;
    try {
      const res = await fetch(`${this.consoleUrl}/api/auth/config`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        this.config = { provider: 'none', error: `The console's sign-in configuration request failed (HTTP ${res.status}).` };
      } else {
        this.config = (await res.json()) as ConsoleAuthConfig;
      }
    } catch (e) {
      this.config = {
        provider: 'none',
        error: `The console could not be reached to load its sign-in configuration (${e instanceof Error ? e.message : 'network error'}).`,
      };
    }
    return this.config;
  }

  /** Forget the discovered config (the console URL changed, or a retry after an outage). */
  resetDiscovery(): void {
    this.config = null;
  }

  get user(): ConsoleUser | null {
    return this.session?.user ?? null;
  }

  hasSession(): boolean {
    return this.session !== null;
  }

  private authUrl(): string {
    const url = this.config?.provider === 'neon-auth' ? this.config.url : this.session?.authUrl;
    if (!url) throw new ConsoleAuthError('This console has no sign-in provider configured.', 'NO_PROVIDER');
    return url.replace(/\/+$/, '');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // Better Auth checks Origin against the branch's trusted origins; the
    // desktop acts on behalf of the console it signs in to.
    return { Origin: this.consoleUrl, ...extra };
  }

  private async authRequest(pathname: string, init: RequestInit & { cookie?: string } = {}): Promise<Response> {
    const { cookie, ...rest } = init;
    return fetch(`${this.authUrl()}${pathname}`, {
      ...rest,
      headers: this.headers({
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...((rest.headers as Record<string, string> | undefined) ?? {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
  }

  private static async errorOf(res: Response, fallback: string): Promise<ConsoleAuthError> {
    const body = (await res.json().catch(() => ({}))) as { message?: string; code?: string };
    return new ConsoleAuthError(body.message || fallback, body.code || `HTTP_${res.status}`);
  }

  private async establish(res: Response): Promise<ConsoleUser> {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const sessionCookie = setCookies.map((c) => c.split(';')[0]).find((c) => /session_token=/.test(c));
    const body = (await res.json().catch(() => ({}))) as { user?: { email?: string; name?: string } };
    if (!sessionCookie) throw new ConsoleAuthError('The identity service did not return a session.', 'NO_SESSION_COOKIE');
    const user: ConsoleUser = { email: body.user?.email ?? '', name: body.user?.name ?? body.user?.email ?? '' };
    this.session = { cookie: sessionCookie, user, authUrl: this.authUrl() };
    this.writeSession(this.session);
    return user;
  }

  async signIn(email: string, password: string): Promise<ConsoleUser> {
    const res = await this.authRequest('/sign-in/email', { method: 'POST', body: JSON.stringify({ email, password }) });
    if (!res.ok) throw await ConsoleAuth.errorOf(res, 'That email and password were not recognised.');
    return this.establish(res);
  }

  async signUp(name: string, email: string, password: string): Promise<ConsoleUser> {
    const res = await this.authRequest('/sign-up/email', { method: 'POST', body: JSON.stringify({ name, email, password }) });
    if (!res.ok) throw await ConsoleAuth.errorOf(res, 'The account could not be created.');
    return this.establish(res);
  }

  /**
   * A fresh JWT for the console (~15 minutes). Throws SESSION_EXPIRED when
   * the stored session no longer works, after forgetting it.
   */
  async mintToken(): Promise<string> {
    if (!this.session) throw new ConsoleAuthError('Not signed in.', 'NOT_SIGNED_IN');
    const res = await this.authRequest('/token', { cookie: this.session.cookie });
    if (res.status === 401) {
      this.forget();
      throw new ConsoleAuthError('Your session has expired — sign in again.', 'SESSION_EXPIRED');
    }
    if (!res.ok) throw await ConsoleAuth.errorOf(res, 'The identity service refused to issue a token.');
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new ConsoleAuthError('The identity service returned no token.', 'NO_TOKEN');
    return body.token;
  }

  async signOut(): Promise<void> {
    const s = this.session;
    this.forget();
    if (!s) return;
    try {
      await this.authRequest('/sign-out', { method: 'POST', body: '{}', cookie: s.cookie });
    } catch {
      // Best effort — the local session is gone either way; the server-side
      // session expires on its own.
    }
  }

  private forget(): void {
    this.session = null;
    try {
      rmSync(this.sessionPath(), { force: true });
    } catch {
      // worst case the encrypted blob lingers until the next sign-in overwrites it
    }
  }

  // ---- encrypted storage (safeStorage → DPAPI/Keychain/libsecret) ---------

  private sessionPath(): string {
    return path.join(app.getPath('userData'), 'auth', 'console-session.bin');
  }

  private writeSession(s: StoredSession): void {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[console-auth] OS encryption unavailable — session not persisted (sign-in will be per-run)');
      return;
    }
    const p = this.sessionPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, safeStorage.encryptString(JSON.stringify(s)));
  }

  private readSession(): StoredSession | null {
    try {
      const p = this.sessionPath();
      if (!existsSync(p) || !safeStorage.isEncryptionAvailable()) return null;
      const parsed = JSON.parse(safeStorage.decryptString(readFileSync(p))) as Partial<StoredSession>;
      if (!parsed.cookie || !parsed.authUrl || !parsed.user?.email) return null;
      return { cookie: parsed.cookie, authUrl: parsed.authUrl, user: { email: parsed.user.email, name: parsed.user.name ?? parsed.user.email } };
    } catch {
      return null; // unreadable/corrupt blob = signed out
    }
  }
}
