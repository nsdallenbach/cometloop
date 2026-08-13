import type { Ticket } from '../types';

/**
 * DAT-207: hours are populated by the ticket agent, not typed by a human. A
 * ticket it could not size keeps the server's `needs-estimate-review` tag, so
 * an incomplete estimate is visible on the board instead of reading as a real
 * one. Mirrors `hoursMissing` in `server/routes/ticket-hours.ts`.
 */
export const NEEDS_ESTIMATE_TAG = 'needs-estimate-review';

export function needsEstimate(t: Pick<Ticket, 'tags' | 'estHours' | 'humanEstHours'>): boolean {
  if (t.tags.some((tag) => tag.toLowerCase() === NEEDS_ESTIMATE_TAG)) return true;
  return t.estHours == null || t.estHours <= 0 || t.humanEstHours == null || t.humanEstHours <= 0;
}
