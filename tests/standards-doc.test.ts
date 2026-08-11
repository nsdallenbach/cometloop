import { describe, expect, it } from 'vitest';
import { fencedBlock, lineDiff } from '../client/src/lib/standards-doc';

describe('lineDiff', () => {
  it('marks unchanged documents as all-same', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(d).not.toBeNull();
    expect(d!.every((l) => l.type === 'same')).toBe(true);
    expect(d!.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('detects an inserted line', () => {
    const d = lineDiff('a\nc', 'a\nb\nc')!;
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('detects a removed and a replaced line', () => {
    const d = lineDiff('a\nb\nc', 'a\nx')!;
    expect(d.filter((l) => l.type === 'del').map((l) => l.text)).toEqual(['b', 'c']);
    expect(d.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['x']);
    expect(d[0]).toEqual({ type: 'same', text: 'a' });
  });

  it('round-trips: same+add lines reproduce the revised document', () => {
    const a = '# Title\n\nold intro\n\n## Testing\n- a\n- b\n';
    const b = '# Title\n\nnew intro\n\n## Testing\n- a\n- b\n- c\n';
    const d = lineDiff(a, b)!;
    const rebuilt = d.filter((l) => l.type !== 'del').map((l) => l.text).join('\n');
    expect(rebuilt).toBe(b);
    const original = d.filter((l) => l.type !== 'add').map((l) => l.text).join('\n');
    expect(original).toBe(a);
  });

  it('bails out (null) on pathologically large diffs', () => {
    const a = Array.from({ length: 1200 }, (_, i) => `left ${i}`).join('\n');
    const b = Array.from({ length: 1200 }, (_, i) => `right ${i}`).join('\n');
    expect(lineDiff(a, b)).toBeNull();
  });
});

describe('fencedBlock', () => {
  it('embeds code with a language inferred from the extension', () => {
    const block = fencedBlock('load.py', 'print("hi")\n');
    expect(block).toBe('### Example — load.py\n\n```python\nprint("hi")\n```\n');
  });

  it('grows the fence past backtick runs inside the snippet', () => {
    const block = fencedBlock('doc.md', 'use ```sql blocks```');
    expect(block).toContain('````markdown\n');
    expect(block.trimEnd().endsWith('````')).toBe(true);
  });

  it('falls back to a plain fence for unknown extensions', () => {
    expect(fencedBlock('script.xyz', 'x')).toContain('```\nx\n```');
  });
});
