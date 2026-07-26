import { createHash } from 'node:crypto';
import type express from 'express';

export type Role = 'admin' | 'lead' | 'developer';

export interface Identity {
  email: string;
  role: Role;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { identity: Identity; expires: number }>();

function headerValue(req: express.Request, name: string): string {
  const h = req.headers[name];
  const v = Array.isArray(h) ? h[0] : h;
  return v?.trim() ?? '';
}

/**
 * Resolve the caller's role from workspace group membership
 * (eec-admins / eec-engagement-leads / eec-developers) using the user token the
 * Apps proxy forwards. Without a proxy (local dev) the caller is treated as
 * admin; if the lookup fails the caller is treated as developer (least privilege).
 */
export async function resolveIdentity(req: express.Request): Promise<Identity> {
  const email = headerValue(req, 'x-forwarded-preferred-username') || headerValue(req, 'x-forwarded-email');
  const token = headerValue(req, 'x-forwarded-access-token');
  if (!token) {
    return { email: email || 'local-dev', role: 'admin' };
  }
  // Forwarded tokens are JWTs whose headers are identical for every user, so the
  // cache must key on a digest of the whole token, never a prefix.
  const key = createHash('sha256').update(token).digest('hex');
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.identity;
  try {
    const rawHost = process.env.DATABRICKS_HOST ?? '';
    const host = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`;
    const resp = await fetch(`${host}/api/2.0/preview/scim/v2/Me?attributes=userName,groups`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`SCIM /Me returned ${resp.status}`);
    const me = (await resp.json()) as { userName?: string; groups?: { display?: string }[] };
    const groups = (me.groups ?? []).map((g) => (g.display ?? '').toLowerCase());
    const role: Role =
      groups.includes('eec-admins') || groups.includes('admins')
        ? 'admin'
        : groups.includes('eec-engagement-leads')
          ? 'lead'
          : 'developer';
    const identity: Identity = { email: me.userName ?? email ?? 'unknown', role };
    cache.set(key, { identity, expires: Date.now() + CACHE_TTL_MS });
    return identity;
  } catch (err) {
    console.warn('[roles] identity resolution failed, defaulting to developer:', (err as Error).message);
    return { email: email || 'unknown', role: 'developer' };
  }
}
