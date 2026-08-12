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
      const css = getComputedStyle(document.documentElement);
      const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: "'DM Sans', sans-serif",
        // Labels must be native SVG <text>: mermaid's default HTML labels sit
        // in <foreignObject>, which the SVG sanitizer strips — leaving shapes
        // with no text at all.
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: true },
        sequence: { useMaxWidth: true },
        themeVariables: {
          primaryColor: v('--bg3', '#20262e'),
          primaryTextColor: v('--tx', '#e8ecf2'),
          primaryBorderColor: v('--line2', '#39404a'),
          lineColor: v('--tx3', '#6b7480'),
          secondaryColor: v('--bg2', '#161b22'),
          tertiaryColor: v('--bg', '#101318'),
          background: v('--bg2', '#161b22'),
          mainBkg: v('--bg3', '#20262e'),
          textColor: v('--tx2', '#9aa5b5'),
          clusterBkg: v('--bg2', '#161b22'),
          clusterBorder: v('--line', '#262d38'),
          edgeLabelBackground: v('--bg2', '#161b22'),
          nodeBorder: v('--acc', '#4f8ff7'),
          nodeTextColor: v('--tx', '#e8ecf2'),
          labelTextColor: v('--tx2', '#9aa5b5'),
          actorTextColor: v('--tx', '#e8ecf2'),
          signalTextColor: v('--tx2', '#9aa5b5'),
          fontSize: '13px',
        },
      });
      return mod.default;
    });
  }
  return mermaidReady;
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
