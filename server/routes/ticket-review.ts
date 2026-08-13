import { z } from 'zod';
import type express from 'express';
import type { Identity } from './roles';
import { recordTicketEvent } from './ticket-events';

/**
 * Reason-based review rejection (DAT-217): the counterpart to approving a
 * ticket out of Review. A reviewer who is not happy with what the runner
 * delivered sends the ticket back WITH a reason; the ticket returns to the
 * backlog (claimable again, never 'done') and the reason becomes context for
 * whichever runner picks it up next.
 *
 * The reasons live in their own table rather than in `rejection_reason` /
 * `rejected_at` / `rejected_by` columns on app.tickets for two reasons:
 *  - history accumulates by construction — a second rejection is a second row,
 *    so repeated failures stay visible instead of overwriting each other;
 *  - app.tickets is dev-role owned, so the SP's boot ALTERs on it are rejected
 *    (see docs/development-standards.md). A new table FK'd onto it follows the
 *    ticket_attachments / pr_review_escalations precedent: created at boot for
 *    fresh installs and in scripts/dev-migrate.cjs for the existing database.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const TICKET_REVIEW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.ticket_rejections (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    engagement_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    rejected_by TEXT NOT NULL DEFAULT '',
    rejected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS ticket_rejections_ticket_idx ON app.ticket_rejections (ticket_key, id)`,
];

/** One rejection cycle, oldest first wherever a list of these is passed around. */
export interface TicketRejection {
  id: number;
  reason: string;
  rejectedBy: string;
  rejectedAt: string;
}

/** The only status a ticket can be rejected from — Review is the sign-off gate. */
export const REJECTABLE_STATUS = 'review';

/** Where a rejected ticket lands: queued/ready for a runner to claim again. */
export const REJECTED_STATUS = 'backlog';

/**
 * Rejection history rendered into the runner prompt: the newest N, so a ticket
 * that has been round-tripped a dozen times still hands the agent the feedback
 * that matters instead of a wall of superseded complaints. The full history
 * stays in the drawer and the ticket comments.
 */
export const PROMPT_REJECTION_LIMIT = 5;
export const PROMPT_REJECTION_CHARS = 1500;

const RejectBody = z.object({
  reason: z.string().min(1).max(4000),
  /** Also queue a fresh agent run; defaults to "yes, if an agent worked this ticket". */
  requeue: z.boolean().optional(),
});

