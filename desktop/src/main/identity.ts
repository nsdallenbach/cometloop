// Identity broker (DAT-235, phase B): the desktop's non-Databricks identities.
// Device-code sign-ins for GitHub, Azure and Azure DevOps with login state per
// provider, plus per-MCP-server secrets — everything at rest is encrypted via
// safeStorage (DPAPI/Keychain/libsecret), never plaintext in files.
//
// Same public-client precedent as the Databricks flow (oauth.ts reuses the
// registered `databricks-cli` client): GitHub uses the gh CLI's device-flow
// client, Azure/ADO use the Azure CLI's — no app registrations of our own.
//
// Consumers (runner.ts) receive tokens via getAccessToken() and never cache
// them; Microsoft tokens renew silently off the stored refresh token.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, safeStorage, shell } from 'electron';

export type IdentityProvider = 'github' | 'azure' | 'ado';
export const IDENTITY_PROVIDERS: IdentityProvider[] = ['github', 'azure', 'ado'];

const GITHUB_CLIENT_ID = '178c6fc778ccc68e1d6a'; // GitHub CLI (gh), device flow enabled
const GITHUB_SCOPE = 'repo read:org workflow';
const MS_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; // Azure CLI (az), public client
const MS_AUTHORITY = 'https://login.microsoftonline.com/organizations';
/** Azure DevOps' first-party AAD app id — scopes a token to the ADO API/git. */
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const MS_SCOPES: Record<'azure' | 'ado', string> = {
  azure: 'https://management.azure.com/.default offline_access openid profile',
  ado: `${ADO_RESOURCE}/.default offline_access openid profile`,
};

const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export interface DeviceCodePrompt {
  userCode: string;
  verificationUri: string;
}

export interface ProviderStatus {
  provider: IdentityProvider;
  state: 'signed-in' | 'signed-out' | 'pending';
  account: string | null;
  /** Present while a device-code sign-in waits on the browser. */
  prompt?: DeviceCodePrompt;
}

export interface McpAuthRow {
  name: string;
  hasSecret: boolean;
}

