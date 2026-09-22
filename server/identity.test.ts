import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { isSignInExempt, requestAuthor, requireSignIn, resetJwksCache, resolveIdentity } from './identity';

/**
 * Phase 1 identity seam: one resolver, three verifiers, fail closed.
 *
 * Header/env cases run the resolver directly on a fake request. The JWT
 * cases sign with a locally generated key and serve its public half from a
 * throwaway JWKS server so `jose`'s remote key set is exercised for real.
 */

const fakeReq = (headers: Record<string, string> = {}) =>
  ({ headers, method: 'GET', originalUrl: '/api/test', baseUrl: '/api', path: '/test' }) as unknown as express.Request;

const ENV = ['DEV_IDENTITY_EMAIL', 'DEV_IDENTITY_NAME', 'NEON_AUTH_JWKS_URL', 'NEON_AUTH_ISSUER', 'NEON_AUTH_AUDIENCE', 'NEON_AUTH_COOKIE'];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetJwksCache();
});

describe('databricks verifier', () => {
  it('maps the Apps proxy headers to a databricks identity', async () => {
    const id = await resolveIdentity(
      fakeReq({
        'x-forwarded-email': 'ada@datavail.com',
        'x-forwarded-preferred-username': 'ada@datavail.com',
        'x-forwarded-user': '1234567890',
        'x-forwarded-access-token': 'eyJ.token.here',
      }),
    );
    expect(id).toMatchObject({ subject: '1234567890', email: 'ada@datavail.com', name: 'ada@datavail.com', source: 'databricks' });
    expect(id?.accessToken).toBe('eyJ.token.here');
  });

  it('keeps the preferred-username-over-email precedence and falls back to the email as subject', async () => {
    const id = await resolveIdentity(fakeReq({ 'x-forwarded-email': 'ada@datavail.com' }));
    expect(id).toEqual({ subject: 'ada@datavail.com', email: 'ada@datavail.com', name: 'ada@datavail.com', source: 'databricks' });
  });

  it('returns null with no headers at all', async () => {
    delete process.env.DEV_IDENTITY_EMAIL;
    delete process.env.NEON_AUTH_JWKS_URL;
    expect(await resolveIdentity(fakeReq())).toBeNull();
    expect(requestAuthor(fakeReq())).toBe('You');
    expect(requestAuthor(fakeReq(), 'MCP client')).toBe('MCP client');
  });
});

describe('dev verifier', () => {
  it('is only active when DEV_IDENTITY_EMAIL is set explicitly', async () => {
    process.env.DEV_IDENTITY_EMAIL = 'me@localhost';
    expect(await resolveIdentity(fakeReq())).toEqual({ subject: 'me@localhost', email: 'me@localhost', name: 'me@localhost', source: 'dev' });
    expect(requestAuthor(fakeReq())).toBe('me@localhost');
  });

  it('never outranks the proxy headers', async () => {
    process.env.DEV_IDENTITY_EMAIL = 'me@localhost';
    expect((await resolveIdentity(fakeReq({ 'x-forwarded-email': 'ada@datavail.com' })))?.source).toBe('databricks');
  });
});

