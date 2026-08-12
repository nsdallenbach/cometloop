import { describe, expect, it } from 'vitest';
import { extractTicketMentions, normalizeLink } from './ticket-links';

const known = new Set(['DAT-1', 'DAT-2', 'DAT-10', 'NAC-104']);

describe('extractTicketMentions', () => {
  it('finds known ticket keys in free text', () => {
    expect(extractTicketMentions('Depends on DAT-2 and NAC-104 landing first.', known, 'DAT-1')).toEqual(['DAT-2', 'NAC-104']);
  });

  it('excludes the ticket itself', () => {
    expect(extractTicketMentions('DAT-1 follows DAT-2.', known, 'DAT-1')).toEqual(['DAT-2']);
  });

  it('ignores keys that are not on the board', () => {
    expect(extractTicketMentions('See DAT-999 and JIRA-1 for context.', known, 'DAT-1')).toEqual([]);
  });

  it('deduplicates while preserving first-mention order', () => {
    expect(extractTicketMentions('DAT-10 then DAT-2 then DAT-10 again.', known, 'DAT-1')).toEqual(['DAT-10', 'DAT-2']);
  });

  it('does not match keys embedded in longer identifiers', () => {
    expect(extractTicketMentions('branch XDAT-2y and DAT-23', new Set(['DAT-2']), 'DAT-1')).toEqual([]);
  });

  it('returns nothing for empty text', () => {
    expect(extractTicketMentions('', known, 'DAT-1')).toEqual([]);
  });
});

describe('normalizeLink', () => {
  it('stores blocks as written', () => {
    expect(normalizeLink('DAT-1', 'DAT-2', 'blocks')).toEqual({ from: 'DAT-1', to: 'DAT-2', type: 'blocks' });
  });

  it('flips blocked_by into the reverse blocks row', () => {
    expect(normalizeLink('DAT-1', 'DAT-2', 'blocked_by')).toEqual({ from: 'DAT-2', to: 'DAT-1', type: 'blocks' });
  });

  it('stores relates as written', () => {
    expect(normalizeLink('DAT-1', 'DAT-2', 'relates')).toEqual({ from: 'DAT-1', to: 'DAT-2', type: 'relates' });
  });
});
