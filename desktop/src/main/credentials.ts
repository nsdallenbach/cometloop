// Databricks credential manager: the desktop's one token authority.
// Off-platform pattern — consumers receive tokens via callback and never
// cache them; this module refreshes before expiry.
//
// Auth order (DAT-228):
//   1. DATABRICKS_TOKEN env — dev mode, never persisted
//   2. Native OAuth — refresh token stored encrypted (safeStorage → OS
//      keychain-backed), silently renewed; first sign-in opens the browser
//   3. Databricks CLI — silent fallback for machines already logged in
// When none work, getToken() throws SIGN_IN_REQUIRED and the UI offers the
// browser sign-in.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import type { DesktopConfig } from './config';
import { loginViaBrowser, refreshTokens, type TokenSet } from './oauth';

const execFileP = promisify(execFile);

const MAX_CACHE_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export const SIGN_IN_REQUIRED = 'SIGN_IN_REQUIRED';

export type AuthMode = 'dev-token' | 'oauth' | 'cli' | 'signed-out';

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class CredentialManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;
  private mode: AuthMode = 'signed-out';

  constructor(private readonly cfg: DesktopConfig) {
    if (cfg.devToken) this.mode = 'dev-token';
    else if (this.readRefreshToken()) this.mode = 'oauth';
  }

  status(): { mode: AuthMode; host: string } {
    return { mode: this.mode, host: this.cfg.databricksHost };
  }

  /** Interactive browser sign-in; stores the refresh token encrypted. */
  async login(): Promise<{ mode: AuthMode }> {
    const tokens = await loginViaBrowser(this.cfg.databricksHost);
    this.storeRefreshToken(tokens.refreshToken);
    this.cache(tokens);
    this.mode = 'oauth';
    return { mode: this.mode };
  }

  signOut(): { mode: AuthMode } {
    try {
      rmSync(this.tokenPath(), { force: true });
    } catch {
      // best-effort — worst case the encrypted blob lingers until next sign-in
    }
    this.cached = null;
    this.mode = this.cfg.devToken ? 'dev-token' : 'signed-out';
    return { mode: this.mode };
  }

  /** Get a workspace bearer token, minting/refreshing as needed. */
  async getToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    if (this.cfg.devToken) return this.cfg.devToken;

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
        this.signOut();
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
