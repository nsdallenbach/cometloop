import type express from 'express';
import { callerOf } from './roles';

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

// ---------- email digest ----------

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Human labels for the digest's sections; unknown types fall into 'Updates'. */
const DIGEST_SECTIONS: [type: string, label: string][] = [
  ['stale_nudge', 'Stale tickets — needs a move'],
  ['assignment', 'Assigned to you'],
  ['agent_review', 'Ready for sign-off'],
  ['mention', 'Mentions'],
  ['comment', 'Comments'],
];

export interface EmailDigest {
  subject: string;
  /** Plain-text body — exactly what the mailer sends. */
  text: string;
  count: number;
}

/**
 * Render one recipient's notification rows (newest first) into the email
 * digest. Every notification type is included — a stale-ticket nudge lands in
 * the digest the same way it lands in the bell — grouped into sections with
 * nudges on top. Returns null when the window holds nothing: no email beats
 * an empty one.
 */
export function renderEmailDigest(rows: Record<string, unknown>[], windowLabel: string): EmailDigest | null {
  if (rows.length === 0) return null;
  const line = (row: Record<string, unknown>): string => {
    const ticket = txt(row.ticket_key);
    return `- ${ticket ? `[${ticket}] ` : ''}${txt(row.title)}\n  ${txt(row.message).replace(/\s+/g, ' ').slice(0, 200)}`;
  };
  const known = new Set(DIGEST_SECTIONS.map(([type]) => type));
  const sections: string[] = [];
  for (const [type, label] of DIGEST_SECTIONS) {
    const items = rows.filter((r) => txt(r.type) === type);
    if (items.length > 0) sections.push(`## ${label} (${items.length})\n\n${items.map(line).join('\n')}`);
  }
  const rest = rows.filter((r) => !known.has(txt(r.type)));
  if (rest.length > 0) sections.push(`## Updates (${rest.length})\n\n${rest.map(line).join('\n')}`);
  const nudges = rows.filter((r) => txt(r.type) === 'stale_nudge').length;
  return {
    subject: `Cometloop digest — ${rows.length} update${rows.length === 1 ? '' : 's'}${nudges > 0 ? `, ${nudges} stale ticket${nudges === 1 ? '' : 's'}` : ''}`,
    text: `Your Cometloop updates from the ${windowLabel}.\n\n${sections.join('\n\n')}\n`,
    count: rows.length,
  };
}

export function setupNotificationRoutes(app: express.Application, q: Query): void {
  app.get('/api/notifications', async (req, res) => {
    try {
      const identity = await callerOf(req);
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
      const identity = await callerOf(req);
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
      const identity = await callerOf(req);
      await q(`UPDATE app.notifications SET read = true WHERE LOWER(recipient_email) = LOWER($1) AND read = false`, [
        identity.email,
      ]);
      res.json({ ok: true });
    } catch (err) {
      console.error('mark all notifications read failed:', err);
      res.status(500).json({ error: 'Failed to mark notifications read' });
    }
  });

  /**
   * The recipient's rendered email digest for the trailing window (default
   * 24h, capped at a week). This JSON — subject + plain-text body — is the
   * digest a mailer sends; serving it here keeps the rendering versioned with
   * the app and lets the UI preview exactly what would go out.
   */
  app.get('/api/notifications/digest', async (req, res) => {
    try {
      const identity = await callerOf(req);
      const hoursRaw = Number(req.query.hours ?? 24);
      const hours = Number.isFinite(hoursRaw) ? Math.min(168, Math.max(1, Math.round(hoursRaw))) : 24;
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const { rows } = await q(
        `SELECT * FROM app.notifications
         WHERE LOWER(recipient_email) = LOWER($1) AND created_at >= $2
         ORDER BY created_at DESC, id DESC LIMIT 500`,
        [identity.email, since]
      );
      const digest = renderEmailDigest(rows, hours === 24 ? 'last 24 hours' : `last ${hours} hours`);
      res.json({ hours, digest });
    } catch (err) {
      console.error('notification digest failed:', err);
      res.status(500).json({ error: 'Failed to build the notification digest' });
    }
  });

  app.get('/api/notifications/stream', async (req, res) => {
    const identity = await callerOf(req);
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
