import type express from 'express';
import type { Identity } from './roles';

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Project access is the parent permission for every runner attached to that
 * project. Admins inherit access globally, assigned leads inherit access to
 * their projects, and developers must be assigned through engagement_members.
 * Keeping this decision in one helper leaves a single place for future
 * per-runner exceptions without weakening the project boundary today.
 */
export async function canAccessProject(q: Query, identity: Identity, engagementId: string): Promise<boolean> {
  if (identity.role === 'admin') return true;
  const result = await q(
    `SELECT 1
     WHERE EXISTS (
       SELECT 1 FROM app.engagement_leads l
       WHERE l.engagement_id = $1 AND LOWER(l.email) = LOWER($2)
     ) OR EXISTS (
       SELECT 1 FROM app.engagement_members em
       JOIN app.team_members tm ON tm.id = em.member_id
       WHERE em.engagement_id = $1 AND LOWER(tm.email) = LOWER($2)
     )`,
    [engagementId, identity.email],
  );
  return result.rows.length > 0;
}

export async function accessibleProjectIds(q: Query, identity: Identity): Promise<string[] | null> {
  if (identity.role === 'admin') return null;
  const result = await q(
    `SELECT engagement_id FROM app.engagement_leads WHERE LOWER(email) = LOWER($1)
     UNION
     SELECT em.engagement_id FROM app.engagement_members em
     JOIN app.team_members tm ON tm.id = em.member_id
     WHERE LOWER(tm.email) = LOWER($1)`,
    [identity.email],
  );
  return result.rows.flatMap((row) => (typeof row.engagement_id === 'string' ? [row.engagement_id] : []));
}

export function projectAccessGuard(q: Query, resolve: (req: express.Request) => Promise<Identity>) {
  return async (req: express.Request, res: express.Response, engagementId: string | null): Promise<Identity | null> => {
    const identity = await resolve(req);
    if (engagementId && (await canAccessProject(q, identity, engagementId))) return identity;
    res.status(403).json({ error: 'You must be assigned to this project to use its runners' });
    return null;
  };
}
