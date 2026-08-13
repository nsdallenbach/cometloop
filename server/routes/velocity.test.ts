import { describe, expect, it } from 'vitest';
import { computeVelocity, median, replayLifecycles, weekStart, type VelocityEvent } from './velocity';

const NOW = '2026-08-12T12:00:00.000Z';

const ev = (ticketKey: string, toStatus: string, createdAt: string): VelocityEvent => ({
  ticketKey,
  fromStatus: null,
  toStatus,
  createdAt,
});

describe('median', () => {
  it('handles empty, odd and even sample sets', () => {
    expect(median([])).toBeNull();
    expect(median([3])).toBe(3);
    expect(median([1, 10, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe('weekStart', () => {
  it('returns the UTC Monday of the timestamp week', () => {
    expect(weekStart('2026-08-12T05:00:00Z')).toBe('2026-08-10'); // Wednesday → Monday
    expect(weekStart('2026-08-10T00:00:00Z')).toBe('2026-08-10'); // Monday stays
    expect(weekStart('2026-08-09T23:59:00Z')).toBe('2026-08-03'); // Sunday → prior Monday
  });
});

describe('replayLifecycles', () => {
  it('tracks creation, work start, review passes and done', () => {
    const life = replayLifecycles([
      ev('T-1', 'backlog', '2026-08-01T00:00:00Z'),
      ev('T-1', 'progress', '2026-08-02T00:00:00Z'),
      ev('T-1', 'review', '2026-08-03T00:00:00Z'),
      ev('T-1', 'done', '2026-08-04T00:00:00Z'),
    ]);
    const t = life.get('T-1');
    expect(t?.startedAt).toBe('2026-08-02T00:00:00Z');
    expect(t?.doneAt).toBe('2026-08-04T00:00:00Z');
    expect(t?.reviews).toEqual([{ enteredAt: '2026-08-03T00:00:00Z', leftAt: '2026-08-04T00:00:00Z', approved: true }]);
  });

  it('counts an approval into Deploying as a passed review (DAT-222)', () => {
    const life = replayLifecycles([
      ev('T-3', 'review', '2026-08-03T00:00:00Z'),
      ev('T-3', 'deploying', '2026-08-03T06:00:00Z'),
      ev('T-3', 'done', '2026-08-03T08:00:00Z'),
    ]);
    const t = life.get('T-3');
    expect(t?.reviews).toEqual([{ enteredAt: '2026-08-03T00:00:00Z', leftAt: '2026-08-03T06:00:00Z', approved: true }]);
    expect(t?.doneAt).toBe('2026-08-03T08:00:00Z');
  });

  it('a review bounce records approved=false and reopening clears doneAt', () => {
    const life = replayLifecycles([
      ev('T-2', 'backlog', '2026-08-01T00:00:00Z'),
      ev('T-2', 'review', '2026-08-02T00:00:00Z'),
      ev('T-2', 'backlog', '2026-08-03T00:00:00Z'),
      ev('T-2', 'done', '2026-08-04T00:00:00Z'),
      ev('T-2', 'backlog', '2026-08-05T00:00:00Z'),
    ]);
    const t = life.get('T-2');
    expect(t?.reviews[0]?.approved).toBe(false);
    expect(t?.doneAt).toBeNull();
  });
});

describe('computeVelocity', () => {
  const events = [
    // T-1: done inside the trailing window — 72h lead, 48h cycle, 24h review.
    ev('T-1', 'backlog', '2026-08-07T12:00:00Z'),
    ev('T-1', 'progress', '2026-08-08T12:00:00Z'),
    ev('T-1', 'review', '2026-08-09T12:00:00Z'),
    ev('T-1', 'done', '2026-08-10T12:00:00Z'),
    // T-2: done in the PREVIOUS window — 48h lead.
    ev('T-2', 'backlog', '2026-07-19T12:00:00Z'),
    ev('T-2', 'review', '2026-07-20T12:00:00Z'),
    ev('T-2', 'done', '2026-07-21T12:00:00Z'),
    // T-3: still open.
    ev('T-3', 'backlog', '2026-08-01T00:00:00Z'),
  ];
  const tasks = [
    { ticketKey: 'T-1', createdAt: '2026-08-08T00:00:00Z', claimedAt: '2026-08-08T06:00:00Z' },
    { ticketKey: 'T-9', createdAt: '2026-08-08T00:00:00Z', claimedAt: null }, // never claimed — no queue sample
  ];
  const tickets = [
    { key: 'T-1', status: 'done', estHours: 2, humanEstHours: 8, actualHours: 1.5 },
    { key: 'T-2', status: 'done', estHours: 1, humanEstHours: 4, actualHours: null },
    { key: 'T-3', status: 'backlog', estHours: null, humanEstHours: null, actualHours: null },
  ];

  const report = computeVelocity(events, tasks, tickets, NOW);

  it('windows lead time into current vs previous', () => {
    expect(report.leadTimeHrs.current).toBe(72);
    expect(report.leadTimeHrs.previous).toBe(48);
    expect(report.cycleTimeHrs.current).toBe(48);
  });

  it('measures decision latency from completed review passes', () => {
    expect(report.decisionTimeHrs.current).toBe(24);
    expect(report.reviewPassRate).toBe(100);
  });

  it('ranks stage dwell including agent queue wait', () => {
    const queue = report.stages.find((s) => s.key === 'queue');
    expect(queue?.medianHrs).toBe(6);
    expect(queue?.samples).toBe(1);
  });

  it('counts human hours saved only for agent-touched done tickets', () => {
    // T-1 is agent-claimed (8h human-equivalent); T-2 was done without an agent claim.
    expect(report.humanHoursSaved.total).toBe(8);
    expect(report.humanHoursSaved.window).toBe(8);
    expect(report.humanHoursSaved.agentHoursSpent).toBe(1.5);
  });

  it('builds the backlog series with a delta over the window', () => {
    expect(report.backlog.length).toBeGreaterThan(1);
    expect(report.backlog[report.backlog.length - 1].open).toBe(1); // only T-3 open now
    expect(report.backlogDelta).not.toBeNull();
  });

  it('produces weekly buckets oldest-first', () => {
    expect(report.weekly.map((w) => w.week)).toEqual(['2026-07-20', '2026-08-10']);
    expect(report.weekly[1].doneCount).toBe(1);
    expect(report.weekly[1].humanHoursSaved).toBe(8);
  });

  it('compares then vs now once the trail spans 14+ days', () => {
    expect(report.thenVsNow).not.toBeNull();
    expect(report.thenVsNow?.then.donePerWeek).toBeGreaterThan(0);
    expect(report.thenVsNow?.now.donePerWeek).toBeGreaterThan(0);
  });

  it('returns an all-null shape on an empty trail', () => {
    const empty = computeVelocity([], [], [], NOW);
    expect(empty.leadTimeHrs.current).toBeNull();
    expect(empty.backlog).toEqual([]);
    expect(empty.thenVsNow).toBeNull();
    expect(empty.reviewPassRate).toBeNull();
  });
});
