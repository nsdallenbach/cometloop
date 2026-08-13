import { describe, expect, it } from 'vitest';
import { canonicalTag, normalizeTags, STANDARD_TAGS } from './ticket-tags';

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

  // DAT-210: feature/bug are ordinary tags, but their casing is canonical so
  // the board never shows `Bug` and `bug` as two different labels.
  it('canonicalizes the standard feature/bug tags to lowercase', () => {
    expect(normalizeTags(['Bug', ' FEATURE '])).toEqual(['bug', 'feature']);
  });

  it('keeps a standard tag once when typed in several casings', () => {
    expect(normalizeTags(['Feature', 'feature', 'infra'])).toEqual(['feature', 'infra']);
  });
});

describe('canonicalTag', () => {
  it('maps any casing of a standard tag to its canonical spelling', () => {
    for (const tag of STANDARD_TAGS) {
      expect(canonicalTag(tag.toUpperCase())).toBe(tag);
      expect(canonicalTag(` ${tag} `)).toBe(tag);
    }
  });

  it('leaves non-standard tags alone apart from trimming', () => {
    expect(canonicalTag('  Infra ')).toBe('Infra');
  });
});
