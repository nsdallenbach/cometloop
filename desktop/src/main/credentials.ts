// Databricks credential manager: the desktop's one token authority.
// Off-platform pattern — consumers receive tokens via callback and never
// cache them; this module refreshes before expiry. Same rules as the devbox
// runner: mint via the CLI as the signed-in dev, cache no longer than 10
// minutes, force-refresh on demand (the API client's 401 path).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopConfig } from './config';

const execFileP = promisify(execFile);

const MAX_CACHE_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class CredentialManager {
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly cfg: DesktopConfig) {}

  /** Get a workspace OAuth bearer token, minting/refreshing as needed. */
  async getToken(opts?: { forceRefresh?: boolean }): Promise<string> {
    if (this.cfg.devToken) return this.cfg.devToken; // dev mode: env-supplied PAT/token

    const now = Date.now();
    if (!opts?.forceRefresh && this.cached && now < this.cached.expiresAt - EXPIRY_MARGIN_MS) {
      return this.cached.token;
    }
    // Collapse concurrent refreshes into one CLI call.
    this.inflight ??= this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async mint(): Promise<string> {
    const args = ['auth', 'token', '--host', this.cfg.databricksHost];
    if (this.cfg.databricksProfile) args.push('-p', this.cfg.databricksProfile);
    const { stdout } = await execFileP(this.cfg.databricksCli, args, {
      timeout: 30_000,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout) as { access_token?: string; expiry?: string };
    if (!parsed.access_token) throw new Error('databricks auth token returned no access_token');
    const cliExpiry = parsed.expiry ? Date.parse(parsed.expiry) : NaN;
    const expiresAt = Math.min(
      Number.isFinite(cliExpiry) ? cliExpiry : Date.now() + MAX_CACHE_MS,
      Date.now() + MAX_CACHE_MS,
    );
    this.cached = { token: parsed.access_token, expiresAt };
    return parsed.access_token;
  }
}
