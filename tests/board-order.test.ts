import { describe, expect, it } from 'vitest';
import { dropBoardTicket, laneOf } from '../client/src/lib/board-order';
import type { Ticket, TicketStatus } from '../client/src/types';

const NOW = '2026-08-11T12:00:00.000Z';

function ticket(key: string, status: TicketStatus, doneAt: string | null = null): Ticket {
  return {
    key,
    engagementId: 'eng',
    title: key,
    status,
    assignee: '—',
    est: '—',
    estHours: null,
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
    doneBlockedReason: null,
    roadmapItem: null,
    branch: null,
    runner: null,
    doneAt,
    updatedAt: null,
    waitingOn: 0,
    activePr: null,
    escalationStage: null,
    escalationPr: null,
  };
}

const keys = (ts: Ticket[]) => ts.map((t) => t.key);

describe('laneOf', () => {
  it('folds In Progress into Backlog and keeps Review/Done', () => {
    expect(laneOf(ticket('T', 'backlog'))).toBe('backlog');
    expect(laneOf(ticket('T', 'progress'))).toBe('backlog');
    expect(laneOf(ticket('T', 'review'))).toBe('review');
    expect(laneOf(ticket('T', 'done', NOW))).toBe('done');
  });
});

describe('dropBoardTicket', () => {
  const board = [ticket('A', 'backlog'), ticket('B', 'backlog'), ticket('C', 'backlog'), ticket('R', 'review')];
  const backlog = (except?: string) => board.slice(0, 3).filter((t) => t.key !== except);

  it('reorders within a lane', () => {
    const r = dropBoardTicket(board, 'C', 'backlog', backlog('C'), 0, NOW);
    expect(r).not.toBeNull();
    expect(keys(r!.tickets)).toEqual(['C', 'A', 'B', 'R']);
    expect(r!.statusChanged).toBe(false);
    expect(r!.orderChanged).toBe(true);
  });

  it('drops at the end of the lane when idx points past the last card', () => {
    const r = dropBoardTicket(board, 'A', 'backlog', backlog('A'), 99, NOW);
    expect(keys(r!.tickets)).toEqual(['B', 'C', 'A', 'R']);
  });

  it('returns null for a drop back into the same slot', () => {
    expect(dropBoardTicket(board, 'B', 'backlog', backlog('B'), 1, NOW)).toBeNull();
  });

  it('moves across lanes at the chosen slot and flags the status change', () => {
    const r = dropBoardTicket(board, 'R', 'backlog', backlog(), 1, NOW);
    expect(keys(r!.tickets)).toEqual(['A', 'R', 'B', 'C']);
    expect(r!.statusChanged).toBe(true);
    expect(r!.tickets[1].status).toBe('backlog');
  });

  it('keeps an In Progress ticket in progress when reordered inside Backlog', () => {
    const mixed = [ticket('A', 'backlog'), ticket('P', 'progress'), ticket('B', 'backlog')];
    const r = dropBoardTicket(mixed, 'P', 'backlog', [mixed[0], mixed[2]], 2, NOW);
    expect(keys(r!.tickets)).toEqual(['A', 'B', 'P']);
    expect(r!.tickets[2].status).toBe('progress');
  });

  it('stamps doneAt entering Done and clears it on the way out', () => {
    const into = dropBoardTicket(board, 'A', 'done', [], 0, NOW);
    expect(into!.tickets.find((t) => t.key === 'A')!.doneAt).toBe(NOW);

    const done = [ticket('D', 'done', NOW), ...board];
    const out = dropBoardTicket(done, 'D', 'backlog', backlog(), 0, NOW);
    const d = out!.tickets.find((t) => t.key === 'D')!;
    expect(d.status).toBe('backlog');
    expect(d.doneAt).toBeNull();
  });

  it('inserts into an empty lane', () => {
    const r = dropBoardTicket(board, 'A', 'done', [], 0, NOW);
    expect(keys(r!.tickets)).toEqual(['B', 'C', 'R', 'A']);
    expect(r!.statusChanged).toBe(true);
  });

  it('returns null for unknown keys', () => {
    expect(dropBoardTicket(board, 'ZZZ', 'backlog', backlog(), 0, NOW)).toBeNull();
  });
});
