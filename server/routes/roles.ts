import { createHash } from 'node:crypto';
import type express from 'express';
import { resolveIdentity, type Identity } from '../identity';

export type Role = 'admin' | 'lead' | 'developer';

/** A signed-in caller with the role the console grants them. */
export interface Caller {
  email: string;
  role: Role;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { role: Role; expires: number }>();

/**
 * Workspace group membership (eec-admins / eec-engagement-leads /
 * eec-developers) via the user token the Apps proxy forwards. A lookup
 * failure means developer (least privilege), never admin.
 */
async function databricksRole(token: string): Promise<Role> {
  // Forwarded tokens are JWTs whose headers are identical for every user, so the
  // cache must key on a digest of the whole token, never a prefix.
  const key = createHash('sha256').update(token).digest('hex');
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.role;
  try {
    const rawHost = process.env.DATABRICKS_HOST ?? '';
    const host = rawHost.startsWith('http') ? rawHost : `https://${rawHost}`;
    const resp = await fetch(`${host}/api/2.0/preview/scim/v2/Me?attributes=userName,groups`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`SCIM /Me returned ${resp.status}`);
    const me = (await resp.json()) as { groups?: { display?: string }[] };
    const groups = (me.groups ?? []).map((g) => (g.display ?? '').toLowerCase());
    const role: Role =
      groups.includes('eec-admins') || groups.includes('admins')
        ? 'admin'
        : groups.includes('eec-engagement-leads')
          ? 'lead'
          : 'developer';
    cache.set(key, { role, expires: Date.now() + CACHE_TTL_MS });
    return role;
  } catch (err) {
    console.warn('[roles] role lookup failed, defaulting to developer:', (err as Error).message);
    return 'developer';
  }
}

/**
 * The role an identity carries. Databricks identities are looked up in the
 * workspace groups; without a forwarded token there is nothing to look up, so
 * they are developers. A `dev` identity is the local developer's admin stand-in
 * (`DEV_IDENTITY_EMAIL`, see server/identity.ts). Better Auth identities have
 * no group mapping yet — developer until the role source for them lands.
 */
export async function roleOf(identity: Identity): Promise<Role> {
  switch (identity.source) {
    case 'databricks':
      return identity.accessToken ? databricksRole(identity.accessToken) : 'developer';
    case 'dev':
      return 'admin';
    case 'better-auth':
      return 'developer';
  }
}

/**
 * Resolve the caller and their role. Null when nobody is signed in — which a
 * route only ever sees on the sign-in-exempt paths (`/api/agent/*`), because
 * `requireSignIn` has already answered 401 everywhere else.
 */
export async function resolveCaller(req: express.Request): Promise<Caller | null> {
  const identity = await resolveIdentity(req);
  if (!identity) return null;
  return { email: identity.email, role: await roleOf(identity) };
}

/**
 * The caller on a route behind `requireSignIn`. A null here means the gate is
 * not mounted in front of the route — that is a wiring bug, so it throws
 * (→ the route's 500) rather than inventing a principal.
 */
export async function callerOf(req: express.Request): Promise<Caller> {
  const caller = await resolveCaller(req);
  if (!caller) throw new Error(`no identity on ${req.method} ${req.originalUrl} — requireSignIn must run before this route`);
  return caller;
}
