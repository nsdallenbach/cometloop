import type { PlanningReview, PlanningReviewFlow } from '../types';

/**
 * DAT-218: the planning agent's review status, worded identically wherever it
 * appears — board card, ticket drawer header — so the two read as the same
 * signal rather than two similar-looking ones. The tooltip is the only part
 * that varies, because *which* pass is running is the useful detail once you
 * hover. Server side lives in `server/routes/planning-review.ts`.
 */
export const PLANNING_REVIEW_LABEL = '◆ AGENT REVIEWING';

/**
 * The author the server writes on planning-agent replies (see
 * `applyCommentFeedback` in server/routes/api.ts). Those comments get the
 * agent treatment in the thread — before DAT-218 they rendered exactly like a
 * teammate's, initials and all, so "the agent replied" read as "someone
 * replied".
 */
export const PLANNING_AGENT_AUTHOR = 'Planning Agent';

export function isPlanningAgentAuthor(author: string): boolean {
  return author.trim().toLowerCase() === PLANNING_AGENT_AUTHOR.toLowerCase();
}

const FLOW_DETAIL: Record<PlanningReviewFlow, string> = {
  plan: 'drafting the plan for this ticket',
  refine: 're-planning this ticket',
  'comment-rework': 'reworking the plan from a comment',
};

/** Hover text for the indicator: what the agent is doing, and what to do about it. */
export function planningReviewTitle(review: PlanningReview): string {
  const detail = FLOW_DETAIL[review.flow] ?? 'reviewing this ticket';
  return `Planning agent is ${detail} — the title, description and acceptance criteria may change, so hold off editing until it finishes.`;
}

const THREAD_LABEL: Record<PlanningReviewFlow, string> = {
  plan: 'PLANNING AGENT IS DRAFTING THE PLAN…',
  refine: 'PLANNING AGENT IS RE-PLANNING THIS TICKET…',
  'comment-rework': 'PLANNING AGENT IS REWORKING THE PLAN…',
};

/**
 * Caption on the drawer's typing indicator. A null review means the thread is
 * running on the optimistic local state a just-posted comment sets up, which
 * is only ever the rework flow.
 */
export function planningReviewThreadLabel(review: PlanningReview | null): string {
  return (review && THREAD_LABEL[review.flow]) || THREAD_LABEL['comment-rework'];
}
