import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { splitMermaid } from '../lib/md-segments';
import { mono } from '../util';

/**
 * Compact sanitized markdown block for ticket descriptions and comments.
 * Styling lives under `.md` in index.css so it tracks the app theme.
 *
 * ```mermaid fences render as diagrams (DAT-192): the mermaid library is
 * lazy-loaded only when a diagram is actually on screen (it is far too heavy
 * for the main bundle), themed from the app's CSS tokens, and its SVG output
 * is sanitized. A diagram that fails to parse falls back to the fenced code
 * with a note — bad model output must never eat the rest of the plan.
 */

let mermaidReady: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (mermaidReady === null) {
    mermaidReady = import('mermaid').then((mod) => {
      // No themeVariables: the app's tokens live on [data-theme] containers,
      // not :root, so they can't be read once at init (and baking literals
      // breaks light mode). All paint comes from the `.md-diagram` CSS-token
      // overrides in index.css, which follow the active theme live.
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily: "'DM Sans', sans-serif",
        // Labels must be native SVG <text>: mermaid's default HTML labels sit
        // in <foreignObject>, which the SVG sanitizer strips — leaving shapes
        // with no text at all.
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: true },
        sequence: { useMaxWidth: true },
        themeVariables: { fontSize: '13px' },
      });
      return mod.default;
    });
  }
  return mermaidReady;
}

/**
 * Warm the mermaid chunks before any diagram is on screen: the first render
 * otherwise pays several sequential lazy-chunk downloads through the
 * workspace proxy, which reads as "diagrams take forever". Called from App
 * shortly after mount.
 */
export function prefetchMermaid(): void {
  void loadMermaid().catch(() => {});
}

let renderSeq = 0;

/** Keyed by diagram code from the parent, so a changed diagram remounts and re-renders cleanly. */
function MermaidBlock({ code }: { code: string }) {
  const [state, setState] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    loadMermaid()
      .then((mermaid) => mermaid.render(`md-mermaid-${++renderSeq}`, code))
      .then(({ svg }) => {
        if (alive) setState({ svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) });
      })
      .catch((err: unknown) => {
        if (alive) setState({ error: err instanceof Error ? err.message.split('\n')[0] : 'diagram failed to render' });
      });
    return () => {
      alive = false;
    };
  }, [code]);

  if (state === null) {
    return <div className="md-diagram md-diagram-note">rendering diagram…</div>;
  }
  if ('error' in state) {
    return (
      <div>
        <div className="md-diagram-note" title={state.error} style={{ marginBottom: 4 }}>
          ⚠ diagram didn’t render — showing its source
        </div>
        <pre>
          <code style={{ ...mono(400, 11) }}>{code}</code>
        </pre>
      </div>
    );
  }
  return <div className="md-diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}

function MdHtml({ body }: { body: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(body, { async: false, gfm: true, breaks: true });
    return DOMPurify.sanitize(typeof raw === 'string' ? raw : '');
  }, [body]);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Markdown({ text }: { text: string }) {
  const segments = useMemo(() => splitMermaid(text), [text]);
  return (
    <div className="md">
      {segments.map((s, i) =>
        s.kind === 'mermaid' ? (
          // eslint-disable-next-line react/no-array-index-key -- position + a code prefix is the only stable identity segments have
          <MermaidBlock key={`mm-${i}-${s.body.slice(0, 32)}`} code={s.body} />
        ) : (
          // eslint-disable-next-line react/no-array-index-key -- same
          <MdHtml key={`md-${i}`} body={s.body} />
        ),
      )}
    </div>
  );
}
