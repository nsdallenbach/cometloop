import { describe, expect, it } from 'vitest';
import { DEPLOY_EXEMPT_TAG, doneBlockedReason, gateInputFromRow, loadDeployGates, toTags } from './deploy-gate';

/** A ticket in Review with an open PR and no deploy yet — the blocked baseline. */
const ticket = (over: Partial<Parameters<typeof doneBlockedReason>[0]> = {}) => ({
  key: 'DAT-213',
  status: 'review',
  tags: [] as string[],
  repoConnected: true,
  prNumber: 42,
  prState: 'open',
  deployState: null as string | null,
  ...over,
});

describe('doneBlockedReason — blocks Done until deployed', () => {
  it('allows a merged PR whose deploy pipeline succeeded', () => {
    expect(doneBlockedReason(ticket({ prState: 'merged', deployState: 'success' }))).toBeNull();
  });

  it('allows a merge with no pipeline configured, matching settleDeploy', () => {
    expect(doneBlockedReason(ticket({ prState: 'merged', deployState: 'none' }))).toBeNull();
  });

  it('blocks a ticket with no linked PR at all', () => {
    const reason = doneBlockedReason(ticket({ prNumber: null, prState: null }));
    expect(reason).toContain('no deployment is linked');
    expect(reason).toContain('DAT-213');
  });

  it('blocks while the PR is still open', () => {
    expect(doneBlockedReason(ticket())).toContain('PR #42 is still open');
  });

  it('blocks a PR closed without merging', () => {
    expect(doneBlockedReason(ticket({ prState: 'closed' }))).toContain('closed without merging');
  });

  it('blocks while the deploy pipeline is queued or running', () => {
    expect(doneBlockedReason(ticket({ prState: 'merged', deployState: 'pending' }))).toContain('still running');
    expect(doneBlockedReason(ticket({ prState: 'merged', deployState: 'running' }))).toContain('still running');
  });

  it('blocks on a failed deploy pipeline', () => {
    expect(doneBlockedReason(ticket({ prState: 'merged', deployState: 'failed' }))).toContain('failed');
  });

  it('blocks a merged PR whose deploy has not been recorded yet', () => {
    expect(doneBlockedReason(ticket({ prState: 'merged' }))).toContain('no deploy has been recorded yet');
  });

  it('names the exemption tag in every blocking reason', () => {
    for (const state of [null, 'pending', 'running', 'failed'] as const) {
      expect(doneBlockedReason(ticket({ deployState: state }))).toContain(DEPLOY_EXEMPT_TAG);
    }
  });
});

describe('doneBlockedReason — what the rule never touches', () => {
  it('leaves tickets already in Done alone, deployed or not', () => {
    // AC: the new rule is not retroactive, which is why it needs no backfill.
    expect(doneBlockedReason(ticket({ status: 'done' }))).toBeNull();
    expect(doneBlockedReason(ticket({ status: 'done', prNumber: null, prState: null }))).toBeNull();
  });

  it('is off for engagements with no repo connected', () => {
    expect(doneBlockedReason(ticket({ repoConnected: false, prNumber: null, prState: null }))).toBeNull();
  });

  it('exempts a ticket tagged no-deploy, whatever its casing', () => {
    expect(doneBlockedReason(ticket({ tags: ['no-deploy'] }))).toBeNull();
    expect(doneBlockedReason(ticket({ tags: ['docs', ' NO-Deploy '] }))).toBeNull();
  });

  it('does not exempt on a merely similar tag', () => {
    expect(doneBlockedReason(ticket({ tags: ['deploy', 'no-deployment'] }))).not.toBeNull();
  });
});

describe('gateInputFromRow', () => {
  it('reads the joined deploy columns off a ticket row', () => {
    expect(
      gateInputFromRow({
        key: 'DAT-9',
        status: 'review',
        tags: ['bug'],
        repo_connected: true,
        pr_number: 7,
        pr_state: 'merged',
        deploy_state: 'success',
      }),
    ).toEqual({
      key: 'DAT-9',
      status: 'review',
      tags: ['bug'],
      repoConnected: true,
      prNumber: 7,
      prState: 'merged',
      deployState: 'success',
    });
  });

  it('treats missing joins as no repo, no PR, no deploy', () => {
    const input = gateInputFromRow({ key: 'DAT-9', status: 'backlog', tags: null });
    expect(input).toMatchObject({ repoConnected: false, prNumber: null, prState: null, deployState: null, tags: [] });
  });
});

describe('toTags', () => {
  it('passes a jsonb array through and drops non-strings', () => {
    expect(toTags(['bug', 3, null, 'no-deploy'])).toEqual(['bug', 'no-deploy']);
  });

  it('parses the serialized form and survives junk', () => {
    expect(toTags('["bug"]')).toEqual(['bug']);
    expect(toTags('not json')).toEqual([]);
    expect(toTags(undefined)).toEqual([]);
  });
});

describe('loadDeployGates', () => {
  const rows = [
    { key: 'DAT-1', status: 'review', tags: [], repo_connected: true, pr_number: 1, pr_state: 'merged', deploy_state: 'success' },
    { key: 'DAT-2', status: 'review', tags: [], repo_connected: true, pr_number: 2, pr_state: 'open', deploy_state: null },
  ];

  it('rules on every named ticket in one query', async () => {
    const seen: unknown[][] = [];
    const q = (_text: string, params?: unknown[]) => {
      seen.push(params ?? []);
      return Promise.resolve({ rows });
    };
    const gates = await loadDeployGates(q, ['DAT-1', 'DAT-2']);
    expect(gates.get('DAT-1')).toBeNull();
    expect(gates.get('DAT-2')).toContain('still open');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([['DAT-1', 'DAT-2']]);
  });

  it('does not query at all for an empty key list', async () => {
    let called = false;
    const gates = await loadDeployGates(() => {
      called = true;
      return Promise.resolve({ rows: [] });
    }, []);
    expect(gates.size).toBe(0);
    expect(called).toBe(false);
  });

  it('omits keys that do not exist', async () => {
    const gates = await loadDeployGates(() => Promise.resolve({ rows: [] }), ['DAT-404']);
    expect(gates.has('DAT-404')).toBe(false);
  });
});
