import { z } from 'zod';
import express from 'express';
import { canonicalTag } from './ticket-tags';
import { extractTicketMentions } from './ticket-links';

/**
 * The canvas board (DAT-281): tags are zones on a pan/zoom surface, cards
 * auto-organise inside their zone, links draw between cards and agent
 * coordination traffic draws between the cards the agents are working.
 *
 * Only the zones are new state — a zone is a tag with a position and a
 * column count, per engagement. Links come from `ticket_links` plus detected
 * mentions, and traffic is the recent coordination log mapped onto ticket
 * pairs through the agents' active claims. One GET serves all three so the
 * board polls a single endpoint.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const CANVAS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.canvas_zones (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    x INT NOT NULL DEFAULT 40,
    y INT NOT NULL DEFAULT 40,
    cols INT NOT NULL DEFAULT 2,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (engagement_id, tag)
  )`,
];

/** How far back the board looks for agent-to-agent traffic. */
export const TRAFFIC_WINDOW_MINUTES = 30;

const ZoneBody = z.object({
  tag: z.string().trim().min(1).max(40),
  x: z.number().int().min(0).max(100_000).optional(),
  y: z.number().int().min(0).max(100_000).optional(),
  cols: z.number().int().min(1).max(4).optional(),
});

const ZonePatch = z
  .object({
    x: z.number().int().min(0).max(100_000).optional(),
    y: z.number().int().min(0).max(100_000).optional(),
    cols: z.number().int().min(1).max(4).optional(),
  })
  .refine((p) => p.x !== undefined || p.y !== undefined || p.cols !== undefined, { message: 'Nothing to update' });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

export interface CanvasZoneRow {
  id: number;
  tag: string;
  x: number;
  y: number;
  cols: number;
}

export function zoneFromRow(r: Record<string, unknown>): CanvasZoneRow {
  return { id: num(r.id), tag: str(r.tag), x: num(r.x), y: num(r.y), cols: num(r.cols) || 2 };
}

export interface TrafficMessage {
  id: number;
  sender: string;
  recipient: string | null;
  ticket: string | null;
  type: string;
  body: string;
  createdAt: string;
}

/**
 * Attach a coordination message to the two cards it connects: the sender's
 * active ticket on one end, the message's ticket (else the recipient's active
 * ticket) on the other. A message with neither end on this board is dropped;
 * a message with one end still renders as a pulse on that card.
 */
export function mapTrafficToTickets(
  messages: TrafficMessage[],
  activeTicketByAgent: ReadonlyMap<string, string>,
  boardKeys: ReadonlySet<string>,
): (TrafficMessage & { from: string | null; to: string | null })[] {
  const out: (TrafficMessage & { from: string | null; to: string | null })[] = [];
  for (const m of messages) {
    const from = activeTicketByAgent.get(m.sender) ?? null;
    const to = (m.ticket && boardKeys.has(m.ticket) ? m.ticket : null) ?? (m.recipient ? (activeTicketByAgent.get(m.recipient) ?? null) : null);
    const fromOk = from !== null && boardKeys.has(from);
    const toOk = to !== null && boardKeys.has(to);
    if (!fromOk && !toOk) continue;
    out.push({ ...m, from: fromOk ? from : null, to: toOk ? to : null });
  }
  return out;
}

