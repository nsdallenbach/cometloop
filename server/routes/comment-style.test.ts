import { describe, it, expect } from 'vitest';
import { COMMENT_STYLE_EXAMPLE, COMMENT_STYLE_RULES, commentStyleBrief, commentStyleSection } from './comment-style';

describe('comment style rules', () => {
  it('names every formatting device the ticket asked for', () => {
    const all = COMMENT_STYLE_RULES.join('\n').toLowerCase();
    expect(all).toContain('markdown');
    expect(all).toContain('line breaks');
    expect(all).toContain('bullet');
    expect(all).toContain('paragraph');
    expect(all).toContain('**bold**');
    expect(all).toContain('`inline code`');
  });

  it('bounds list size and nesting so comments stay scannable', () => {
    const all = COMMENT_STYLE_RULES.join('\n');
    expect(all).toMatch(/seven items and one level of nesting/);
    expect(all).toMatch(/three or more/i);
  });

  it('biases to concise over verbose, and exempts one-liners', () => {
    const all = COMMENT_STYLE_RULES.join('\n').toLowerCase();
    expect(all).toContain('under 120 words');
    expect(all).toContain('do not wrap a one-sentence update in headings and bullets');
  });
});

describe('commentStyleSection', () => {
  const section = commentStyleSection();
  const text = section.join('\n');

  it('leads with a heading and renders one bullet per rule', () => {
    expect(section[0]).toBe('## Writing comments on the ticket');
    for (const rule of COMMENT_STYLE_RULES) expect(text).toContain(`- ${rule}`);
  });

  it('accepts a caller-supplied heading', () => {
    expect(commentStyleSection('## House style')[0]).toBe('## House style');
  });

  it('carries a worked example in the new style', () => {
    expect(text).toContain(COMMENT_STYLE_EXAMPLE);
    // The example must practise what it preaches: bullets, bold, inline code.
    expect(COMMENT_STYLE_EXAMPLE).toMatch(/^- /m);
    expect(COMMENT_STYLE_EXAMPLE).toContain('**Changed so far**');
    expect(COMMENT_STYLE_EXAMPLE).toContain('`server/routes/comment-style.ts`');
  });
});

describe('commentStyleBrief', () => {
  it('stays compact enough to sit inside a JSON output contract', () => {
    const brief = commentStyleBrief();
    expect(brief.length).toBeLessThan(600);
    expect(brief.split('\n').length).toBeLessThanOrEqual(7);
  });

  it('still covers paragraphs, lists, emphasis and brevity', () => {
    const brief = commentStyleBrief().toLowerCase();
    expect(brief).toContain('short paragraphs');
    expect(brief).toContain('bulleted list');
    expect(brief).toContain('**bold**');
    expect(brief).toContain('one line');
  });
});
