import type { Ticket } from '../types';

/**
 * The review queue (DAT-222): reviewers work through tickets sitting in Review
 * one after another, so a decision on one has to hand them the next without a
 * trip back to the board. Kept pure — the drawer owns the API calls and the
 * navigation, this owns the arithmetic of "which ticket is next".
 */

/** Tickets awaiting sign-off, in board order — exactly what the Review lane shows. */
export function reviewQueue(tickets: Ticket[]): Ticket[] {
  return tickets.filter((t) => t.status === 'review');
}

/** 1-based position of `key` in the queue, or 0 when it isn't in Review. */
export function queuePosition(tickets: Ticket[], key: string): number {
  return reviewQueue(tickets).findIndex((t) => t.key === key) + 1;
}

/**
 * The ticket to open after deciding on `key`: the next one still in Review,
 * wrapping to the top of the queue when the decided ticket was last. Returns
 * null when nothing is left to review (the drawer closes instead).
 *
 * Called with the board state from *before* the decision lands — the decided
 * ticket is excluded by key, so an optimistic update and a stale poll both
 * yield the same answer.
 */
export function nextInQueue(tickets: Ticket[], key: string): Ticket | null {
  const queue = reviewQueue(tickets);
  const at = queue.findIndex((t) => t.key === key);
  const rest = queue.filter((t) => t.key !== key);
  if (rest.length === 0) return null;
  // Decided ticket wasn't in the queue (already moved on elsewhere) → start at the top.
  if (at < 0) return rest[0];
  return rest[at % rest.length];
}
