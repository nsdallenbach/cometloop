import { describe, expect, it } from 'vitest';
import { splitMermaid } from '../client/src/lib/md-segments';

describe('splitMermaid', () => {
  it('passes plain markdown through as one segment', () => {
    expect(splitMermaid('# hi\n\nsome text')).toEqual([{ kind: 'md', body: '# hi\n\nsome text' }]);
  });

  it('extracts a mermaid fence between markdown segments', () => {
    const text = 'before\n\n```mermaid\nflowchart LR\n  A -->|calls| B\n```\n\nafter';
    expect(splitMermaid(text)).toEqual([
      { kind: 'md', body: 'before\n\n' },
      { kind: 'mermaid', body: 'flowchart LR\n  A -->|calls| B' },
      { kind: 'md', body: '\n\nafter' },
    ]);
  });

  it('handles multiple diagrams and CRLF fences', () => {
    const text = '```mermaid\r\ngraph TD\r\n  A --> B\r\n```\nmiddle\n```mermaid\nsequenceDiagram\n  A->>B: hi\n```';
    const segs = splitMermaid(text);
    expect(segs.filter((s) => s.kind === 'mermaid')).toHaveLength(2);
    expect(segs[0]).toEqual({ kind: 'mermaid', body: 'graph TD\r\n  A --> B' });
  });

  it('leaves an unclosed fence as plain markdown', () => {
    const text = 'intro\n```mermaid\nflowchart LR\n  A --> B';
    expect(splitMermaid(text)).toEqual([{ kind: 'md', body: text }]);
  });

  it('does not treat other fences as diagrams', () => {
    const text = '```ts\nconst x = 1;\n```';
    expect(splitMermaid(text)).toEqual([{ kind: 'md', body: text }]);
  });

  it('drops empty mermaid fences instead of rendering nothing', () => {
    const segs = splitMermaid('a\n```mermaid\n\n```\nb');
    expect(segs.filter((s) => s.kind === 'mermaid')).toHaveLength(0);
  });

  it('always returns at least one segment for empty input', () => {
    expect(splitMermaid('')).toEqual([{ kind: 'md', body: '' }]);
  });
});
