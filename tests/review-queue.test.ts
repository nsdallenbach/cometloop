import { describe, expect, it } from 'vitest';
import { nextInQueue, queuePosition, reviewQueue } from '../client/src/lib/review-queue';
import type { Ticket, TicketStatus } from '../client/src/types';

/**
 * DAT-222: approving or rejecting a ticket hands the reviewer the next one in
 * Review, so a sitting of sign-offs never goes back through the board.
 */

function ticket(key: string, status: TicketStatus): Ticket {
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
    runner: null,
    doneAt: null,
    updatedAt: null,
    waitingOn: 0,
    activePr: null,
    escalationStage: null,
    escalationPr: null,
  };
}

const board = [
  ticket('A', 'backlog'),
  ticket('R1', 'review'),
  ticket('D', 'deploying'),
  ticket('R2', 'review'),
  ticket('R3', 'review'),
  ticket('Z', 'done'),
];

describe('reviewQueue', () => {
  it('is the Review lane in board order — deploying and done are past the gate', () => {
    expect(reviewQueue(board).map((t) => t.key)).toEqual(['R1', 'R2', 'R3']);
  });
});

describe('queuePosition', () => {
  it('is 1-based, and 0 for a ticket that is not in review', () => {
    expect(queuePosition(board, 'R1')).toBe(1);
    expect(queuePosition(board, 'R3')).toBe(3);
    expect(queuePosition(board, 'D')).toBe(0);
  });
});

describe('nextInQueue', () => {
  it('advances to the following ticket in the queue', () => {
    expect(nextInQueue(board, 'R1')?.key).toBe('R2');
    expect(nextInQueue(board, 'R2')?.key).toBe('R3');
  });

  it('wraps to the top of the queue after the last ticket', () => {
    expect(nextInQueue(board, 'R3')?.key).toBe('R1');
  });

  it('returns null when the decided ticket was the only one left', () => {
    expect(nextInQueue([ticket('A', 'backlog'), ticket('R1', 'review')], 'R1')).toBeNull();
    expect(nextInQueue([], 'R1')).toBeNull();
  });

  it('starts at the top when the decided ticket has already left Review', () => {
    // A poll can land between the click and the response; the reviewer still
    // gets a ticket rather than being dropped back to the board.
    expect(nextInQueue(board, 'D')?.key).toBe('R1');
  });
});
