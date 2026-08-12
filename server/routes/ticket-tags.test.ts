import { describe, expect, it } from 'vitest';
import { normalizeTags } from './ticket-tags';

describe('normalizeTags', () => {
  it('trims whitespace and drops empty entries', () => {
    expect(normalizeTags(['  urgent ', '', '   ', 'backend'])).toEqual(['urgent', 'backend']);
  });

  it('dedupes case-insensitively, keeping the first spelling typed', () => {
    expect(normalizeTags(['Infra', 'infra', 'INFRA', 'db'])).toEqual(['Infra', 'db']);
  });

  it('preserves order and passes clean lists through unchanged', () => {
    expect(normalizeTags(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list for no tags', () => {
    expect(normalizeTags([])).toEqual([]);
  });
});
