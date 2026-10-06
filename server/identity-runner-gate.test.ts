import { afterEach, describe, expect, it } from 'vitest';
import { isSignInExempt, runnerRoutesRequireSignIn } from './identity';

/**
 * Runner routes are open only where something else authenticates the
 * runner (the Databricks Apps proxy) or nothing can (a dev server with no
 * provider). On a deployment with the console's own sign-in (Neon Auth
 * configured), an anonymous caller must not reach `/api/agent/*` — that is
 * how an unauthenticated desktop once claimed a ticket.
 */
describe('runner route exemption follows the sign-in provider', () => {
  const saved = process.env.NEON_AUTH_JWKS_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEON_AUTH_JWKS_URL;
    else process.env.NEON_AUTH_JWKS_URL = saved;
  });

  it('is exempt without a console sign-in provider', () => {
    delete process.env.NEON_AUTH_JWKS_URL;
    expect(runnerRoutesRequireSignIn()).toBe(false);
    expect(isSignInExempt('/api/agent/work/claim')).toBe(true);
    expect(isSignInExempt('/api/health')).toBe(true);
  });

  it('requires a sign-in once Neon Auth is configured, health stays open', () => {
    process.env.NEON_AUTH_JWKS_URL = 'https://auth.example.test/.well-known/jwks.json';
    expect(runnerRoutesRequireSignIn()).toBe(true);
    expect(isSignInExempt('/api/agent/work/claim')).toBe(false);
    expect(isSignInExempt('/api/agent/self')).toBe(false);
    expect(isSignInExempt('/api/health')).toBe(true);
    expect(isSignInExempt('/health')).toBe(true);
  });

  it('treats a blank value as not configured', () => {
    process.env.NEON_AUTH_JWKS_URL = '   ';
    expect(runnerRoutesRequireSignIn()).toBe(false);
    expect(isSignInExempt('/api/agent/work/claim')).toBe(true);
  });
});
