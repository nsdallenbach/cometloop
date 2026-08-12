import { describe, expect, it } from 'vitest';
import { agentHoursFromRuns, calibrationFactor, clampHours, parseEstimateOutput, type AgentRun } from './estimates';

describe('clampHours', () => {
  it('rounds to one decimal', () => {
    expect(clampHours(1.44)).toBe(1.4);
    expect(clampHours(1.45)).toBe(1.5);
  });

  it('clamps to the storable range', () => {
    expect(clampHours(0)).toBe(0.1);
    expect(clampHours(-3)).toBe(0.1);
    expect(clampHours(10_000)).toBe(999);
  });
});

describe('calibrationFactor', () => {
  it('stays at 1 with fewer than 3 samples', () => {
    expect(calibrationFactor([])).toBe(1);
    expect(calibrationFactor([2, 2])).toBe(1);
  });

  it('uses the median ratio', () => {
    expect(calibrationFactor([0.5, 1.2, 2])).toBe(1.2);
    expect(calibrationFactor([0.8, 1, 1.5, 2])).toBe(1.25);
  });

  it('ignores non-finite and non-positive ratios', () => {
    expect(calibrationFactor([NaN, Infinity, -1, 0, 1.5, 1.5, 1.5])).toBe(1.5);
    // Only two valid samples remain — not enough to move off 1.
    expect(calibrationFactor([NaN, 2, 2])).toBe(1);
  });

  it('clamps runaway medians into [0.3, 3]', () => {
    expect(calibrationFactor([9, 10, 11])).toBe(3);
    expect(calibrationFactor([0.01, 0.02, 0.03])).toBe(0.3);
  });
});

describe('parseEstimateOutput', () => {
  it('parses a clean JSON response', () => {
    expect(
      parseEstimateOutput('{"hours": 2.5, "human_hours": 10, "confidence": "high", "rationale": "Small change."}')
    ).toEqual({
      hours: 2.5,
      humanHours: 10,
      confidence: 'high',
      rationale: 'Small change.',
    });
  });

  it('extracts JSON from surrounding prose and rounds hours', () => {
    const parsed = parseEstimateOutput(
      'Sure! Here is the estimate:\n{"hours": 1.234, "human_hours": 4.56, "confidence": "low", "rationale": "x"}\nDone.'
    );
    expect(parsed?.hours).toBe(1.2);
    expect(parsed?.humanHours).toBe(4.6);
    expect(parsed?.confidence).toBe('low');
  });

  it('tolerates a missing or unusable human estimate (agent hours still parse)', () => {
    expect(parseEstimateOutput('{"hours": 1}')?.humanHours).toBeNull();
    expect(parseEstimateOutput('{"hours": 1, "human_hours": "a lot"}')?.humanHours).toBeNull();
    expect(parseEstimateOutput('{"hours": 1, "human_hours": -4}')?.humanHours).toBeNull();
  });

  it('defaults a missing or unknown confidence to medium', () => {
    expect(parseEstimateOutput('{"hours": 1}')?.confidence).toBe('medium');
    expect(parseEstimateOutput('{"hours": 1, "confidence": "certain"}')?.confidence).toBe('medium');
  });

  it('rejects responses without usable hours', () => {
    expect(parseEstimateOutput('no json here')).toBeNull();
    expect(parseEstimateOutput('{"hours": "soon"}')).toBeNull();
    expect(parseEstimateOutput('{"hours": -2}')).toBeNull();
    expect(parseEstimateOutput('{"rationale": "eventually"}')).toBeNull();
  });

  it('clamps absurd hours into range', () => {
    expect(parseEstimateOutput('{"hours": 50000}')?.hours).toBe(999);
    expect(parseEstimateOutput('{"hours": 0.01}')?.hours).toBe(0.1);
  });
});

describe('agentHoursFromRuns', () => {
  const now = new Date('2026-08-11T12:00:00Z');
  const run = (over: Partial<AgentRun>): AgentRun => ({
    state: 'done',
    claimed_at: '2026-08-11T08:00:00Z',
    updated_at: '2026-08-11T10:30:00Z',
    ...over,
  });

  it('is null when no run was ever claimed', () => {
    expect(agentHoursFromRuns([], now)).toBeNull();
    expect(agentHoursFromRuns([run({ claimed_at: null })], now)).toBeNull();
  });

  it('measures a finished run from claim to completion', () => {
    expect(agentHoursFromRuns([run({})], now)).toBe(2.5);
  });

  it('measures a still-active run up to now', () => {
    expect(
      agentHoursFromRuns(
        [run({ state: 'working', claimed_at: '2026-08-11T11:00:00Z', updated_at: '2026-08-11T11:10:00Z' })],
        now
      )
    ).toBe(1);
  });

  it('sums multiple runs (a failed attempt still burned agent time)', () => {
    const runs = [
      run({ state: 'failed', claimed_at: '2026-08-11T06:00:00Z', updated_at: '2026-08-11T07:00:00Z' }),
      run({ claimed_at: '2026-08-11T08:00:00Z', updated_at: '2026-08-11T09:30:00Z' }),
    ];
    expect(agentHoursFromRuns(runs, now)).toBe(2.5);
  });

  it('skips runs with a completion timestamp before the claim', () => {
    expect(agentHoursFromRuns([run({ updated_at: '2026-08-11T07:00:00Z' })], now)).toBeNull();
  });

  it('prefers the tool-call activity window over wall clock', () => {
    // Claimed 08:00, task closed 10:30 — but the agent only worked 08:05→09:05.
    expect(
      agentHoursFromRuns([run({ first_call: '2026-08-11T08:05:00Z', last_call: '2026-08-11T09:05:00Z' })], now)
    ).toBe(1);
  });

  it('caps a wedged run at its last heartbeat, not the manual completion', () => {
    // Runner died at 08:30; a human completed the task at 19:00 — 10.5h of idle must not count.
    expect(
      agentHoursFromRuns([run({ last_heartbeat: '2026-08-11T08:30:00Z', updated_at: '2026-08-11T19:00:00Z' })], now)
    ).toBe(0.5);
  });

  it('review idle after the last tool call never counts', () => {
    // Work ended 09:00 (last call); ticket sat in review until a 11:45 completion.
    expect(
      agentHoursFromRuns(
        [run({ first_call: '2026-08-11T08:00:00Z', last_call: '2026-08-11T09:00:00Z', updated_at: '2026-08-11T11:45:00Z' })],
        now
      )
    ).toBe(1);
  });

  it('an active run without calls measures to its heartbeat, not now', () => {
    expect(
      agentHoursFromRuns(
        [run({ state: 'working', claimed_at: '2026-08-11T08:00:00Z', last_heartbeat: '2026-08-11T09:00:00Z' })],
        now
      )
    ).toBe(1);
  });

  it('floors very short runs at 0.1h', () => {
    expect(
      agentHoursFromRuns([run({ claimed_at: '2026-08-11T09:59:00Z', updated_at: '2026-08-11T10:00:00Z' })], now)
    ).toBe(0.1);
  });
});
