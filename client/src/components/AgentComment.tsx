/* eslint-disable react-refresh/only-export-components -- helpers ship with the comment components they serve */
/* eslint-disable react/no-array-index-key -- positional text tokens, never reordered */
import { Fragment, type ReactNode } from 'react';
import { mono } from '../util';

/** Message types carried on coordination comments, colored by intent. */
const TYPE_STYLE: Record<string, { label: string; color: string }> = {
  status_update: { label: 'STATUS', color: 'var(--tx3)' },
  request_for_info: { label: 'ASKS', color: 'var(--link)' },
  response: { label: 'REPLIES', color: 'var(--ok)' },
  conflict_warning: { label: 'CONFLICT', color: 'var(--warn)' },
  handoff: { label: 'HANDOFF', color: 'var(--agent)' },
  poke: { label: 'POKE', color: 'var(--acc)' },
};

const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9}-\d{1,5})\b/;
const MENTION_RE = /(@[A-Za-z0-9._-]+)/;
const URL_RE = /(https?:\/\/[^\s)]+)/;
// One splitter that keeps ticket keys, @mentions and URLs as their own tokens.
const TOKEN_RE = new RegExp(`${URL_RE.source}|${TICKET_RE.source}|${MENTION_RE.source}`, 'g');

/** Render prose with ticket keys, @mentions and URLs styled inline. */
export function RichText({ text, onOpenTicket }: { text: string; onOpenTicket?: (key: string) => void }): ReactNode {
  const parts = text.split(TOKEN_RE).filter((p) => p !== undefined && p !== '');
  return (
    <>
      {parts.map((part, i) => {
        if (URL_RE.test(part) && part.startsWith('http')) {
          return (
            <a key={i} href={part} target="_blank" rel="noreferrer" style={{ color: 'var(--link)', wordBreak: 'break-all' }}>
              {part}
            </a>
          );
        }
        if (TICKET_RE.test(part) && /^[A-Z]/.test(part)) {
          return (
            <span
              key={i}
              onClick={onOpenTicket ? () => onOpenTicket(part) : undefined}
              title={onOpenTicket ? `Open ${part}` : part}
              style={{
                ...mono(600, 10.5),
                color: 'var(--acc)',
                background: 'var(--accsoft)',
                borderRadius: 3,
                padding: '0 4px',
                cursor: onOpenTicket ? 'pointer' : 'default',
                whiteSpace: 'nowrap',
              }}
            >
              {part}
            </span>
          );
        }
        if (part.startsWith('@')) {
          return (
            <span key={i} style={{ ...mono(600, 10.5), color: 'var(--agent)', background: 'var(--agentsoft)', borderRadius: 3, padding: '0 4px', whiteSpace: 'nowrap' }}>
              {part}
            </span>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}

interface CoordMeta {
  type: string;
  to: string | null;
  branch: string | null;
  sla: string | null;
}

/** Parse a coordination-mirror comment body; null for ordinary comments. */
export function parseCoordComment(body: string): { meta: CoordMeta; text: string } | null {
  if (!body.startsWith('::coord::')) return null;
  const nl = body.indexOf('\n');
  try {
    const meta = JSON.parse(body.slice('::coord::'.length, nl === -1 ? undefined : nl)) as CoordMeta;
    // body is `::coord::{json}\n<header line>\n<message>` — drop the human header.
    const rest = nl === -1 ? '' : body.slice(nl + 1);
    const nl2 = rest.indexOf('\n');
    return { meta, text: (nl2 === -1 ? rest : rest.slice(nl2 + 1)).trim() };
  } catch {
    return null;
  }
}

/** A coordination message rendered as an agent-to-agent comment card. */
export function CoordCommentBody({
  meta,
  text,
  onOpenTicket,
}: {
  meta: CoordMeta;
  text: string;
  onOpenTicket?: (key: string) => void;
}) {
  const ts = TYPE_STYLE[meta.type] ?? { label: meta.type.replace(/_/g, ' ').toUpperCase(), color: 'var(--tx3)' };
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ ...mono(600, 8.5), color: '#fff', background: ts.color, borderRadius: 3, padding: '1px 5px', letterSpacing: '.06em' }}>
          {ts.label}
        </span>
        {meta.to ? (
          <span style={{ ...mono(600, 9.5), color: 'var(--agent)', background: 'var(--agentsoft)', borderRadius: 3, padding: '1px 5px' }}>
            → @{meta.to}
          </span>
        ) : (
          <span style={{ ...mono(500, 9), color: 'var(--tx3)', border: '1px solid var(--line2)', borderRadius: 3, padding: '0 5px', letterSpacing: '.06em' }}>
            BROADCAST
          </span>
        )}
        {meta.sla && (
          <span style={{ ...mono(500, 9), color: 'var(--warn)', border: '1px solid var(--warn)', borderRadius: 3, padding: '0 5px' }}>
            SLA {meta.sla}
          </span>
        )}
        {meta.branch && (
          <span title={meta.branch} style={{ ...mono(400, 9), color: 'var(--tx3)', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            ⎇ {meta.branch}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--tx2)', whiteSpace: 'pre-wrap' }}>
        <RichText text={text} onOpenTicket={onOpenTicket} />
      </div>
    </div>
  );
}