describe('better-auth verifier', () => {
  let privateKey: CryptoKey;
  let jwksServer: Server;
  let jwksUrl: string;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const app = express();
    app.get('/.well-known/jwks.json', (_req, res) => res.json({ keys: [jwk] }));
    await new Promise<void>((resolve) => {
      jwksServer = app.listen(0, '127.0.0.1', () => resolve());
    });
    jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/.well-known/jwks.json`;
  });
  afterAll(() => jwksServer.close());

  const sign = (claims: Record<string, unknown>, opts: { exp?: string; key?: CryptoKey } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setIssuer('https://auth.example.test')
      .setExpirationTime(opts.exp ?? '5m')
      .sign(opts.key ?? privateKey);

  it('is inert until NEON_AUTH_JWKS_URL is set', async () => {
    delete process.env.NEON_AUTH_JWKS_URL;
    const jwt = await sign({ sub: 'u1', email: 'ada@example.test' });
    expect(await resolveIdentity(fakeReq({ authorization: `Bearer ${jwt}` }))).toBeNull();
  });

  it('accepts a bearer JWT signed by a key in the JWKS', async () => {
    process.env.NEON_AUTH_JWKS_URL = jwksUrl;
    const jwt = await sign({ sub: 'user_123', email: 'ada@example.test', name: 'Ada' });
    const id = await resolveIdentity(fakeReq({ authorization: `Bearer ${jwt}` }));
    expect(id).toEqual({ subject: 'user_123', email: 'ada@example.test', name: 'Ada', source: 'better-auth' });
  });

  it('accepts the same JWT from the Better Auth session cookie', async () => {
    process.env.NEON_AUTH_JWKS_URL = jwksUrl;
    const jwt = await sign({ sub: 'user_123', email: 'ada@example.test' });
    const id = await resolveIdentity(fakeReq({ cookie: `theme=dark; better-auth.session_token=${jwt}; other=1` }));
    expect(id).toMatchObject({ subject: 'user_123', email: 'ada@example.test', name: 'ada@example.test', source: 'better-auth' });
  });

  it('rejects an expired JWT', async () => {
    process.env.NEON_AUTH_JWKS_URL = jwksUrl;
    const jwt = await sign({ sub: 'user_123', email: 'ada@example.test' }, { exp: '-1m' });
    expect(await resolveIdentity(fakeReq({ authorization: `Bearer ${jwt}` }))).toBeNull();
  });

  it('rejects a JWT signed by a key the JWKS does not know', async () => {
    process.env.NEON_AUTH_JWKS_URL = jwksUrl;
    const rogue = await generateKeyPair('RS256');
    const jwt = await sign({ sub: 'user_123', email: 'ada@example.test' }, { key: rogue.privateKey });
    expect(await resolveIdentity(fakeReq({ authorization: `Bearer ${jwt}` }))).toBeNull();
  });

  it('rejects garbage, a JWT without sub/email, and the wrong issuer', async () => {
    process.env.NEON_AUTH_JWKS_URL = jwksUrl;
    expect(await resolveIdentity(fakeReq({ authorization: 'Bearer not-a-jwt' }))).toBeNull();
    const noEmail = await sign({ sub: 'user_123' });
    expect(await resolveIdentity(fakeReq({ authorization: `Bearer ${noEmail}` }))).toBeNull();
    process.env.NEON_AUTH_ISSUER = 'https://someone-else.example.test';
    const jwt = await sign({ sub: 'user_123', email: 'ada@example.test' });
    expect(await resolveIdentity(fakeReq({ authorization: `Bearer ${jwt}` }))).toBeNull();
  });
});

describe('requireSignIn middleware', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use('/api', requireSignIn());
    app.get('/api/me', (req, res) => res.json({ author: requestAuthor(req) }));
    app.get('/api/agent/work', (req, res) => res.json({ author: requestAuthor(req, 'anonymous runner') }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('answers 401 on a protected route with no identity', async () => {
    delete process.env.DEV_IDENTITY_EMAIL;
    const res = await fetch(`${base}/api/me`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in required' });
  });

  it('passes a protected route once the proxy headers are present', async () => {
    const res = await fetch(`${base}/api/me`, { headers: { 'x-forwarded-email': 'ada@datavail.com' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ author: 'ada@datavail.com' });
  });

  it('lets the runner routes through without an identity, and still attributes one when present', async () => {
    delete process.env.DEV_IDENTITY_EMAIL;
    const anon = await fetch(`${base}/api/agent/work`);
    expect(anon.status).toBe(200);
    expect(await anon.json()).toEqual({ author: 'anonymous runner' });
    const named = await fetch(`${base}/api/agent/work`, { headers: { 'x-forwarded-email': 'runner@datavail.com' } });
    expect(await named.json()).toEqual({ author: 'runner@datavail.com' });
  });

  it('keeps the exemption list explicit', () => {
    expect(isSignInExempt('/api/agent/work/claim')).toBe(true);
    expect(isSignInExempt('/api/agent/self')).toBe(true);
    expect(isSignInExempt('/health')).toBe(true);
    expect(isSignInExempt('/api/agents/overview')).toBe(false);
    expect(isSignInExempt('/api/me')).toBe(false);
    expect(isSignInExempt('/api/tickets/DAT-1')).toBe(false);
  });
});