function requestAuthor(req: express.Request): string {
  const h = req.headers['x-forwarded-preferred-username'] ?? req.headers['x-forwarded-email'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.trim() ? v.trim() : 'You';
}

export function setupCanvasRoutes(app: express.Application, q: Query) {
  // Everything the canvas draws for one engagement, in one poll.
  app.get('/api/engagements/:id/canvas', async (req, res) => {
    try {
      const id = req.params.id;
      const tickets = (await q('SELECT key, description FROM app.tickets WHERE engagement_id = $1', [id])).rows;
      const boardKeys = new Set(tickets.map((t) => str(t.key)));

      const zones = (await q('SELECT id, tag, x, y, cols FROM app.canvas_zones WHERE engagement_id = $1 ORDER BY id', [id])).rows.map(zoneFromRow);

      const stored = (
        await q(
          `SELECT l.id, l.ticket_key, l.linked_key, l.type FROM app.ticket_links l
           JOIN app.tickets a ON a.key = l.ticket_key
           WHERE a.engagement_id = $1 ORDER BY l.id`,
          [id],
        )
      ).rows;
      const links: { id: number | null; from: string; to: string; type: 'blocks' | 'relates' | 'mention' }[] = [];
      const seen = new Set<string>();
      for (const r of stored) {
        const from = str(r.ticket_key);
        const to = str(r.linked_key);
        if (!boardKeys.has(from) || !boardKeys.has(to)) continue;
        const type = str(r.type) === 'blocks' ? 'blocks' : 'relates';
        links.push({ id: num(r.id), from, to, type });
        seen.add(`${from}>${to}`);
        seen.add(`${to}>${from}`);
      }
      // Detected mentions ride along as the dashed line; a stored link between
      // the same two tickets already says more, so it wins.
      for (const t of tickets) {
        const key = str(t.key);
        for (const other of extractTicketMentions(str(t.description), boardKeys, key)) {
          if (seen.has(`${key}>${other}`)) continue;
          seen.add(`${key}>${other}`);
          seen.add(`${other}>${key}`);
          links.push({ id: null, from: key, to: other, type: 'mention' });
        }
      }

      const active = (
        await q(`SELECT agent, ticket_key FROM app.agent_tasks WHERE engagement_id = $1 AND state IN ('claimed','working') AND agent IS NOT NULL`, [id])
      ).rows;
      const activeTicketByAgent = new Map(active.map((r) => [str(r.agent), str(r.ticket_key)]));
      const recent = (
        await q(
          `SELECT id, sender_agent_id, recipient_agent_id, ticket_key, message_type, payload, created_at
           FROM app.coordination_messages
           WHERE created_at > NOW() - ($1::int * INTERVAL '1 minute')
           ORDER BY id DESC LIMIT 200`,
          [TRAFFIC_WINDOW_MINUTES],
        )
      ).rows.map((r): TrafficMessage => {
        const payload = r.payload && typeof r.payload === 'object' ? (r.payload as Record<string, unknown>) : {};
        return {
          id: num(r.id),
          sender: str(r.sender_agent_id),
          recipient: r.recipient_agent_id == null ? null : str(r.recipient_agent_id),
          ticket: r.ticket_key == null ? null : str(r.ticket_key),
          type: str(r.message_type),
          body: str(payload.body),
          createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : str(r.created_at),
        };
      });
      const traffic = mapTrafficToTickets(recent, activeTicketByAgent, boardKeys);

      res.json({ zones, links, traffic });
    } catch (err) {
      console.error('canvas load failed:', err);
      res.status(500).json({ error: 'Failed to load the canvas' });
    }
  });

  app.post('/api/engagements/:id/canvas/zones', async (req, res) => {
    try {
      const parsed = ZoneBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const id = req.params.id;
      const tag = canonicalTag(parsed.data.tag);
      const inserted = (
        await q(
          `INSERT INTO app.canvas_zones (engagement_id, tag, x, y, cols, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (engagement_id, tag) DO NOTHING
           RETURNING id, tag, x, y, cols`,
          [id, tag, parsed.data.x ?? 40, parsed.data.y ?? 40, parsed.data.cols ?? 2, requestAuthor(req)],
        )
      ).rows[0];
      if (!inserted) {
        res.status(409).json({ error: `There is already a zone for ${tag}` });
        return;
      }
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible) VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [id, `Added canvas zone ${tag}.`],
      );
      res.json(zoneFromRow(inserted));
    } catch (err) {
      console.error('canvas zone create failed:', err);
      res.status(500).json({ error: 'Failed to create the zone' });
    }
  });

  app.patch('/api/engagements/:id/canvas/zones/:zoneId', async (req, res) => {
    try {
      const parsed = ZonePatch.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const zoneId = Number(req.params.zoneId);
      if (!Number.isInteger(zoneId)) {
        res.status(400).json({ error: 'Bad zone id' });
        return;
      }
      const updated = (
        await q(
          `UPDATE app.canvas_zones SET x = COALESCE($3, x), y = COALESCE($4, y), cols = COALESCE($5, cols)
           WHERE id = $1 AND engagement_id = $2 RETURNING id, tag, x, y, cols`,
          [zoneId, req.params.id, parsed.data.x ?? null, parsed.data.y ?? null, parsed.data.cols ?? null],
        )
      ).rows[0];
      if (!updated) {
        res.status(404).json({ error: 'Zone not found' });
        return;
      }
      res.json(zoneFromRow(updated));
    } catch (err) {
      console.error('canvas zone update failed:', err);
      res.status(500).json({ error: 'Failed to update the zone' });
    }
  });

  app.delete('/api/engagements/:id/canvas/zones/:zoneId', async (req, res) => {
    try {
      const zoneId = Number(req.params.zoneId);
      if (!Number.isInteger(zoneId)) {
        res.status(400).json({ error: 'Bad zone id' });
        return;
      }
      const removed = (await q('DELETE FROM app.canvas_zones WHERE id = $1 AND engagement_id = $2 RETURNING tag', [zoneId, req.params.id])).rows[0];
      if (!removed) {
        res.status(404).json({ error: 'Zone not found' });
        return;
      }
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible) VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [req.params.id, `Removed canvas zone ${str(removed.tag)} (its tickets keep the tag).`],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('canvas zone delete failed:', err);
      res.status(500).json({ error: 'Failed to remove the zone' });
    }
  });
}
