import type { Ticket, TicketStatus } from '../types';

/**
 * Board drop arithmetic for drag-and-drop, kept pure so it can be tested
 * without the pointer-drag machinery: which lane a ticket renders in, and
 * what the board's ticket array looks like after a card is dropped into a
 * lane at a given slot.
 */

/** Which board lane a ticket renders in (In Progress folds into Backlog). */
export function laneOf(t: Ticket): Extract<TicketStatus, 'backlog' | 'review' | 'done'> {
  return t.status === 'done' ? 'done' : t.status === 'review' ? 'review' : 'backlog';
}

/**
 * The ticket array after dropping `key` at slot `idx` of `lane`. `laneList`
 * is the lane's visible cards excluding the dragged ticket, in render order;
 * the card lands before `laneList[idx]` (at the end of the lane when
 * `idx >= laneList.length`). Within-lane drops keep the ticket's status —
 * reordering a card inside Backlog must not demote an In Progress ticket.
 * Returns null when the drop changes nothing (same slot, same lane).
 */
export function dropBoardTicket(
  tickets: Ticket[],
  key: string,
  lane: Extract<TicketStatus, 'backlog' | 'review' | 'done'>,
  laneList: Ticket[],
  idx: number,
  nowIso: string,
): { tickets: Ticket[]; statusChanged: boolean; orderChanged: boolean } | null {
  const t = tickets.find((x) => x.key === key);
  if (!t) return null;
  const statusChanged = laneOf(t) !== lane;
  const at = Math.max(0, Math.min(idx, laneList.length));
  const before = laneList[at]; // undefined → end of the lane
  const after = at > 0 ? laneList[at - 1] : undefined;
  const rest = tickets.filter((x) => x.key !== key);
  let insertAt = rest.length;
  if (before) insertAt = rest.findIndex((x) => x.key === before.key);
  else if (after) insertAt = rest.findIndex((x) => x.key === after.key) + 1;
  // Mirror the server's done_at stamping so a card dropped in Done passes the
  // lane's 24h filter before the next refresh (see setTicket in App.tsx).
  const doneAt = !statusChanged ? t.doneAt : lane === 'done' ? (t.doneAt ?? nowIso) : null;
  rest.splice(insertAt, 0, { ...t, status: statusChanged ? lane : t.status, doneAt });
  const orderChanged = rest.some((x, i) => x.key !== tickets[i].key);
  if (!statusChanged && !orderChanged) return null;
  return { tickets: rest, statusChanged, orderChanged };
}
