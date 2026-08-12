import { z } from 'zod';
import express from 'express';

/**
 * Linked tickets: first-class dependencies between tickets of an engagement.
 * A link row is directional — `ticket_key blocks linked_key` — so "blocked by"
 * is the same row read from the other side; `relates` is symmetric and stored
 * once. On top of the explicit links, the GET endpoint derives two more kinds
 * of relationship for free:
 *  - mentions: other ticket keys referenced in this ticket's description or
 *    comments (the planned "## Dependencies" section lands here without anyone
 *    wiring links by hand);
 *  - branches: git branches linked to the ticket via the synced PRs (branch
 *    names / PR titles already carry the ticket key, see repos.ts).
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const LINKS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.ticket_links (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    linked_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    type TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (ticket_key, linked_key, type)
  )`,
];

/** How the caller describes a link from :key's point of view. */
export type LinkInput = 'blocks' | 'blocked_by' | 'relates';

/** How a link renders from one ticket's point of view (mention = detected, not stored). */
export type LinkView = 'blocks' | 'blocked_by' | 'relates' | 'mention';

const TICKET_KEY_ALL = /\b[A-Z][A-Z0-9]{1,9}-\d{1,5}\b/g;

/**
 * Ticket keys referenced in free text, restricted to keys that actually exist
 * on the board (`known`), excluding the ticket itself. Order of first mention
 * is preserved; duplicates collapse.
 */
