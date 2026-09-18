import { describe, expect, it } from 'vitest';
import { mapTrafficToTickets, zoneFromRow, type TrafficMessage } from './canvas';

const msg = (over: Partial<TrafficMessage>): TrafficMessage => ({
  id: 1,
  sender: 'claude-ns',
  recipient: null,
  ticket: null,
  type: 'status_update',
  body: '',
  createdAt: '2026-09-17T10:00:00.000Z',
  ...over,
});

describe('mapTrafficToTickets', () => {
  const active = new Map([
    ['claude-ns', 'DAT-1'],
    ['codex-jr', 'DAT-2'],
  ]);
  const board = new Set(['DAT-1', 'DAT-2', 'DAT-3']);

  it('joins the sender’s active ticket to the message’s ticket', () => {
    const [t] = mapTrafficToTickets([msg({ ticket: 'DAT-3' })], active, board);
    expect(t.from).toBe('DAT-1');
    expect(t.to).toBe('DAT-3');
  });

  it('falls back to the recipient’s active ticket when the message names none', () => {
    const [t] = mapTrafficToTickets([msg({ recipient: 'codex-jr' })], active, board);
    expect(t.to).toBe('DAT-2');
  });

  it('keeps a message with only one end on the board, as a pulse', () => {
    const [t] = mapTrafficToTickets([msg({ sender: 'someone-else', recipient: 'claude-ns' })], active, board);
    expect(t.from).toBeNull();
    expect(t.to).toBe('DAT-1');
  });

  it('drops a message with neither end on the board', () => {
    expect(mapTrafficToTickets([msg({ sender: 'x', ticket: 'OTHER-9' })], active, board)).toEqual([]);
  });
});

describe('zoneFromRow', () => {
  it('coerces Postgres row values and defaults a missing column count', () => {
    expect(zoneFromRow({ id: '3', tag: 'docs', x: '40', y: 12, cols: null })).toEqual({ id: 3, tag: 'docs', x: 40, y: 12, cols: 2 });
  });
});
