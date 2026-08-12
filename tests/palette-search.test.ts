import { describe, expect, it } from 'vitest';
import { damerauLevenshtein, searchPaletteItems, tokenScore } from '../client/src/lib/palette-search';

const items = [
  { kind: 'NAV', label: 'Go to Portfolio', hint: 'G P', description: 'All engagements overview', keywords: ['home', 'engagements'] },
  { kind: 'NAV', label: 'ACME — open Board', hint: '', keywords: ['board', 'kanban', 'tickets'] },
  { kind: 'ACTION', label: 'New ticket — ACME board', hint: 'N', description: 'Create a ticket on the current board', keywords: ['create', 'add'] },
  { kind: 'ACTION', label: 'New engagement (from SOW or brief)', hint: '', keywords: ['create', 'project', 'sow'] },
  { kind: 'NAV', label: 'Open status feed', hint: '', description: 'Latest activity and updates', keywords: ['activity', 'updates'] },
  { kind: 'TICKET', label: 'DAT-101 — Fix login redirect', hint: 'IN PROGRESS', keywords: ['DAT-101', 'progress'] },
];

describe('searchPaletteItems', () => {
  it('returns all items in original order for an empty query', () => {
    expect(searchPaletteItems(items, '')).toEqual(items);
    expect(searchPaletteItems(items, '   ')).toEqual(items);
    expect(searchPaletteItems(items, '', 3)).toHaveLength(3);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchPaletteItems(items, 'zzzzqqqq')).toEqual([]);
  });

  it('matches exact substrings case-insensitively', () => {
    const res = searchPaletteItems(items, 'PORTFOLIO');
    expect(res[0]?.label).toBe('Go to Portfolio');
  });

  it('fuzzy-matches subsequences, not just substrings', () => {
    const res = searchPaletteItems(items, 'gtp'); // Go To Portfolio
    expect(res[0]?.label).toBe('Go to Portfolio');
  });

  it('tolerates misspellings', () => {
    expect(searchPaletteItems(items, 'portfolo')[0]?.label).toBe('Go to Portfolio');
    expect(searchPaletteItems(items, 'ticekt').map((i) => i.label)).toContain('New ticket — ACME board');
  });

  it('matches keywords and aliases, not only the label', () => {
    expect(searchPaletteItems(items, 'kanban')[0]?.label).toBe('ACME — open Board');
    expect(searchPaletteItems(items, 'home')[0]?.label).toBe('Go to Portfolio');
  });

  it('matches against the description field', () => {
    expect(searchPaletteItems(items, 'activity')[0]?.label).toBe('Open status feed');
  });

  it('matches ticket keys', () => {
    expect(searchPaletteItems(items, 'dat-101')[0]?.kind).toBe('TICKET');
  });

  it('ranks label matches above keyword/description matches', () => {
    // "board" is in two labels and in keywords of the Board nav item;
    // a label word-boundary hit should not lose to a weighted keyword hit.
    const res = searchPaletteItems(items, 'board');
    expect(res.map((i) => i.label).slice(0, 3)).toEqual(
      expect.arrayContaining(['ACME — open Board', 'New ticket — ACME board']),
    );
  });

  it('ranks prefix matches above weaker fuzzy matches', () => {
    const res = searchPaletteItems(items, 'new');
    expect(res[0]?.label.startsWith('New')).toBe(true);
  });

  it('requires every token of a multi-word query to match', () => {
    const res = searchPaletteItems(items, 'new engagement');
    expect(res[0]?.label).toBe('New engagement (from SOW or brief)');
    expect(searchPaletteItems(items, 'new zzzz')).toEqual([]);
  });

  it('respects the result limit after ranking', () => {
    expect(searchPaletteItems(items, 'e', 2)).toHaveLength(2);
  });

  it('stays fast on a large item list', () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({
      kind: 'NAV',
      label: `Command number ${i} — open something`,
      hint: '',
      keywords: [`alias-${i}`, 'navigate'],
    }));
    const start = performance.now();
    searchPaletteItems(big, 'comand 15', 9);
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('tokenScore ordering', () => {
  it('scores exact > prefix > boundary substring > substring > fuzzy', () => {
    const exact = tokenScore('board', 'board');
    const prefix = tokenScore('boa', 'board');
    const boundary = tokenScore('board', 'open board');
    const substring = tokenScore('oar', 'board');
    const fuzzy = tokenScore('brd', 'board');
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });
});

describe('damerauLevenshtein', () => {
  it('computes small edit distances', () => {
    expect(damerauLevenshtein('ticket', 'ticket', 2)).toBe(0);
    expect(damerauLevenshtein('ticekt', 'ticket', 2)).toBe(1); // transposition
    expect(damerauLevenshtein('portfolo', 'portfolio', 2)).toBe(1); // omission
    expect(damerauLevenshtein('abc', 'xyz', 2)).toBeGreaterThan(2);
  });
});