export function extractTicketMentions(text: string, known: ReadonlySet<string>, selfKey: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TICKET_KEY_ALL)) {
    const key = m[0];
    if (key !== selfKey && known.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Normalize a link request into the stored row: `blocked_by` is the reverse
 * `blocks` row, `relates`/`blocks` store as written.
 */
export function normalizeLink(key: string, otherKey: string, type: LinkInput): { from: string; to: string; type: 'blocks' | 'relates' } {
  if (type === 'blocked_by') return { from: otherKey, to: key, type: 'blocks' };
  return { from: key, to: otherKey, type };
}

const LINK_VERB: Record<LinkInput, string> = {
  blocks: 'blocks',
  blocked_by: 'is blocked by',
  relates: 'relates to',
};

const AddLinkBody = z.object({
  key: z.string().min(1).max(40),
  type: z.enum(['blocks', 'blocked_by', 'relates']),
});

function requestAuthor(req: express.Request): string {
  const h = req.headers['x-forwarded-preferred-username'] ?? req.headers['x-forwarded-email'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.trim() ? v.trim() : 'You';
}

export function setupTicketLinkRoutes(app: express.Application, q: Query) {
  // Linked tickets + linked git branches, from :key's point of view.
  app.get('/api/tickets/:key/links', async (req, res) => {
    try {
      const key = req.params.key;
      const ticket = (await q('SELECT engagement_id, description FROM app.tickets WHERE key = $1', [key])).rows[0];
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const engagementId = String(ticket.engagement_id);
      const board = (await q('SELECT key, title, status FROM app.tickets WHERE engagement_id = $1', [engagementId])).rows;
      const byKey = new Map(board.map((r) => [String(r.key), { title: String(r.title), status: String(r.status) }]));

      const stored = (
        await q('SELECT id, ticket_key, linked_key, type FROM app.ticket_links WHERE ticket_key = $1 OR linked_key = $1 ORDER BY id', [key])
      ).rows;
      const links: { id: number | null; key: string; title: string; status: string; type: LinkView }[] = [];
      const linkedKeys = new Set<string>();
      for (const row of stored) {
        const outgoing = String(row.ticket_key) === key;
        const otherKey = outgoing ? String(row.linked_key) : String(row.ticket_key);
        const other = byKey.get(otherKey);
        if (!other) continue; // cross-engagement leftovers never render
        const type: LinkView = String(row.type) === 'blocks' ? (outgoing ? 'blocks' : 'blocked_by') : 'relates';
        links.push({ id: Number(row.id), key: otherKey, title: other.title, status: other.status, type });
        linkedKeys.add(otherKey);
      }

      // Detected mentions: description + comment bodies, minus explicit links.
      const comments = (await q('SELECT body FROM app.ticket_comments WHERE ticket_key = $1 ORDER BY id', [key])).rows;
      const text = [
        typeof ticket.description === 'string' ? ticket.description : '',
        ...comments.map((c) => (typeof c.body === 'string' ? c.body : '')),
      ].join('\n');
      for (const mentioned of extractTicketMentions(text, new Set(byKey.keys()), key)) {
        if (linkedKeys.has(mentioned)) continue;
        const other = byKey.get(mentioned);
        if (other) links.push({ id: null, key: mentioned, title: other.title, status: other.status, type: 'mention' });
      }

      // Dependencies first, then the rest — the "waiting on" list is the point.
      const order: Record<LinkView, number> = { blocked_by: 0, blocks: 1, relates: 2, mention: 3 };
      links.sort((a, b) => order[a.type] - order[b.type]);

      // Linked git branches, newest PR per branch.
      const prRows = (
        await q(
          `SELECT branch, number, state, url FROM app.repo_prs
           WHERE ticket_key = $1 AND branch <> '' ORDER BY updated_at DESC NULLS LAST`,
          [key],
        )
      ).rows;
      const branches: { branch: string; prNumber: number; state: string; url: string }[] = [];
      for (const row of prRows) {
        const branch = String(row.branch);
        if (branches.some((b) => b.branch === branch)) continue;
        branches.push({ branch, prNumber: Number(row.number), state: String(row.state), url: String(row.url) });
      }

      res.json({ links, branches });
    } catch (err) {
      console.error('ticket links failed:', err);
      res.status(500).json({ error: 'Failed to load linked work' });
    }
  });

  app.post('/api/tickets/:key/links', async (req, res) => {
    const parsed = AddLinkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A ticket key and a link type (blocks, blocked_by, relates) are required' });
      return;
    }
    try {
      const key = req.params.key;
      const otherKey = parsed.data.key;
      if (otherKey === key) {
        res.status(400).json({ error: 'A ticket cannot link to itself' });
        return;
      }
      const rows = (await q('SELECT key, engagement_id FROM app.tickets WHERE key = ANY($1)', [[key, otherKey]])).rows;
      const self = rows.find((r) => String(r.key) === key);
      const other = rows.find((r) => String(r.key) === otherKey);
      if (!self || !other) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      if (String(self.engagement_id) !== String(other.engagement_id)) {
        res.status(400).json({ error: 'Tickets can only link within the same engagement' });
        return;
      }
      const { from, to, type } = normalizeLink(key, otherKey, parsed.data.type);
      // `relates` is symmetric — an existing reverse row is the same link.
      if (type === 'relates') {
        const dup = (
          await q(`SELECT 1 FROM app.ticket_links WHERE ticket_key = $1 AND linked_key = $2 AND type = 'relates'`, [to, from])
        ).rows;
        if (dup.length > 0) {
          res.status(409).json({ error: 'These tickets are already linked' });
          return;
        }
      }
      const inserted = await q(
        `INSERT INTO app.ticket_links (ticket_key, linked_key, type, created_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (ticket_key, linked_key, type) DO NOTHING RETURNING id`,
        [from, to, type, requestAuthor(req)],
      );
      if (inserted.rows.length === 0) {
        res.status(409).json({ error: 'These tickets are already linked' });
        return;
      }
      console.log(`[links] ${key} ${LINK_VERB[parsed.data.type]} ${otherKey} (stored ${from} blocks/relates ${to})`);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [String(self.engagement_id), `Linked tickets: ${key} ${LINK_VERB[parsed.data.type]} ${otherKey}.`],
      );
      res.status(201).json({ id: Number(inserted.rows[0].id) });
    } catch (err) {
      console.error('add ticket link failed:', err);
      res.status(500).json({ error: 'Failed to link tickets' });
    }
  });

  app.delete('/api/tickets/:key/links/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid link id' });
        return;
      }
      const deleted = await q('DELETE FROM app.ticket_links WHERE id = $1 AND (ticket_key = $2 OR linked_key = $2) RETURNING id', [
        id,
        req.params.key,
      ]);
      if (deleted.rows.length === 0) {
        res.status(404).json({ error: 'Link not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('remove ticket link failed:', err);
      res.status(500).json({ error: 'Failed to remove link' });
    }
  });
}
