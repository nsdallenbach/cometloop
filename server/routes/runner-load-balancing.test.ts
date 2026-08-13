import { describe, expect, it, vi } from 'vitest';
import { isGeneralCodingModel, RunnerLoadBalancingBody, runnerCanClaim } from './runner-load-balancing';

describe('general coding model classification', () => {
  it('includes coding harnesses and excludes specialized endpoints', () => {
    for (const model of ['claude-code', 'Codex', 'omnigent', 'gemini', 'copilot', 'cursor']) {
      expect(isGeneralCodingModel(model)).toBe(true);
    }
    for (const model of ['serving-endpoint', 'agentbricks', 'embedding', null]) {
      expect(isGeneralCodingModel(model)).toBe(false);
    }
  });
});

describe('load-balancing input validation', () => {
  it('requires valid weights, caps, unique runners, and a positive pool weight', () => {
    expect(RunnerLoadBalancingBody.safeParse({ runners: [{ name: 'runner-1', weight: 2, cap: null }] }).success).toBe(true);
    expect(RunnerLoadBalancingBody.safeParse({ runners: [{ name: 'runner-1', weight: 0, cap: null }] }).success).toBe(false);
    expect(RunnerLoadBalancingBody.safeParse({ runners: [{ name: 'runner-1', weight: 101, cap: null }] }).success).toBe(false);
    expect(RunnerLoadBalancingBody.safeParse({ runners: [{ name: 'runner-1', weight: 1, cap: 0 }] }).success).toBe(false);
    expect(RunnerLoadBalancingBody.safeParse({ runners: [{ name: 'runner-1', weight: 1, cap: null }, { name: 'RUNNER-1', weight: 1, cap: null }] }).success).toBe(false);
  });
});

describe('runner claim load balancing', () => {
  const configured = [
    { runner_name: 'devbox-codex-1', weight: 3, concurrency_cap: null, updated_at: '2026-08-13T00:00:00Z' },
    { runner_name: 'devbox-codex-2', weight: 1, concurrency_cap: 2, updated_at: '2026-08-13T00:00:00Z' },
  ];

  it('keeps legacy first-come dispatch when no pool is saved', async () => {
    const q = vi.fn().mockResolvedValueOnce({ rows: [] });
    await expect(runnerCanClaim(q, 'project', 'devbox-codex-1')).resolves.toBe(true);
  });

  it('selects the runner with the lowest assignments-to-weight score', async () => {
    const rows = [
      { agent: 'devbox-codex-1', count: 3 },
      { agent: 'devbox-codex-2', count: 2 },
    ];
    const q1 = vi
      .fn()
      .mockResolvedValueOnce({ rows: configured })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows });
    const q2 = vi
      .fn()
      .mockResolvedValueOnce({ rows: configured })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows });
    await expect(runnerCanClaim(q1, 'project', 'devbox-codex-1')).resolves.toBe(true);
    await expect(runnerCanClaim(q2, 'project', 'devbox-codex-2')).resolves.toBe(false);
  });

  it('enforces concurrency caps and zero weights', async () => {
    const capped = vi
      .fn()
      .mockResolvedValueOnce({ rows: configured })
      .mockResolvedValueOnce({ rows: [{ agent: 'devbox-codex-2', count: 2 }] });
    await expect(runnerCanClaim(capped, 'project', 'devbox-codex-2')).resolves.toBe(false);

    const zeroWeight = vi.fn().mockResolvedValueOnce({ rows: [{ ...configured[0], weight: 0 }] });
    await expect(runnerCanClaim(zeroWeight, 'project', 'devbox-codex-1')).resolves.toBe(false);
  });
});
