import { describe, expect, it } from 'vitest';
import { agentHoursOf, deliveredByDay } from '../client/src/lib/delivered-by-day';
import type { Ticket, TicketStatus } from '../client/src/types';

const TODAY = new Date('2026-08-11T12:00:00');

function ticket(
  key: string,
  status: TicketStatus,
  overrides: Partial<Pick<Ticket, 'doneAt' | 'est' | 'estHours' | 'actualHours'>> = {},
): Ticket {
  return {
    key,
    engagementId: 'eng',
    title: key,
    status,
    assignee: '—',
    est: '—',
    estHours: null,
    humanEstHours: null,
    actualHours: null,
    workstream: '',
    agent: false,
    sources: [],
    description: '',
    ac: [],
    blocked: false,
    tags: [],
    deployState: null,
    deployUrl: null,
    roadmapItem: null,
    branch: null,
    doneAt: null,
    waitingOn: 0,
    activePr: null,
    ...overrides,
  };
}

describe('agentHoursOf', () => {
  it('prefers logged actual hours over the estimate', () => {
    expect(agentHoursOf(ticket('T', 'done', { actualHours: 2.5, estHours: 1 }))).toBe(2.5);
  });

  it('falls back to the model estimate', () => {
    expect(agentHoursOf(ticket('T', 'done', { estHours: 1.2 }))).toBe(1.2);
  });

  it('parses legacy est strings', () => {
    expect(agentHoursOf(ticket('T', 'done', { est: '6h' }))).toBe(6);
    expect(agentHoursOf(ticket('T', 'done', { est: '2d' }))).toBe(12);
    expect(agentHoursOf(ticket('T', 'done'))).toBe(0);
  });
});

describe('deliveredByDay', () => {
  it('returns one zeroed bucket per day of the window, oldest first', () => {
    const days = deliveredByDay([], 14, TODAY);
    expect(days).toHaveLength(14);
    expect(days[0].date < days[13].date).toBe(true);
    expect(days.every((d) => d.hours === 0 && d.tickets === 0)).toBe(true);
  });

  it('sums hours and counts per done day', () => {
    const days = deliveredByDay(
      [
        ticket('A', 'done', { doneAt: '2026-08-11T09:00:00.000Z', actualHours: 2 }),
        ticket('B', 'done', { doneAt: '2026-08-11T15:00:00.000Z', estHours: 1.2 }),
        ticket('C', 'done', { doneAt: '2026-08-05T10:00:00.000Z', estHours: 4 }),
      ],
      14,
      TODAY,
    );
    const last = days[days.length - 1];
    expect(last).toEqual({ date: '2026-08-11', hours: 3.2, tickets: 2 });
    expect(days.find((d) => d.date === '2026-08-05')).toEqual({ date: '2026-08-05', hours: 4, tickets: 1 });
  });

  it('counts only done tickets inside the window', () => {
    const days = deliveredByDay(
      [
        ticket('open', 'progress', { doneAt: '2026-08-11T09:00:00.000Z', estHours: 3 }),
        ticket('review', 'review', { estHours: 3 }),
        ticket('undated', 'done', { estHours: 3 }),
        ticket('stale', 'done', { doneAt: '2026-07-01T09:00:00.000Z', estHours: 3 }),
      ],
      14,
      TODAY,
    );
    expect(days.every((d) => d.hours === 0 && d.tickets === 0)).toBe(true);
  });

  it('keeps hour sums to one decimal despite float accumulation', () => {
    const days = deliveredByDay(
      Array.from({ length: 3 }, (_, i) => ticket(`T${i}`, 'done', { doneAt: '2026-08-10T09:00:00.000Z', estHours: 0.1 })),
      14,
      TODAY,
    );
    expect(days.find((d) => d.date === '2026-08-10')).toEqual({ date: '2026-08-10', hours: 0.3, tickets: 3 });
  });
});
