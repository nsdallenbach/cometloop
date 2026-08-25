// Native Databricks OAuth U2M (DAT-228): the app runs the browser sign-in
// itself — no Databricks CLI required. Standard authorization-code + PKCE
// against the workspace's OIDC endpoints, using the registered public client
// (`databricks-cli`, loopback redirect on :8020 — the same client the CLI and
// SDK external-browser flows use, so no app registration is needed).
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { shell } from 'electron';

const CLIENT_ID = 'databricks-cli';
const REDIRECT_PORT = 8020;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

const DONE_PAGE = `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#0a0d10;color:#e7ebef;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:34px;margin-bottom:12px">✓</div>Signed in — you can close this tab and return to the Delivery Console.</div></body></html>`;

/**
 * Open the system browser on the workspace sign-in page and wait for the
 * loopback redirect. Resolves with a full token set (access + refresh).
 */
export async function loginViaBrowser(host: string): Promise<TokenSet> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      const gotCode = url.searchParams.get('code');
      const oauthError = url.searchParams.get('error');
      if (!gotCode && !oauthError) {
        res.writeHead(404).end(); // favicon etc.
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DONE_PAGE);
      clearTimeout(timer);
      server.close();
      if (oauthError) reject(new Error(`Sign-in was refused: ${oauthError}`));
      else if (url.searchParams.get('state') !== state) reject(new Error('OAuth state mismatch — aborting sign-in'));
      else resolve(gotCode as string);
    });
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(
        e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? new Error(`Port ${REDIRECT_PORT} is in use (another sign-in running, or the Databricks CLI mid-login). Close it and retry.`)
          : e,
      );
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Sign-in timed out after 5 minutes'));
    }, LOGIN_TIMEOUT_MS);
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const auth = new URL('/oidc/v1/authorize', host);
      auth.searchParams.set('client_id', CLIENT_ID);
      auth.searchParams.set('redirect_uri', REDIRECT_URI);
      auth.searchParams.set('response_type', 'code');
      auth.searchParams.set('state', state);
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      auth.searchParams.set('scope', 'all-apis offline_access');
      void shell.openExternal(auth.toString());
    });
  });

  return exchange(host, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

/** Silent renewal with the stored refresh token. */
export async function refreshTokens(host: string, refreshToken: string): Promise<TokenSet> {
  return exchange(host, { grant_type: 'refresh_token', refresh_token: refreshToken });
}

async function exchange(host: string, params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(new URL('/oidc/v1/token', host), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Token exchange returned no access_token');
  return {
    accessToken: json.access_token,
    // Refresh-token rotation: a renewal may or may not issue a new one.
    refreshToken: json.refresh_token ?? params.refresh_token ?? '',
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
}
