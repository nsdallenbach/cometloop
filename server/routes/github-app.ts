import crypto from 'crypto';
import type express from 'express';

/**
 * GitHub App authentication: the console holds an App id + private key and
 * mints short-lived installation tokens on demand — no long-lived tokens at
 * rest. Repo connections made through the App store an installation id; sync
 * and devbox credential vending exchange it for a fresh token (~1h TTL).
 *
 * Configure via env (see docs/github-app-setup.md):
 *   GITHUB_APP_ID              — numeric App id
 *   GITHUB_APP_PRIVATE_KEY     — PEM (literal newlines or \n-escaped)
 *   GITHUB_APP_WEBHOOK_SECRET  — optional, enables the webhook receiver
 */

/**
 * Accept the key however it survived transit: proper PEM, \n-escaped, base64
 * of a PEM, or whitespace-mangled (e.g. PowerShell `$(cat)` joins lines with
 * spaces). Rebuilds the 64-char PEM body so OpenSSL always gets valid input.
 */
function normalizePem(raw: string): string {
  let k = raw.trim().replace(/\\n/g, '\n');
  if (k && !k.includes('-----BEGIN')) {
    try {
      const decoded = Buffer.from(k, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) k = decoded;
    } catch {
      /* not base64 — leave as-is; signing will fail loudly */
    }
  }
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(k);
  if (m) {
    const body = m[2].replace(/\s+/g, '');
    k = `-----BEGIN ${m[1]}-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${m[1]}-----\n`;
  }
  return k;
}

const APP_ID = process.env.GITHUB_APP_ID ?? '';
const PRIVATE_KEY = normalizePem(process.env.GITHUB_APP_PRIVATE_KEY ?? '');
export const WEBHOOK_SECRET = process.env.GITHUB_APP_WEBHOOK_SECRET ?? '';

export const githubAppConfigured = (): boolean => Boolean(APP_ID && PRIVATE_KEY);

function ghHeaders(auth: string) {
  return {
    Authorization: `Bearer ${auth}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'delivery-console',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghJson(url: string, auth: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
  const resp = await fetch(url, { method, headers: ghHeaders(auth), signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`GitHub returned ${resp.status} for ${new URL(url).pathname}`);
  return resp.json();
}

/** Short-lived JWT that authenticates as the App itself (RS256, ≤10 min). */
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signing = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: APP_ID })}`;
  const sig = crypto.createSign('RSA-SHA256').update(signing).sign(PRIVATE_KEY);
  return `${signing}.${sig.toString('base64url')}`;
}

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** Installation access token, cached until ~5 min before expiry. */
export async function installationToken(installationId: number): Promise<{ token: string; expiresAt: string }> {
  const hit = tokenCache.get(installationId);
  if (hit && hit.expiresAt - Date.now() > 5 * 60_000) {
    return { token: hit.token, expiresAt: new Date(hit.expiresAt).toISOString() };
  }
  const data = (await ghJson(`https://api.github.com/app/installations/${installationId}/access_tokens`, appJwt(), 'POST')) as {
    token: string;
    expires_at: string;
  };
  tokenCache.set(installationId, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
  return { token: data.token, expiresAt: data.expires_at };
}

export interface InstallationInfo {
  id: number;
  account: string;
}

export async function listInstallations(): Promise<InstallationInfo[]> {
  const list = (await ghJson('https://api.github.com/app/installations?per_page=100', appJwt())) as {
    id: number;
    account?: { login?: string };
  }[];
  return list.map((i) => ({ id: i.id, account: i.account?.login ?? '' }));
}

export interface InstalledRepo {
  installationId: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export async function listInstalledRepos(): Promise<InstalledRepo[]> {
  const out: InstalledRepo[] = [];
  for (const inst of await listInstallations()) {
    const { token } = await installationToken(inst.id);
    const data = (await ghJson('https://api.github.com/installation/repositories?per_page=100', token)) as {
      repositories?: { full_name: string; default_branch: string; private: boolean }[];
    };
    for (const r of data.repositories ?? []) {
      out.push({ installationId: inst.id, fullName: r.full_name, defaultBranch: r.default_branch || 'main', private: r.private });
    }
  }
  return out.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * Constant-time check of X-Hub-Signature-256. `payload` must be the raw body
 * bytes; a re-serialized fallback is best-effort only (see repos.ts webhook).
 */
export function verifyWebhookSignature(payload: Buffer | string, signatureHeader: string | undefined): boolean {
  if (!WEBHOOK_SECRET || !signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex')}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function setupGithubAppRoutes(app: express.Application) {
  /** Whether the App is configured and where it's installed. */
  app.get('/api/github-app/status', async (_req, res) => {
    if (!githubAppConfigured()) {
      res.json({ configured: false, installations: [] });
      return;
    }
    try {
      res.json({ configured: true, installations: await listInstallations() });
    } catch (err) {
      console.warn('[github-app] status failed:', (err as Error).message);
      res.status(502).json({ error: `GitHub App auth failed — ${(err as Error).message}` });
    }
  });

  /** Repos the App can reach, for the connect picker. */
  app.get('/api/github-app/repos', async (_req, res) => {
    if (!githubAppConfigured()) {
      res.status(409).json({ error: 'GitHub App is not configured' });
      return;
    }
    try {
      res.json({ repos: await listInstalledRepos() });
    } catch (err) {
      console.warn('[github-app] repo list failed:', (err as Error).message);
      res.status(502).json({ error: `Could not list installed repositories — ${(err as Error).message}` });
    }
  });
}
