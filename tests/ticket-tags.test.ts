import { describe, expect, it } from 'vitest';
import { canonicalTag, STANDARD_TAGS, suggestedTags, ticketMatchesQuery } from '../client/src/lib/ticket-tags';
import {
  canonicalTag as serverCanonicalTag,
  normalizeTags,
  STANDARD_TAGS as SERVER_STANDARD_TAGS,
} from '../server/routes/ticket-tags';

const ticket = (over: Partial<Parameters<typeof ticketMatchesQuery>[0]> = {}) => ({
  key: 'DAT-210',
  title: 'Add feature/bug tag support to tickets',
  assignee: 'local-runner-2',
  client: 'DATAVAIL',
  engagementName: 'Execution Console',
  tags: [] as string[],
  ...over,
});

describe('standard tags (DAT-210)', () => {
  it('offers feature and bug', () => {
    expect([...STANDARD_TAGS]).toEqual(['feature', 'bug']);
  });

  // The client copy exists because client and server share no module; this is
  // what stops the two lists (and their casing rules) from drifting.
  it('matches the server list the API normalizes against', () => {
    expect([...STANDARD_TAGS]).toEqual([...SERVER_STANDARD_TAGS]);
    for (const tag of ['Bug', 'FEATURE', ' feature ', 'Infra']) {
      expect(canonicalTag(tag)).toBe(serverCanonicalTag(tag));
    }
  });

  it('survives a round trip through the API normalizer unchanged', () => {
    expect(normalizeTags([...STANDARD_TAGS])).toEqual([...STANDARD_TAGS]);
  });
});

describe('suggestedTags', () => {
  it('offers both standard tags on an untagged ticket', () => {
    expect(suggestedTags([])).toEqual(['feature', 'bug']);
  });

  it('drops a standard tag once applied, whatever its casing', () => {
    expect(suggestedTags(['Bug'])).toEqual(['feature']);
    expect(suggestedTags(['feature', 'bug'])).toEqual([]);
  });

  it('ignores unrelated tags', () => {
    expect(suggestedTags(['infra', 'urgent'])).toEqual(['feature', 'bug']);
  });
});

describe('ticketMatchesQuery', () => {
  it('keeps every ticket when the query is blank', () => {
    expect(ticketMatchesQuery(ticket(), '   ')).toBe(true);
  });

  it('filters by an applied tag', () => {
    expect(ticketMatchesQuery(ticket({ tags: ['bug'] }), 'bug')).toBe(true);
    expect(ticketMatchesQuery(ticket({ title: 'Ship it', tags: ['feature'] }), 'bug')).toBe(false);
  });

  it('matches tags case-insensitively', () => {
    expect(ticketMatchesQuery(ticket({ tags: ['Feature'] }), 'FEATURE')).toBe(true);
  });

  it('still matches key, title, assignee and project', () => {
    expect(ticketMatchesQuery(ticket(), 'dat-210')).toBe(true);
    expect(ticketMatchesQuery(ticket(), 'execution')).toBe(true);
    expect(ticketMatchesQuery(ticket(), 'runner-2')).toBe(true);
    expect(ticketMatchesQuery(ticket(), 'nothing here')).toBe(false);
  });
});
