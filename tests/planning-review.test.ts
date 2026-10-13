import { describe, expect, it } from 'vitest';
import {
  PLANNING_AGENT_AUTHOR,
  PLANNING_REVIEW_LABEL,
  isPlanningAgentAuthor,
  planningReviewThreadLabel,
  planningReviewTitle,
} from '../client/src/lib/planning-review';
import { PLANNING_REVIEW_FLOWS } from '../server/routes/planning-review';
import type { PlanningReviewFlow } from '../client/src/types';

/** DAT-218: the client vocabulary for the planning agent's review status. */

describe('planning review indicator', () => {
  it('uses one label everywhere, so the card and the drawer read as one signal', () => {
    expect(PLANNING_REVIEW_LABEL).toContain('REVIEWING');
  });

  it('names the running pass in the tooltip and says to hold off editing', () => {
    expect(planningReviewTitle({ flow: 'refine', startedAt: null })).toContain('re-planning this ticket');
    expect(planningReviewTitle({ flow: 'comment-rework', startedAt: null })).toContain('from a comment');
    expect(planningReviewTitle({ flow: 'plan', startedAt: null })).toContain('hold off editing');
  });

  it('captions the thread indicator per flow, falling back to the rework wording', () => {
    expect(planningReviewThreadLabel({ flow: 'plan', startedAt: null })).toContain('DRAFTING');
    expect(planningReviewThreadLabel({ flow: 'refine', startedAt: null })).toContain('RE-PLANNING');
    // null = the optimistic local state a just-posted comment sets up.
    expect(planningReviewThreadLabel(null)).toContain('REWORKING');
  });

  it('covers every flow the server can report', () => {
    for (const flow of PLANNING_REVIEW_FLOWS) {
      const review = { flow: flow as PlanningReviewFlow, startedAt: null };
      expect(planningReviewTitle(review)).not.toContain('undefined');
      expect(planningReviewThreadLabel(review)).not.toContain('undefined');
    }
  });
});

describe('planning-agent comment attribution', () => {
  it('recognises the author the server writes on planning replies', () => {
    expect(isPlanningAgentAuthor(PLANNING_AGENT_AUTHOR)).toBe(true);
    expect(isPlanningAgentAuthor('  planning agent ')).toBe(true);
  });

  it('leaves human comments alone', () => {
    expect(isPlanningAgentAuthor('dev@example.com')).toBe(false);
    expect(isPlanningAgentAuthor('Planning Agents Anonymous')).toBe(false);
  });
});
