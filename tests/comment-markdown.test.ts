import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMENT_STYLE_EXAMPLE } from '../server/routes/comment-style';
import { splitMermaid } from '../client/src/lib/md-segments';

/**
 * DAT-204 AC4: prove the comment rendering path actually displays the markdown
 * the new prompt rules ask agents to write. `TicketDrawer` renders an ordinary
 * comment as `<Markdown text={c.body} />`, and `Markdown` splits mermaid
 * fences, runs `marked` with these exact options, then sanitizes with
 * DOMPurify.
 *
 * Covered here: the markdown → HTML half (the half that decides whether lists,
 * line breaks and bold appear at all) with the component's real options, and
 * the `.md` CSS that paints the result. DOMPurify is not exercised — it only
 * ever removes nodes, and every tag asserted below (`ul`, `ol`, `li`, `strong`,
 * `code`, `br`, `h2`, `p`) is in its default allow-list — and it needs a DOM
 * this node-environment suite does not have.
 */

/** The options `MdHtml` in client/src/components/Markdown.tsx passes to marked. */
const render = (md: string): string => marked.parse(md, { async: false, gfm: true, breaks: true }) as string;

const CSS = readFileSync(fileURLToPath(new URL('../client/src/index.css', import.meta.url)), 'utf8');

describe('agent comment markdown rendering', () => {
  it('renders bullet lists as real list markup', () => {
    const html = render('Changed three files:\n\n- `a.ts` — one\n- `b.ts` — two\n- `c.ts` — three');
    expect(html).toContain('<ul>');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('<code>a.ts</code>');
  });

  it('renders numbered lists as ordered lists', () => {
    const html = render('1. claim\n2. branch\n3. push');
    expect(html).toContain('<ol>');
    expect(html.match(/<li>/g)).toHaveLength(3);
  });

  it('turns a single newline into a line break, so notes do not collapse', () => {
    // `breaks: true` is what makes this true — without it the two lines join
    // into one paragraph and every agent note reads as a wall of text.
    expect(render('first point\nsecond point')).toContain('<br>');
  });

  it('keeps blank-line-separated points as separate paragraphs', () => {
    const html = render('Prompt work is done.\n\nWiring the render path next.');
    expect(html.match(/<p>/g)).toHaveLength(2);
  });

  it('renders bold and headings', () => {
    const html = render('## Result\n\n**Blocking** — none');
    expect(html).toMatch(/<h2[^>]*>Result<\/h2>/);
    expect(html).toContain('<strong>Blocking</strong>');
  });

  it('renders the prompt example the way the drawer will show it', () => {
    const segments = splitMermaid(COMMENT_STYLE_EXAMPLE);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('md');

    const html = render(segments[0].body);
    expect(html).toContain('<ul>');
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('<strong>Changed so far</strong>');
    expect(html).toContain('<code>server/routes/comment-style.ts</code>');
    expect(html.match(/<p>/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves a one-line note as a single plain paragraph', () => {
    const html = render('Flag cleared.');
    expect(html.trim()).toBe('<p>Flag cleared.</p>');
  });
});

describe('.md stylesheet paints what the renderer emits', () => {
  // The Tailwind preflight shipped by appkit-ui sets `list-style: none` on
  // ul/ol, which silently ate every bullet once already. Bullets are now load
  // bearing for agent comments, so pin the overrides.
  it('restores list markers past the preflight reset', () => {
    expect(CSS).toMatch(/\.md ul\s*\{[^}]*list-style:\s*disc/);
    expect(CSS).toMatch(/\.md ol\s*\{[^}]*list-style:\s*decimal/);
  });

  it('indents lists and spaces list items and paragraphs', () => {
    expect(CSS).toMatch(/\.md ul,\s*\n\.md ol\s*\{[^}]*padding-left/);
    expect(CSS).toMatch(/\.md li\s*\{[^}]*margin/);
    expect(CSS).toMatch(/\.md p\s*\{[^}]*margin/);
  });

  it('styles bold and inline code distinctly', () => {
    expect(CSS).toMatch(/\.md strong\s*\{/);
    expect(CSS).toMatch(/\.md code\s*\{/);
  });
});