function txt(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

function isoTime(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const s = txt(v);
  if (!s) return '';
  const d = new Date(s);
  return isNaN(+d) ? s : d.toISOString();
}

function toRejection(row: Record<string, unknown>): TicketRejection {
  return {
    id: Number(row.id),
    reason: txt(row.reason),
    rejectedBy: txt(row.rejected_by),
    rejectedAt: isoTime(row.rejected_at),
  };
}

/** Every rejection this ticket has collected, oldest first. */
export async function loadRejections(q: Query, key: string): Promise<TicketRejection[]> {
  const { rows } = await q(
    'SELECT id, reason, rejected_by, rejected_at FROM app.ticket_rejections WHERE ticket_key = $1 ORDER BY id',
    [key],
  );
  return rows.map(toRejection);
}

/**
 * The "## Previous review rejections" block of the runner prompt — pure, so the
 * wording is testable without a database. Empty history renders nothing at all.
 */
export function rejectionPromptSection(rejections: TicketRejection[]): string[] {
  if (rejections.length === 0) return [];
  const recent = rejections.slice(-PROMPT_REJECTION_LIMIT);
  const heading =
    rejections.length > recent.length
      ? `## Previous review rejections (latest ${recent.length} of ${rejections.length})`
      : `## Previous review rejections (${rejections.length})`;
  return [
    '',
    heading,
    'A reviewer sent this ticket back instead of accepting it. Newest last — read these before you start; they are the reason this ticket is on the queue again.',
    ...recent.map((r) => {
      const who = r.rejectedBy || 'a reviewer';
      const when = r.rejectedAt ? ` (${r.rejectedAt})` : '';
      return `- Rejected by ${who}${when}: ${r.reason.trim().slice(0, PROMPT_REJECTION_CHARS)}`;
    }),
    'Treat every point above as a requirement: the same reviewer sees your resubmission, and an unaddressed reason is a second rejection.',
  ];
}

export type RejectResult =
  | { ok: true; engagementId: string; rejection: TicketRejection; count: number; requeued: boolean }
  | { ok: false; status: number; error: string };

/**
 * Reject a reviewed ticket. The reason is mandatory — a blank one is refused
 * before anything is written, so a rejection can never reach a runner without
 * telling it what to fix. On success the ticket goes back to the backlog
 * (never 'done'), the reason lands in the history, the ticket comments and the
 * feed, and — unless the caller opts out — a fresh agent task is queued so the
 * work is genuinely claimable again.
 */
export async function rejectTicketReview(
  q: Query,
  key: string,
  input: { reason: string; rejectedBy: string; requeue?: boolean },
): Promise<RejectResult> {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, status: 400, error: 'A rejection reason is required' };

  const ticket = (await q('SELECT engagement_id, title, status, assignee FROM app.tickets WHERE key = $1', [key])).rows[0];
  if (!ticket) return { ok: false, status: 404, error: 'Ticket not found' };
  const status = txt(ticket.status);
  if (status !== REJECTABLE_STATUS) {
    return { ok: false, status: 409, error: `Only tickets in review can be rejected (this one is ${status})` };
  }
  const engagementId = txt(ticket.engagement_id);

  const inserted = (
    await q(
      `INSERT INTO app.ticket_rejections (ticket_key, engagement_id, reason, rejected_by)
       VALUES ($1,$2,$3,$4) RETURNING id, reason, rejected_by, rejected_at`,
      [key, engagementId, reason, input.rejectedBy],
    )
  ).rows[0];
  const rejection = toRejection(inserted);
  const count = (await q('SELECT id FROM app.ticket_rejections WHERE ticket_key = $1', [key])).rows.length;

  // Back to the queued/ready lane — explicitly not 'done'. The runner that
  // delivered the rework stops owning the card, exactly as a failed run does,
  // but a human assignee is left alone. That conditional makes this one
  // UPDATE of its own rather than a setTicketStatus call, so the transition is
  // recorded explicitly — the path ticket-events.ts prescribes for sites that
  // run their own mutation and already know the before/after states.
  const lastAgent = txt(
    (await q('SELECT agent FROM app.agent_tasks WHERE ticket_key = $1 ORDER BY id DESC LIMIT 1', [key])).rows[0]?.agent,
  );
  await q(
    `UPDATE app.tickets
     SET status = $2, done_at = NULL,
         assignee = CASE WHEN $3 <> '' AND assignee = $3 THEN '—' ELSE assignee END
     WHERE key = $1`,
    [key, REJECTED_STATUS, lastAgent],
  );
  await recordTicketEvent(q, key, engagementId, status, REJECTED_STATUS);

  // Default: a ticket an agent worked goes straight back on the agent queue;
  // one no agent ever touched just returns to the backlog for a human.
  const wantsRequeue = input.requeue ?? lastAgent !== '';
  let requeued = false;
  if (wantsRequeue) {
    const active = (
      await q(`SELECT id FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working')`, [key])
    ).rows[0];
    if (!active) {
      await q(
        `INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority, instructions, queued_by)
         VALUES ($1,$2,0,'',$3)`,
        [key, engagementId, input.rejectedBy],
      );
      requeued = true;
    }
  }

  await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
    key,
    input.rejectedBy || 'Reviewer',
    `⨯ Review rejected (rejection ${count}): ${reason}`,
  ]);
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
    [
      engagementId,
      `Rejected ${key} in review — ${txt(ticket.title)} sent back to Backlog${requeued ? ' and re-queued for an agent' : ''}.`,
    ],
  );
  console.log(
    `[review] ${key} rejected by ${input.rejectedBy || 'unknown'} (rejection ${count}${requeued ? ', re-queued' : ''}) — ${reason.slice(0, 140)}`,
  );
  return { ok: true, engagementId, rejection, count, requeued };
}

export function setupTicketReviewRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>,
) {
  /** Rejection history for the drawer — oldest first, same order as the prompt. */
  app.get('/api/tickets/:key/rejections', async (req, res) => {
    try {
      res.json({ rejections: await loadRejections(q, req.params.key) });
    } catch (err) {
      console.error('load rejections failed:', err);
      res.status(500).json({ error: 'Failed to load the rejection history' });
    }
  });

  /** Reject a reviewed ticket with a reason; the reason gates the action. */
  app.post('/api/tickets/:key/reject', async (req, res) => {
    const parsed = RejectBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'A rejection reason is required' });
      return;
    }
    try {
      const key = req.params.key;
      const ticket = (await q('SELECT engagement_id FROM app.tickets WHERE key = $1', [key])).rows[0];
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const lead = await requireLead(req, res, txt(ticket.engagement_id));
      if (!lead) return;
      const result = await rejectTicketReview(q, key, {
        reason: parsed.data.reason,
        rejectedBy: lead.email,
        requeue: parsed.data.requeue,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        ok: true,
        status: REJECTED_STATUS,
        requeued: result.requeued,
        count: result.count,
        rejection: result.rejection,
      });
    } catch (err) {
      console.error('reject ticket failed:', err);
      res.status(500).json({ error: 'Failed to reject the ticket' });
    }
  });
}
