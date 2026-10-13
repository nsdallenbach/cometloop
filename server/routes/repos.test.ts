import { describe, expect, it } from 'vitest';
import { extractPullRequestNumbers, findTicketKey, matchPullRequestTicket, rememberDelivery } from './repos';

describe('findTicketKey', () => {
  it('finds a ticket key in a branch name', () => {
    expect(findTicketKey('DAT-153-pr-status-sync')).toBe('DAT-153');
  });

  it('scans texts in order and returns the first hit', () => {
    expect(findTicketKey('feature/no-key', 'DAT-9: add thing')).toBe('DAT-9');
  });

  it('returns null when no key is present', () => {
    expect(findTicketKey('main', 'chore: bump deps')).toBeNull();
  });
});

describe('extractPullRequestNumbers', () => {
  const github = { provider: 'github' as const, repo_url: 'https://github.com/your-org/your-repo' };

  it('reproduces the DAT-105 completion-comment format', () => {
    const comment =
      'Completed: notification center shipped.\n\nhttps://github.com/your-org/your-repo/pull/106\nhttps://github.com/your-org/your-repo/pull/106';
    expect(extractPullRequestNumbers(comment, github)).toEqual([106]);
  });

  it('reproduces the DAT-200 completion-comment format with surrounding prose', () => {
    const comment = 'Completed DAT-200 via https://github.com/your-org/your-repo/pull/103.';
    expect(extractPullRequestNumbers(comment, github)).toEqual([103]);
  });

  it('spot-checks markdown, punctuation, and unrelated repository references', () => {
    const comment = [
      '[PR](https://github.com/your-org/your-repo/pull/91),',
      '`https://github.com/your-org/your-repo/pull/92`',
      'https://github.com/another/repository/pull/93',
    ].join(' ');
    expect(extractPullRequestNumbers(comment, github)).toEqual([91, 92]);
  });

  it('supports Azure DevOps pull-request URLs', () => {
    const ado = { provider: 'ado' as const, repo_url: 'https://dev.azure.com/acme/Console/_git/execution' };
    expect(extractPullRequestNumbers('See https://dev.azure.com/acme/Console/_git/execution/pullrequest/27', ado)).toEqual([27]);
  });
});

describe('matchPullRequestTicket', () => {
  const known = new Set(['DAT-105', 'DAT-200', 'DAT-225']);

  it.each([
    [106, 'feature/notification-center', 'Build notifications', 'DAT-105'],
    [103, 'feature/requeue-conflicts', 'Requeue merge conflicts', 'DAT-200'],
  ])('backfills PR #%i from the completion-comment reference', (number, branch, title, ticket) => {
    const references = new Map([[number, new Set([ticket])]]);
    expect(matchPullRequestTicket({ number, branch, title }, known, references)).toBe(ticket);
  });

  it('keeps the branch/title ticket key authoritative', () => {
    const references = new Map([[225, new Set(['DAT-200'])]]);
    expect(matchPullRequestTicket({ number: 225, branch: 'DAT-225-fix', title: 'Fix links' }, known, references)).toBe('DAT-225');
  });

  it('does not guess when multiple tickets reference the same PR', () => {
    const references = new Map([[106, new Set(['DAT-105', 'DAT-200'])]]);
    expect(matchPullRequestTicket({ number: 106, branch: 'feature/notifications', title: 'Notifications' }, known, references)).toBeNull();
  });
});

describe('rememberDelivery', () => {
  it('accepts a first delivery and rejects its redelivery', () => {
    const now = 1_000_000;
    expect(rememberDelivery('gh-delivery-1', now)).toBe(true);
    expect(rememberDelivery('gh-delivery-1', now + 5_000)).toBe(false);
  });

  it('tracks distinct delivery ids independently', () => {
    const now = 2_000_000;
    expect(rememberDelivery('gh-delivery-2', now)).toBe(true);
    expect(rememberDelivery('gh-delivery-3', now)).toBe(true);
  });

  it('forgets a delivery after the retention window', () => {
    const now = 3_000_000;
    expect(rememberDelivery('gh-delivery-4', now)).toBe(true);
    expect(rememberDelivery('gh-delivery-4', now + 16 * 60_000)).toBe(true);
  });
});
