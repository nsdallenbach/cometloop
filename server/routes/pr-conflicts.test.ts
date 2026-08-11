import { describe, expect, it } from 'vitest';
import { assessConflicts, overlappingFiles, type RelatedPr } from './pr-conflicts';

const pr = (over: Partial<RelatedPr>): RelatedPr => ({
  number: 1,
  title: 'A change',
  author: 'dev',
  state: 'open',
  branch: 'feature/x',
  url: 'https://github.com/o/r/pull/1',
  ticketKey: null,
  overlappingFiles: [],
  ...over,
});

describe('overlappingFiles', () => {
  it('returns the intersection, deduplicated', () => {
    expect(overlappingFiles(['a.ts', 'b.ts'], ['b.ts', 'c.ts', 'b.ts'])).toEqual(['b.ts']);
  });

  it('is empty when nothing is shared', () => {
    expect(overlappingFiles(['a.ts'], ['b.ts'])).toEqual([]);
  });
});

describe('assessConflicts', () => {
  it('recommends auto-resolve when no related PR overlaps', () => {
    const a = assessConflicts('DAT-1', [pr({ overlappingFiles: [] })]);
    expect(a.risky).toBe(false);
    expect(a.recommendation).toBe('auto-resolve');
    expect(a.impactedTickets).toEqual([]);
  });

  it('flags an overlapping open PR from another ticket and records the impact', () => {
    const a = assessConflicts('DAT-1', [pr({ number: 7, ticketKey: 'DAT-2', overlappingFiles: ['src/api.ts'] })]);
    expect(a.risky).toBe(true);
    expect(a.recommendation).toBe('developer-review');
    expect(a.impactedTickets).toEqual(['DAT-2']);
    expect(a.reasons[0]).toContain('#7');
    expect(a.reasons[0]).toContain('DAT-2');
  });

  it('flags an overlapping open PR even without a ticket link', () => {
    const a = assessConflicts('DAT-1', [pr({ overlappingFiles: ['src/api.ts'] })]);
    expect(a.risky).toBe(true);
    expect(a.impactedTickets).toEqual([]);
  });

  it("flags a recently merged PR from another ticket (it's the conflict source)", () => {
    const a = assessConflicts('DAT-1', [
      pr({ state: 'merged', ticketKey: 'DAT-9', overlappingFiles: ['db/schema.sql'] }),
    ]);
    expect(a.risky).toBe(true);
    expect(a.impactedTickets).toEqual(['DAT-9']);
  });

  it('treats a merged PR with no ticket link as safe context, not risk', () => {
    const a = assessConflicts('DAT-1', [pr({ state: 'merged', ticketKey: null, overlappingFiles: ['README.md'] })]);
    expect(a.risky).toBe(false);
    expect(a.recommendation).toBe('auto-resolve');
  });

  it('ignores overlap with PRs from the same ticket (stacked agent branches)', () => {
    const a = assessConflicts('DAT-1', [pr({ ticketKey: 'DAT-1', overlappingFiles: ['src/api.ts'] })]);
    expect(a.risky).toBe(false);
  });

  it('deduplicates impacted tickets across several PRs', () => {
    const a = assessConflicts('DAT-1', [
      pr({ number: 3, ticketKey: 'DAT-2', overlappingFiles: ['a.ts'] }),
      pr({ number: 4, ticketKey: 'DAT-2', state: 'merged', overlappingFiles: ['b.ts'] }),
      pr({ number: 5, ticketKey: 'DAT-3', overlappingFiles: ['c.ts'] }),
    ]);
    expect(a.impactedTickets.sort()).toEqual(['DAT-2', 'DAT-3']);
    expect(a.reasons).toHaveLength(3);
  });
});
