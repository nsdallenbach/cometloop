/**
 * Standard tags the tag input offers on every ticket (DAT-210): the
 * lightweight feature/bug classification, carried by the ordinary tag
 * mechanism rather than a new field. Mirrors STANDARD_TAGS in
 * server/routes/ticket-tags.ts — tests/ticket-tags.test.ts keeps the two
 * lists from drifting apart.
 */
export const STANDARD_TAGS = ['feature', 'bug'] as const;

/**
 * The canonical spelling of a standard tag, or the tag trimmed and unchanged.
 * The server applies the same rule on write (normalizeTags); doing it here too
 * keeps the optimistic chip identical to what comes back from the API.
 */
export function canonicalTag(tag: string): string {
  const trimmed = tag.trim();
  return STANDARD_TAGS.find((t) => t === trimmed.toLowerCase()) ?? trimmed;
}

/** Standard tags not already on the ticket — what the picker offers to add. */
export function suggestedTags(current: string[]): string[] {
  const applied = new Set(current.map((t) => t.trim().toLowerCase()));
  return STANDARD_TAGS.filter((t) => !applied.has(t));
}

/** The subset of a ticket the list filter searches; the project fields are
 *  only present on cross-project rows (`TicketWithEngagement`). */
export interface SearchableTicket {
  key: string;
  title: string;
  assignee: string;
  client?: string;
  engagementName?: string;
  tags: string[];
}

/**
 * Free-text filter for a tickets list: key, title, assignee, project and
 * tags, case-insensitive substring. Tags are in the haystack so `feature` /
 * `bug` (and any other tag) filter the list with no extra control.
 */
export function ticketMatchesQuery(t: SearchableTicket, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [t.key, t.title, t.assignee, t.client ?? '', t.engagementName ?? '', ...t.tags].some((v) => v.toLowerCase().includes(needle));
}
