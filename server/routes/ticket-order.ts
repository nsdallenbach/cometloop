import { z } from 'zod';
import express from 'express';

/**
 * Board order: within-lane drag-and-drop reordering persists here. Tickets
 * render in descending `seq` order everywhere (the detail endpoint sorts by
 * it), so reordering is just renumbering `seq` in reverse to match the board's
 * new array — no new column or migration needed. The SERIAL default keeps new
 * tickets above the existing backlog.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const OrderBody = z.object({
  order: z.array(z.string().min(1).max(40)).min(1).max(500),
});

/**
 * Renumber `seq` to n..1 following `keys` (first key = top of the board).
 * Keys outside the engagement are ignored; duplicates keep their first
 * position. Returns how many tickets were renumbered.
 */
export async function applyTicketOrder(q: Query, engagementId: string, keys: string[]): Promise<number> {
  let updated = 0;
  const seen = new Set<string>();
  const uniqueKeyCount = new Set(keys).size;
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await q('UPDATE app.tickets SET seq = $3 WHERE key = $1 AND engagement_id = $2 RETURNING key', [
      key,
      engagementId,
      uniqueKeyCount - seen.size + 1,
    ]);
    updated += r.rows.length;
  }
  return updated;
}

export function setupTicketOrderRoutes(app: express.Application, q: Query) {
  // Full board order (all ticket keys, top to bottom). Board moves are open
  // to developers, same as status changes — no lead gate.
  app.put('/api/engagements/:id/tickets/order', async (req, res) => {
    const parsed = OrderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'order (array of ticket keys) is required' });
      return;
    }
    try {
      const engagementId = req.params.id;
      const exists = await q('SELECT 1 FROM app.engagements WHERE id = $1', [engagementId]);
      if (exists.rows.length === 0) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const updated = await applyTicketOrder(q, engagementId, parsed.data.order);
      console.log(`[api] reordered ${updated} ticket(s) for engagement ${engagementId}`);
      res.json({ ok: true, updated });
    } catch (err) {
      console.error('ticket reorder failed:', err);
      res.status(500).json({ error: 'Failed to reorder tickets' });
    }
  });
}
