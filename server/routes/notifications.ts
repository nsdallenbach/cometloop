import type express from 'express';
import { resolveIdentity } from './roles';

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const NOTIFICATION_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.notifications (
    id BIGSERIAL PRIMARY KEY,
    recipient_email TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    ticket_key TEXT REFERENCES app.tickets(key) ON DELETE CASCADE,
    engagement_id TEXT REFERENCES app.engagements(id) ON DELETE CASCADE,
    read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS notifications_recipient_created
   ON app.notifications (LOWER(recipient_email), created_at DESC)`,
];

const listeners = new Map<string, Set<express.Response>>();
const normalize = (email: string) => email.trim().toLowerCase();

export async function createNotification(
  q: Query,
  input: { recipient: string; type: string; title: string; message: string; ticketKey?: string; engagementId?: string }
): Promise<Record<string, unknown> | null> {
  const recipient = normalize(input.recipient);
  if (!recipient || recipient === '—' || recipient === 'you' || recipient === 'unknown') return null;
  const { rows } = await q(
    `INSERT INTO app.notifications (recipient_email, type, title, message, ticket_key, engagement_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [recipient, input.type, input.title, input.message, input.ticketKey ?? null, input.engagementId ?? null]
  );
  const row = rows[0];
  if (!row) return null;
  const data = `data: ${JSON.stringify(row)}\n\n`;
  for (const response of listeners.get(recipient) ?? []) response.write(data);
  return row;
}

export function mentionedEmails(body: string): string[] {
  return [...new Set([...body.matchAll(/@([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi)].map((m) => normalize(m[1])))];
}

export function setupNotificationRoutes(app: express.Application, q: Query): void {
  app.get('/api/notifications', async (req, res) => {
    try {
      const identity = await resolveIdentity(req);
      const [{ rows }, count] = await Promise.all([
        q(
          `SELECT * FROM app.notifications WHERE LOWER(recipient_email) = LOWER($1)
         ORDER BY created_at DESC, id DESC LIMIT 100`,
          [identity.email]
        ),
        q(
          `SELECT COUNT(*)::int AS unread FROM app.notifications WHERE LOWER(recipient_email) = LOWER($1) AND read = false`,
          [identity.email]
        ),
      ]);
      res.json({ notifications: rows, unread: Number(count.rows[0]?.unread ?? 0) });
    } catch (err) {
      console.error('list notifications failed:', err);
      res.status(500).json({ error: 'Failed to load notifications' });
    }
  });

  app.patch('/api/notifications/:id/read', async (req, res) => {
    try {
      const identity = await resolveIdentity(req);
      const { rows } = await q(
        `UPDATE app.notifications SET read = true
         WHERE id = $1 AND LOWER(recipient_email) = LOWER($2) RETURNING id`,
        [req.params.id, identity.email]
      );
      if (rows.length === 0) return void res.status(404).json({ error: 'Notification not found' });
      res.json({ ok: true });
    } catch (err) {
      console.error('mark notification read failed:', err);
      res.status(500).json({ error: 'Failed to mark notification read' });
    }
  });

  app.post('/api/notifications/read-all', async (req, res) => {
    try {
      const identity = await resolveIdentity(req);
      await q(`UPDATE app.notifications SET read = true WHERE LOWER(recipient_email) = LOWER($1) AND read = false`, [
        identity.email,
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.error('mark all notifications read failed:', err);
      res.status(500).json({ error: 'Failed to mark notifications read' });
    }
  });

  app.get('/api/notifications/stream', async (req, res) => {
    const identity = await resolveIdentity(req);
    const email = normalize(identity.email);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    const group = listeners.get(email) ?? new Set<express.Response>();
    group.add(res);
    listeners.set(email, group);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      group.delete(res);
      if (group.size === 0) listeners.delete(email);
    });
  });
}