interface StoredIdentity {
  account: string;
  /** GitHub device-flow tokens don't expire; Microsoft access tokens do. */
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms, for accessToken when it expires
}

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export class IdentityBroker {
  /** In-memory copy so sign-ins survive `safeStorage` being unavailable. */
  private session = new Map<IdentityProvider, StoredIdentity>();
  private cache = new Map<IdentityProvider, { token: string; expiresAt: number }>();
  private pending = new Map<IdentityProvider, DeviceCodePrompt>();
  private inflight = new Map<IdentityProvider, Promise<ProviderStatus>>();
  private mcpSecrets: Record<string, string> | null = null;

  constructor(private readonly notify: (status: ProviderStatus) => void) {}

  status(): ProviderStatus[] {
    return IDENTITY_PROVIDERS.map((provider) => this.statusOf(provider));
  }

  statusOf(provider: IdentityProvider): ProviderStatus {
    const prompt = this.pending.get(provider);
    if (prompt) return { provider, state: 'pending', account: null, prompt };
    const stored = this.load(provider);
    return stored
      ? { provider, state: 'signed-in', account: stored.account }
      : { provider, state: 'signed-out', account: null };
  }

  /**
   * Device-code sign-in: opens the browser on the provider's verification
   * page, surfaces the user code via the notify callback (and statusOf while
   * pending), and resolves once the browser side completes. Idempotent per
   * provider — a second call while one is pending joins it.
   */
  login(provider: IdentityProvider): Promise<ProviderStatus> {
    const running = this.inflight.get(provider);
    if (running) return running;
    const p = this.runLogin(provider).finally(() => {
      this.inflight.delete(provider);
    });
    this.inflight.set(provider, p);
    return p;
  }

  private async runLogin(provider: IdentityProvider): Promise<ProviderStatus> {
    try {
      const identity = provider === 'github' ? await this.githubDeviceFlow() : await this.msDeviceFlow(provider);
      this.pending.delete(provider);
      this.store(provider, identity);
      if (identity.accessToken && identity.expiresAt) {
        this.cache.set(provider, { token: identity.accessToken, expiresAt: identity.expiresAt });
      }
      const s = this.statusOf(provider);
      this.notify(s);
      return s;
    } catch (e) {
      this.pending.delete(provider);
      this.notify(this.statusOf(provider));
      throw e;
    }
  }

  signOut(provider: IdentityProvider): ProviderStatus[] {
    try {
      rmSync(this.identityPath(provider), { force: true });
    } catch {
      // best-effort — worst case the encrypted blob lingers until next sign-in
    }
    this.session.delete(provider);
    this.cache.delete(provider);
    this.pending.delete(provider);
    this.notify(this.statusOf(provider));
    return this.status();
  }

  /**
   * A live access token for the provider, or null when signed out (callers
   * fall back — e.g. the runner drops to local git credentials). Microsoft
   * tokens renew silently before expiry; GitHub device-flow tokens are
   * long-lived and returned as stored.
   */
  async getAccessToken(provider: IdentityProvider): Promise<string | null> {
    const stored = this.load(provider);
    if (!stored) return null;
    if (provider === 'github') return stored.accessToken ?? null;

    const cached = this.cache.get(provider);
    if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached.token;
    if (stored.accessToken && stored.expiresAt && Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS) {
      this.cache.set(provider, { token: stored.accessToken, expiresAt: stored.expiresAt });
      return stored.accessToken;
    }
    if (!stored.refreshToken) return null;

    const res = await postForm<TokenResponse>(`${MS_AUTHORITY}/oauth2/v2.0/token`, {
      client_id: MS_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      scope: MS_SCOPES[provider === 'azure' ? 'azure' : 'ado'],
    });
    if (!res.access_token) {
      // invalid_grant = revoked/expired refresh token → signed out for real;
      // anything else (network blip, AAD hiccup) keeps the stored identity.
      console.warn(`[identity] ${provider} renewal failed: ${res.error ?? 'no access_token'}`);
      if (res.error === 'invalid_grant') this.signOut(provider);
      return null;
    }
    const expiresAt = Date.now() + (res.expires_in ?? 3600) * 1000;
    this.store(provider, {
      ...stored,
      accessToken: res.access_token,
      // Refresh-token rotation: a renewal may or may not issue a new one.
      refreshToken: res.refresh_token ?? stored.refreshToken,
      expiresAt,
    });
    this.cache.set(provider, { token: res.access_token, expiresAt });
    return res.access_token;
  }

  // ---- device flows ----

  private promptUser(provider: IdentityProvider, prompt: DeviceCodePrompt): void {
    this.pending.set(provider, prompt);
    this.notify({ provider, state: 'pending', account: null, prompt });
    void shell.openExternal(prompt.verificationUri);
  }

  private async githubDeviceFlow(): Promise<StoredIdentity> {
    const dc = await postForm<DeviceCodeResponse>('https://github.com/login/device/code', {
      client_id: GITHUB_CLIENT_ID,
      scope: GITHUB_SCOPE,
    });
    if (!dc.device_code || !dc.user_code || !dc.verification_uri) {
      throw new Error(`GitHub refused the device-code request: ${dc.error_description ?? dc.error ?? 'no device code'}`);
    }
    this.promptUser('github', { userCode: dc.user_code, verificationUri: dc.verification_uri });

    const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
    let intervalMs = (dc.interval ?? 5) * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const res = await postForm<TokenResponse>('https://github.com/login/oauth/access_token', {
        client_id: GITHUB_CLIENT_ID,
        device_code: dc.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (res.access_token) {
        return { account: await fetchGithubLogin(res.access_token), accessToken: res.access_token };
      }
      if (res.error === 'authorization_pending') continue;
      if (res.error === 'slow_down') {
        intervalMs += 5000;
        continue;
      }
      throw new Error(
        res.error === 'access_denied'
          ? 'Sign-in was refused in the browser'
          : `GitHub sign-in failed: ${res.error_description ?? res.error ?? 'unknown error'}`,
      );
    }
    throw new Error('GitHub sign-in timed out — the device code expired');
  }

  private async msDeviceFlow(provider: 'azure' | 'ado'): Promise<StoredIdentity> {
    const scope = MS_SCOPES[provider];
    const dc = await postForm<DeviceCodeResponse>(`${MS_AUTHORITY}/oauth2/v2.0/devicecode`, {
      client_id: MS_CLIENT_ID,
      scope,
    });
    if (!dc.device_code || !dc.user_code || !dc.verification_uri) {
      throw new Error(`Microsoft refused the device-code request: ${dc.error_description?.split('\n')[0] ?? dc.error ?? 'no device code'}`);
    }
    this.promptUser(provider, { userCode: dc.user_code, verificationUri: dc.verification_uri });

    const deadline = Date.now() + (dc.expires_in ?? 900) * 1000;
    let intervalMs = (dc.interval ?? 5) * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      const res = await postForm<TokenResponse>(`${MS_AUTHORITY}/oauth2/v2.0/token`, {
        client_id: MS_CLIENT_ID,
        device_code: dc.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
      if (res.access_token) {
        const claims = res.id_token ? jwtClaims(res.id_token) : {};
        const account =
          typeof claims.preferred_username === 'string'
            ? claims.preferred_username
            : typeof claims.upn === 'string'
              ? claims.upn
              : 'Microsoft account';
        return {
          account,
          accessToken: res.access_token,
          refreshToken: res.refresh_token,
          expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000,
        };
      }
      if (res.error === 'authorization_pending') continue;
      if (res.error === 'slow_down') {
        intervalMs += 5000;
        continue;
      }
      throw new Error(
        res.error === 'authorization_declined'
          ? 'Sign-in was refused in the browser'
          : res.error === 'expired_token'
            ? 'Microsoft sign-in timed out — the device code expired'
            : `Microsoft sign-in failed: ${res.error_description?.split('\n')[0] ?? res.error ?? 'unknown error'}`,
      );
    }
    throw new Error('Microsoft sign-in timed out — the device code expired');
  }

  // ---- per-MCP-server secrets ----

  mcpList(): McpAuthRow[] {
    return Object.keys(this.loadMcpSecrets())
      .sort()
      .map((name) => ({ name, hasSecret: true }));
  }

  setMcpSecret(name: string, secret: string): McpAuthRow[] {
    const secrets = this.loadMcpSecrets();
    secrets[name] = secret;
    this.saveMcpSecrets(secrets);
    return this.mcpList();
  }

  clearMcpSecret(name: string): McpAuthRow[] {
    const secrets = this.loadMcpSecrets();
    delete secrets[name];
    this.saveMcpSecrets(secrets);
    return this.mcpList();
  }

  /**
   * MCP secrets as env for harness runs: `MCP_AUTH_<SLUG>` per server. Secrets
   * ride process env into the run, never the workdir's .mcp.json.
   */
  mcpEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, secret] of Object.entries(this.loadMcpSecrets())) {
      env[`MCP_AUTH_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] = secret;
    }
    return env;
  }

  // ---- encrypted storage (safeStorage → DPAPI/Keychain/libsecret) ----

  private authDir(): string {
    return path.join(app.getPath('userData'), 'auth');
  }

  private identityPath(provider: IdentityProvider): string {
    return path.join(this.authDir(), `identity-${provider}.bin`);
  }

  private mcpSecretsPath(): string {
    return path.join(this.authDir(), 'mcp-secrets.bin');
  }

  private load(provider: IdentityProvider): StoredIdentity | null {
    const live = this.session.get(provider);
    if (live) return live;
    const parsed = this.readEncryptedJson<StoredIdentity>(this.identityPath(provider));
    if (parsed && typeof parsed.account === 'string') {
      this.session.set(provider, parsed);
      return parsed;
    }
    return null;
  }

  private store(provider: IdentityProvider, identity: StoredIdentity): void {
    this.session.set(provider, identity);
    this.writeEncryptedJson(this.identityPath(provider), identity, `${provider} sign-in`);
  }

  private loadMcpSecrets(): Record<string, string> {
    this.mcpSecrets ??= this.readEncryptedJson<Record<string, string>>(this.mcpSecretsPath()) ?? {};
    return this.mcpSecrets;
  }

  private saveMcpSecrets(secrets: Record<string, string>): void {
    this.mcpSecrets = secrets;
    if (Object.keys(secrets).length === 0) {
      try {
        rmSync(this.mcpSecretsPath(), { force: true });
      } catch {
        // best-effort
      }
      return;
    }
    this.writeEncryptedJson(this.mcpSecretsPath(), secrets, 'MCP secrets');
  }

  private readEncryptedJson<T>(p: string): T | null {
    try {
      if (!existsSync(p) || !safeStorage.isEncryptionAvailable()) return null;
      return JSON.parse(safeStorage.decryptString(readFileSync(p))) as T;
    } catch {
      return null; // unreadable/corrupt blob = signed out / empty
    }
  }

  private writeEncryptedJson(p: string, value: unknown, what: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(`[identity] OS encryption unavailable — ${what} not persisted (kept for this session only)`);
      return;
    }
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, safeStorage.encryptString(JSON.stringify(value)));
  }
}

/**
 * Form POST that never throws on HTTP status: GitHub answers device-flow
 * polling with 200 + an `error` field, Microsoft with 400 + an `error` field —
 * callers branch on the parsed body either way.
 */
async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${new URL(url).host} answered ${res.status}: ${text.slice(0, 180)}`);
  }
}

async function fetchGithubLogin(token: string): Promise<string> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'delivery-console-desktop',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const user = (await res.json()) as { login?: unknown };
      if (typeof user.login === 'string' && user.login) return user.login;
    }
  } catch {
    // display-name lookup only — the sign-in itself already succeeded
  }
  return 'GitHub account';
}

/** Display-only claim read (no verification — we just show who signed in). */
function jwtClaims(idToken: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
