import { z } from 'zod';
import type express from 'express';
import { recordTicketEvent } from './ticket-events';

/**
 * Review decisions (DAT-222): the one call behind the reviewer's Approve /
 * Reject buttons, so a queue of tickets can be worked through without leaving
 * the drawer.
 *
 * - **Approve** is deliberately frictionless: one click, no confirmation. The
 *   ticket moves out of Review into the Deploying lane, which is where merged
 *   work already waits while its pipeline runs — approving says "ship it", not
 *   "it shipped", so Done still only ever means deployed.
 * - **Reject** refuses to proceed without a note. The note is written to the
 *   ticket's comment thread (the history the drawer already renders) and to the
 *   engagement feed, and the ticket returns to Backlog so it is workable again.
 *
 * Both decisions record a status event, so burndown and velocity see them.
 *
 * Note for whoever merges DAT-217 (PR #105, `ticket-review.ts`): that branch
 * adds a durable `app.ticket_rejections` table plus rejection context in the
 * runner prompt, on its own `POST /api/tickets/:key/reject` route. The two are
 * intentionally on different paths so neither shadows the other, and the
 * follow-up once both are on main is for this module's reject branch to call
 * `rejectTicketReview()` instead of writing its own comment — one rejection
 * store, two entry points.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** The only status a ticket can be approved or rejected from. */
export const DECIDABLE_STATUS = 'review';

/** Approved work waits here while its merge deploys. */
export const APPROVED_STATUS = 'deploying';

/** Rejected work goes back to a claimable lane — never to Done. */
export const REJECTED_STATUS = 'backlog';

export const MAX_NOTE_CHARS = 4000;

const DecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  /** Required (non-blank) for a rejection; ignored for an approval. */
  note: z.string().max(MAX_NOTE_CHARS).optional(),
});

function txt(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

function requestAuthor(req: express.Request): string {
  const h = req.headers['x-forwarded-preferred-username'] ?? req.headers['x-forwarded-email'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.trim() ? v.trim() : 'You';
}

export type DecisionResult =
  | { ok: true; status: string; engagementId: string; note: string }
  | { ok: false; status: number; error: string };

/**
 * Apply a reviewer's decision to a ticket in Review. Everything is validated
 * before anything is written: a blank rejection note, an unknown ticket or a
 * ticket that has already left Review all return without touching a row.
 */
export async function decideTicketReview(
  q: Query,
  key: string,
  input: { decision: 'approve' | 'reject'; note?: string; actor: string },
): Promise<DecisionResult> {
  const note = (input.note ?? '').trim();
  if (input.decision === 'reject' && !note) {
    return { ok: false, status: 400, error: 'A rejection note is required — say what needs to change' };
  }

  const ticket = (await q('SELECT engagement_id, title, status FROM app.tickets WHERE key = $1', [key])).rows[0];
  if (!ticket) return { ok: false, status: 404, error: 'Ticket not found' };
  const from = txt(ticket.status);
  if (from !== DECIDABLE_STATUS) {
    return { ok: false, status: 409, error: `Only tickets in review can be approved or rejected (this one is ${from})` };
  }
  const engagementId = txt(ticket.engagement_id);
  const title = txt(ticket.title);
  const to = input.decision === 'approve' ? APPROVED_STATUS : REJECTED_STATUS;

  // done_at is cleared on every move that isn't into Done, matching
  // setTicketStatus — neither decision can leave a stale completion stamp.
  await q('UPDATE app.tickets SET status = $2, done_at = NULL WHERE key = $1', [key, to]);
  await recordTicketEvent(q, key, engagementId, from, to);

  if (note) {
    // The comment thread is the ticket's visible history: a rejection note has
    // to survive there, not only in the feed, so the next person to open the
    // ticket reads why it came back.
    await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
      key,
      input.actor,
      `⨯ Review rejected: ${note}`,
    ]);
  }
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
    [
      engagementId,
      input.decision === 'approve'
        ? `Approved ${key} — ${title} moved to Deploying.`
        : `Rejected ${key} — ${title} sent back to Backlog.`,
    ],
  );
  console.log(
    `[review] ${key} ${input.decision === 'approve' ? 'approved → deploying' : 'rejected → backlog'} by ${input.actor}${
      note ? ` — ${note.slice(0, 140)}` : ''
    }`,
  );
  return { ok: true, status: to, engagementId, note };
}

export function setupTicketDecisionRoutes(app: express.Application, q: Query) {
  /**
   * Approve or reject the ticket under review. Open to anyone who can move a
   * card on the board — the same permission dragging Review → Done already
   * carries — because gating the fast path on lead-only would defeat it.
   */
  app.post('/api/tickets/:key/decision', async (req, res) => {
    const parsed = DecisionBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid decision' });
      return;
    }
    try {
      const result = await decideTicketReview(q, req.params.key, {
        decision: parsed.data.decision,
        note: parsed.data.note,
        actor: requestAuthor(req),
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ ok: true, status: result.status });
    } catch (err) {
      console.error('ticket decision failed:', err);
      res.status(500).json({ error: 'Failed to record the review decision' });
    }
  });
}
