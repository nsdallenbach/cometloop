// Credential manager: the desktop's one token authority. Off-platform
// pattern — consumers receive tokens via callback and never cache them;
// this module refreshes before expiry.
//
// Two kinds of console, one contract:
//
//  Databricks Apps proxy in front (production today). Auth order (DAT-228):
//   1. DATABRICKS_TOKEN env — dev mode, never persisted
//   2. Native OAuth — refresh token stored encrypted (safeStorage → OS
//      keychain-backed), silently renewed; first sign-in opens the browser
//   3. Databricks CLI — silent fallback for machines already logged in
//
//  The console signs users in itself (staging, local, Cometloop Cloud —
//  `consoleAuth: 'none'` / a localhost URL). The desktop signs in natively
//  with a console account (console-auth.ts), keeps the session encrypted,
//  and mints the console's JWT from it. A console with no sign-in provider
//  at all (a dev server with DEV_IDENTITY_EMAIL) needs no token: mode 'local'.
//
// When nothing works, getToken() throws SIGN_IN_REQUIRED and the UI offers
// the sign-in — and nothing else in the app starts until it succeeds.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { DesktopConfig } from './config';
import { ConsoleAuth, ConsoleAuthError } from './console-auth';
import { loginViaBrowser, refreshTokens, type TokenSet } from './oauth';

const execFileP = promisify(execFile);

const MAX_CACHE_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export const SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED';

/**
 * 'console' = signed in with a console account (Neon Auth); 'local' = the
 * console identifies callers itself with no token (dev identity). The rest
 * are the Databricks flows.
 */
export type AuthMode = 'dev-token' | 'oauth' | 'cli' | 'console' | 'signed-out' | 'local';

/** Which sign-in a console uses, as discovered at startup. */
export type AuthProvider = 'databricks' | 'neon-auth' | 'none';

export interface AuthStatus {
  mode: AuthMode;
  provider: AuthProvider;
  /** Databricks workspace host (databricks) or the console URL (console sign-in). */
  host: string;
  /** Who is signed in, when known (console account email). */
  account: string | null;
  /** Why sign-in is unavailable, when it is (config request failed). */
  error?: string;
}

/**
 * True when the console is not behind the Databricks Apps proxy: it signs
 * users in itself (or, for a dev server, identifies them itself).
 */
