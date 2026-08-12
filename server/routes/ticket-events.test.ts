import { describe, expect, it } from 'vitest';
import { computeBurndown, type TicketEvent } from './ticket-events';

const ev = (ticketKey: string, toStatus: string, createdAt: string): TicketEvent => ({ ticketKey, toStatus, createdAt });

describe('computeBurndown', () => {
  it('returns an empty series when there are no events (zero tickets)', () => {
    expect(computeBurndown([], '2026-08-11')).toEqual([]);
  });

  it('yields a single day for a freshly created engagement', () => {
    const days = computeBurndown([ev('A-101', 'backlog', '2026-08-11T09:00:00Z'), ev('A-102', 'backlog', '2026-08-11T09:00:01Z')], '2026-08-11');
    expect(days).toEqual([{ date: '2026-08-11', open: 2, done: 0, total: 2 }]);
  });

  it('replays transitions into end-of-day open/done counts', () => {
    const days = computeBurndown(
      [
        ev('A-101', 'backlog', '2026-08-01T09:00:00Z'),
        ev('A-102', 'backlog', '2026-08-01T09:00:01Z'),
        ev('A-101', 'progress', '2026-08-02T10:00:00Z'),
        ev('A-101', 'done', '2026-08-03T17:00:00Z'),
      ],
      '2026-08-04',
    );
    expect(days).toEqual([
      { date: '2026-08-01', open: 2, done: 0, total: 2 },
      { date: '2026-08-02', open: 2, done: 0, total: 2 },
      { date: '2026-08-03', open: 1, done: 1, total: 2 },
      { date: '2026-08-04', open: 1, done: 1, total: 2 },
    ]);
  });

  it('counts only the latest status per ticket within a day', () => {
    const days = computeBurndown(
      [ev('A-101', 'backlog', '2026-08-01T09:00:00Z'), ev('A-101', 'done', '2026-08-01T12:00:00Z')],
      '2026-08-01',
    );
    expect(days).toEqual([{ date: '2026-08-01', open: 0, done: 1, total: 1 }]);
  });

  it('keeps proposed and dismissed tickets off the board counts', () => {
    const days = computeBurndown(
      [
        ev('A-101', 'proposed', '2026-08-01T09:00:00Z'),
        ev('A-102', 'backlog', '2026-08-01T09:00:01Z'),
        ev('A-102', 'dismissed', '2026-08-02T09:00:00Z'),
      ],
      '2026-08-02',
    );
    expect(days).toEqual([
      { date: '2026-08-01', open: 1, done: 0, total: 1 },
      { date: '2026-08-02', open: 0, done: 0, total: 0 },
    ]);
  });

  it('extends the series through today even without recent events', () => {
    const days = computeBurndown([ev('A-101', 'backlog', '2026-08-01T09:00:00Z')], '2026-08-05');
    expect(days).toHaveLength(5);
    expect(days[4]).toEqual({ date: '2026-08-05', open: 1, done: 0, total: 1 });
  });

  it('clamps the range to the trailing year and folds older events into the opening day', () => {
    const days = computeBurndown(
      [ev('A-101', 'backlog', '2020-01-01T00:00:00Z'), ev('A-101', 'done', '2020-06-01T00:00:00Z')],
      '2026-08-11',
    );
    expect(days).toHaveLength(366);
    expect(days[0].done).toBe(1);
    expect(days[days.length - 1]).toEqual({ date: '2026-08-11', open: 0, done: 1, total: 1 });
  });

  it('tolerates an event timestamped after today (clock skew)', () => {
    const days = computeBurndown([ev('A-101', 'backlog', '2026-08-12T01:00:00Z')], '2026-08-11');
    expect(days).toEqual([{ date: '2026-08-12', open: 1, done: 0, total: 1 }]);
  });
});
