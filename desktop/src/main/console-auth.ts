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
import http from 'node:http';
import { randomBytes } from 'node:crypto';
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
  /** "name=value" of the Better Auth session cookie (email sign-in), replayed verbatim. */
  cookie: string;
  /** A console-issued desktop session token (browser sign-in), sent as the bearer itself. */
  desktopToken?: string;
  user: ConsoleUser;
  authUrl: string;
}

const BROWSER_SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const RETURN_PAGE = `<!doctype html><meta charset="utf-8"><title>Cometloop</title>
<body style="margin:0;background:#0a0d10;color:#e7ebef;font-family:'DM Sans',system-ui,sans-serif;display:grid;place-items:center;height:100vh">
<div style="text-align:center"><div style="font-size:20px;font-weight:600">You're signed in</div><div style="margin-top:8px;color:#95a3af;font-size:14px">You can close this tab and go back to Cometloop.</div></div>`;

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

  /**
   * Sign in through the system browser: open the console's /desktop-signin
   * page with a loopback port and a nonce, wait for it to come back with a
   * one-time code, exchange the code for a desktop session token. Google
   * only works in a real browser, and no cookie of the auth host is ever
   * held here.
   */
  async signInViaBrowser(open: (url: string) => void): Promise<ConsoleUser> {
    const state = randomBytes(16).toString('base64url');
    const code = await new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const got = url.searchParams.get('code') ?? '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(RETURN_PAGE);
        clearTimeout(timer);
        server.close();
        if (url.searchParams.get('state') !== state) reject(new ConsoleAuthError('The sign-in that came back was not the one this app started.', 'STATE_MISMATCH'));
        else if (!got) reject(new ConsoleAuthError('The browser came back without a sign-in code.', 'NO_CODE'));
        else resolve(got);
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new ConsoleAuthError('No sign-in arrived from the browser within five minutes.', 'TIMEOUT'));
      }, BROWSER_SIGN_IN_TIMEOUT_MS);
      server.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const target = new URL('/desktop-signin', this.consoleUrl);
        target.searchParams.set('port', String(port));
        target.searchParams.set('state', state);
        open(target.toString());
      });
    });
    const res = await fetch(`${this.consoleUrl}/api/auth/desktop/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw await ConsoleAuth.errorOf(res, 'The console did not accept the sign-in.');
    const body = (await res.json()) as { token?: string; user?: { email?: string; name?: string } };
    if (!body.token) throw new ConsoleAuthError('The console returned no session.', 'NO_TOKEN');
    const user: ConsoleUser = { email: body.user?.email ?? '', name: body.user?.name ?? body.user?.email ?? '' };
    this.session = { cookie: '', desktopToken: body.token, user, authUrl: this.config?.provider === 'neon-auth' && this.config.url ? this.config.url : '' };
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
    // A desktop session token is the bearer itself; the console validates it.
    if (this.session.desktopToken) return this.session.desktopToken;
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
      if (s.desktopToken) {
        await fetch(`${this.consoleUrl}/api/auth/desktop/session`, { method: 'DELETE', headers: { Authorization: `Bearer ${s.desktopToken}` }, signal: AbortSignal.timeout(10_000) });
        return;
      }
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
      if ((!parsed.cookie && !parsed.desktopToken) || !parsed.user?.email) return null;
      return { cookie: parsed.cookie ?? '', desktopToken: parsed.desktopToken, authUrl: parsed.authUrl ?? '', user: { email: parsed.user.email, name: parsed.user.name ?? parsed.user.email } };
    } catch {
      return null; // unreadable/corrupt blob = signed out
    }
  }
}