export function consoleSignsInItself(cfg: DesktopConfig): boolean {
  if (cfg.consoleAuth === 'none') return true;
  if (cfg.consoleAuth === 'databricks') return false;
  try {
    const host = new URL(cfg.consoleUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class CredentialManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  private mode: AuthMode = 'signed-out';
  private provider: AuthProvider = 'databricks';
  private configError: string | undefined;
  private readonly consoleAuth: ConsoleAuth | null;

  constructor(private readonly cfg: DesktopConfig) {
    if (consoleSignsInItself(cfg)) {
      this.consoleAuth = new ConsoleAuth(cfg.consoleUrl);
      this.provider = 'neon-auth'; // refined by init()
      // Until init() asks the console, nothing is signed in and nothing starts.
      this.mode = 'signed-out';
    } else {
      this.consoleAuth = null;
      if (cfg.devToken) this.mode = 'dev-token';
      else if (this.readRefreshToken()) this.mode = 'oauth';
    }
  }

  /**
   * Discover how the console signs users in (console-sign-in deployments
   * only) and settle the starting mode. Idempotent; call once at boot.
   */
  async init(): Promise<AuthStatus> {
    if (this.consoleAuth) {
      const discovered = await this.consoleAuth.discover();
      this.configError = discovered.error;
      if (discovered.provider === 'neon-auth') {
        this.provider = 'neon-auth';
        this.mode = this.consoleAuth.hasSession() ? 'console' : 'signed-out';
      } else if (!discovered.error) {
        // No provider at all: a dev server with DEV_IDENTITY_EMAIL. The
        // console identifies the caller itself; there is no token to send.
        this.provider = 'none';
        this.mode = 'local';
      } else {
        this.provider = 'none';
        this.mode = 'signed-out';
      }
    }
    return this.status();
  }

  /** Re-run discovery (after an outage): the next status() reflects it. */
  async retryDiscovery(): Promise<AuthStatus> {
    this.consoleAuth?.resetDiscovery();
    return this.init();
  }

  status(): AuthStatus {
    return {
      mode: this.mode,
      provider: this.provider,
      host: this.consoleAuth ? this.cfg.consoleUrl : this.cfg.databricksHost,
      account: this.consoleAuth?.user?.email ?? null,
      ...(this.configError ? { error: this.configError } : {}),
    };
  }

  /** Anything that talks to the console may run. */
  isSignedIn(): boolean {
    return this.mode !== 'signed-out';
  }

  /** Interactive browser sign-in to the Databricks workspace; stores the refresh token encrypted. */
  async login(): Promise<AuthStatus> {
    if (this.consoleAuth) throw new Error('This console uses a Cometloop account, not a Databricks sign-in.');
    const tokens = await loginViaBrowser(this.cfg.databricksHost);
    this.storeRefreshToken(tokens.refreshToken);
    this.cache(tokens);
    this.mode = 'oauth';
    return this.status();
  }

  /** Console account sign-in (Neon Auth). Errors carry the identity service's message. */
  async loginConsole(email: string, password: string): Promise<AuthStatus> {
    if (!this.consoleAuth || this.provider !== 'neon-auth') throw new Error('This console does not use a Cometloop account sign-in.');
    await this.consoleAuth.signIn(email, password);
    this.cached = null;
    this.mode = 'console';
    return this.status();
  }

  /** Console account sign-in through the system browser (Google works there); the app receives a desktop session. */
  async loginConsoleBrowser(open: (url: string) => void): Promise<AuthStatus> {
    if (!this.consoleAuth || this.provider !== 'neon-auth') throw new Error('This console does not use a Cometloop account sign-in.');
    await this.consoleAuth.signInViaBrowser(open);
    this.cached = null;
    this.mode = 'console';
    return this.status();
  }

  async signUpConsole(name: string, email: string, password: string): Promise<AuthStatus> {
    if (!this.consoleAuth || this.provider !== 'neon-auth') throw new Error('This console does not use a Cometloop account sign-in.');
    await this.consoleAuth.signUp(name, email, password);
    this.cached = null;
    this.mode = 'console';
    return this.status();
  }

  async signOut(): Promise<AuthStatus> {
    this.cached = null;
    if (this.consoleAuth) {
      await this.consoleAuth.signOut();
      this.mode = this.provider === 'none' && !this.configError ? 'local' : 'signed-out';
      return this.status();
    }
    try {
      rmSync(this.tokenPath(), { force: true });
    } catch {
      // best-effort — worst case the encrypted blob lingers until next sign-in
    }
    this.mode = this.cfg.devToken ? 'dev-token' : 'signed-out';
    return this.status();
  }

  /** Get a bearer token for the console, minting/refreshing as needed. */
  async getToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    // The console identifies the caller itself: no bearer token to send
    // (callers skip the Authorization header when this is empty).
    if (this.mode === 'local') return '';
    if (this.mode === 'signed-out') throw new Error(SIGN_IN_REQUIRED);
    if (!this.consoleAuth && this.cfg.devToken) return this.cfg.devToken;

    const now = Date.now();
    if (!opts?.forceRefresh && this.cached && now < this.cached.expiresAt - EXPIRY_MARGIN_MS) {
      return this.cached.token;
    }
    // Collapse concurrent refreshes into one mint.
    this.inflight ??= this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async mint(): Promise<string> {
    if (this.consoleAuth) {
      try {
        const token = await this.consoleAuth.mintToken();
        return this.cache({ accessToken: token, refreshToken: '', expiresAt: token.startsWith('cldt_') ? Date.now() + 3_600_000 : jwtExpiry(token) });
      } catch (e) {
        if (e instanceof ConsoleAuthError && (e.code === 'SESSION_EXPIRED' || e.code === 'NOT_SIGNED_IN')) {
          this.mode = 'signed-out';
          throw new Error(SIGN_IN_REQUIRED);
        }
        throw e;
      }
    }
    // Native OAuth first: silent renewal off the stored refresh token.
    const stored = this.readRefreshToken();
    if (stored) {
      try {
        const tokens = await refreshTokens(this.cfg.databricksHost, stored);
        if (tokens.refreshToken && tokens.refreshToken !== stored) this.storeRefreshToken(tokens.refreshToken);
        this.mode = 'oauth';
        return this.cache(tokens);
      } catch (e) {
        // Refresh token revoked/expired — drop it so the UI offers sign-in.
        console.warn('[auth] silent renewal failed, clearing stored token:', e instanceof Error ? e.message : e);
        await this.signOut();
      }
    }
    // CLI fallback for machines that already have a live CLI session.
    try {
      const token = await this.mintViaCli();
      this.mode = 'cli';
      return token;
    } catch {
      this.mode = 'signed-out';
      throw new Error(SIGN_IN_REQUIRED);
    }
  }

  private async mintViaCli(): Promise<string> {
    const args = ['auth', 'token', '--host', this.cfg.databricksHost];
    if (this.cfg.databricksProfile) args.push('-p', this.cfg.databricksProfile);
    const { stdout } = await execFileP(this.cfg.databricksCli, args, {
      timeout: 30_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as { access_token?: string; expiry?: string };
    if (!parsed.access_token) throw new Error('databricks auth token returned no access_token');
    const cliExpiry = parsed.expiry ? Date.parse(parsed.expiry) : NaN;
    return this.cache({
      accessToken: parsed.access_token,
      refreshToken: '',
      expiresAt: Number.isFinite(cliExpiry) ? cliExpiry : Date.now() + MAX_CACHE_MS,
    });
  }

  private cache(tokens: TokenSet): string {
    this.cached = {
      token: tokens.accessToken,
      // Never trust a token longer than the runner discipline allows.
      expiresAt: Math.min(tokens.expiresAt, Date.now() + MAX_CACHE_MS),
    };
    return tokens.accessToken;
  }

  // ---- encrypted refresh-token storage (safeStorage → DPAPI/Keychain/libsecret) ----

  private tokenPath(): string {
    return path.join(app.getPath('userData'), 'auth', 'refresh-token.bin');
  }

  private storeRefreshToken(refreshToken: string): void {
    if (!refreshToken) return;
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[auth] OS encryption unavailable — refresh token not persisted (sign-in will be per-session)');
      return;
    }
    const p = this.tokenPath();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, safeStorage.encryptString(refreshToken));
  }

  private readRefreshToken(): string | null {
    try {
      const p = this.tokenPath();
      if (!existsSync(p) || !safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(readFileSync(p));
    } catch {
      return null; // unreadable/corrupt blob = signed out
    }
  }
}

/** `exp` of a JWT in epoch ms, or ten minutes out when it cannot be read. */
function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : Date.now() + MAX_CACHE_MS;
  } catch {
    return Date.now() + MAX_CACHE_MS;
  }
}
