import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Ticket, TicketComment, TicketDev } from '../types';
import { STATUS_LABEL, initials, mono } from '../util';

const PR_STATE_COLOR: Record<string, string> = { open: 'var(--warn)', merged: 'var(--ok)', closed: 'var(--tx3)' };

export function TicketDrawer({
  theme,
  ticket,
  team,
  lead,
  onAssign,
  toast,
  onClose,
  onAccept,
  onDismiss,
  onDelete,
  goSources,
}: {
  theme: 'dark' | 'light';
  ticket: Ticket;
  team: string[];
  lead: boolean;
  onAssign: (assignee: string) => void;
  toast: (msg: string) => void;
  onClose: () => void;
  onAccept: () => void;
  onDismiss: () => void;
  onDelete: () => void;
  goSources: () => void;
}) {
  const proposed = ticket.status === 'proposed';
  const [delConfirm, setDelConfirm] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; list: TicketComment[] | null; error: boolean } | null>(null);
  const [dev, setDev] = useState<{ key: string; data: TicketDev | null } | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const loadComments = useCallback(() => {
    void api
      .comments(ticket.key)
      .then((list) => setLoaded({ key: ticket.key, list, error: false }))
      .catch(() => setLoaded({ key: ticket.key, list: null, error: true }));
  }, [ticket.key]);

  useEffect(loadComments, [loadComments]);

  useEffect(() => {
    void api
      .ticketDev(ticket.key)
      .then((data) => setDev({ key: ticket.key, data }))
      .catch(() => setDev({ key: ticket.key, data: null }));
  }, [ticket.key]);

  // Stale results from a previously opened ticket render as "loading".
  const comments = loaded && loaded.key === ticket.key && !loaded.error ? loaded.list : null;
  const commentsError = loaded !== null && loaded.key === ticket.key && loaded.error;
  const devData = dev && dev.key === ticket.key ? dev.data : null;

  const postComment = () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    api
      .addComment(ticket.key, body)
      .then((c) => {
        setLoaded((cur) =>
          cur && cur.key === ticket.key && cur.list
            ? { key: cur.key, list: [...cur.list, c], error: false }
            : { key: ticket.key, list: [c], error: false },
        );
        setDraft('');
      })
      .catch(() => toast('Comment failed to post'))
      .finally(() => setPosting(false));
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return isNaN(+d)
      ? ''
      : d.toLocaleString('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).toUpperCase();
  };

  const assigneeOptions = [...new Set(['—', ...team, ticket.assignee])];

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 40 }} />
      <div
        data-theme={theme}
        className="eec"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 440,
          background: 'var(--bg2)',
          borderLeft: '1px solid var(--line)',
          zIndex: 41,
          display: 'flex',
          flexDirection: 'column',
          animation: 'eec-slideIn .18s ease',
          color: 'var(--tx)',
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ ...mono(500, 11), color: 'var(--tx3)' }}>{ticket.key}</span>
          {ticket.agent && !proposed && (
            <span style={{ ...mono(500, 9), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '2px 5px' }}>◆ AGENT-CREATED</span>
          )}
          {proposed && (
            <span style={{ ...mono(500, 9), border: '1px dashed var(--agent)', color: 'var(--agent)', borderRadius: 2, padding: '2px 5px' }}>
              PROPOSED — NOT ON BOARD
            </span>
          )}
          <button
            className="hv-tx"
            onClick={onClose}
            style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 16, cursor: 'pointer', padding: '2px 6px' }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          <h2 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>{ticket.title}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>STATUS</div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{STATUS_LABEL[ticket.status] ?? ticket.status}</div>
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>ASSIGNEE</div>
              <select
                value={ticket.assignee}
                onChange={(e) => onAssign(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--bg)',
                  border: '1px solid var(--line2)',
                  color: 'var(--tx)',
                  borderRadius: 3,
                  padding: '3px 6px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {assigneeOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>ESTIMATE</div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{ticket.est}</div>
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>WORKSTREAM</div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{ticket.workstream}</div>
            </div>
          </div>
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>DESCRIPTION</div>
          <p style={{ margin: '0 0 16px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--tx2)' }}>{ticket.description}</p>
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>ACCEPTANCE CRITERIA</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 16 }}>
            {ticket.ac.map((a, i) => (
              // eslint-disable-next-line react/no-array-index-key -- AC lines have no stable id and can repeat verbatim
              <div key={`${i}-${a}`} style={{ display: 'flex', gap: 8, fontSize: 12.5, lineHeight: 1.45, color: 'var(--tx2)' }}>
                <span style={{ color: 'var(--tx3)', ...mono(400, 11) }}>—</span>
                {a}
              </div>
            ))}
          </div>
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>PROVENANCE</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
            {ticket.sources.map((sr) => (
              <div
                key={sr.type + sr.label}
                className="hv-agent"
                onClick={goSources}
                title="Open the Sources tab"
                style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px', cursor: 'pointer' }}
              >
                <span style={{ ...mono(500, 9), color: 'var(--agent)', border: '1px solid var(--agent)', borderRadius: 2, padding: '1px 5px' }}>{sr.type}</span>
                <span style={{ fontSize: 12, color: 'var(--tx2)', flex: 1 }}>{sr.label}</span>
              </div>
            ))}
          </div>
          {devData && (devData.prs.length > 0 || devData.commits.length > 0) && (
            <>
              <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>DEVELOPMENT</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
                {devData.prs.map((pr) => (
                  <a
                    key={`pr${pr.number}`}
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hv-agent"
                    style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px', textDecoration: 'none', color: 'inherit' }}
                  >
                    <span style={{ ...mono(500, 9), color: PR_STATE_COLOR[pr.state], border: `1px solid ${PR_STATE_COLOR[pr.state]}`, borderRadius: 2, padding: '1px 5px', letterSpacing: '.06em' }}>
                      PR {pr.state.toUpperCase()}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--tx)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      #{pr.number} {pr.title}
                    </span>
                    {pr.branch && <span style={{ ...mono(400, 9), color: 'var(--tx3)', maxWidth: 110, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pr.branch}</span>}
                  </a>
                ))}
                {devData.commits.map((c) => (
                  <a
                    key={c.sha}
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hv-agent"
                    style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--line)', borderRadius: 3, padding: '7px 11px', textDecoration: 'none', color: 'inherit' }}
                  >
                    <span style={{ ...mono(400, 9), color: 'var(--tx3)' }}>{c.sha.slice(0, 7)}</span>
                    <span style={{ fontSize: 12, color: 'var(--tx2)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.message.split('\n')[0]}
                    </span>
                  </a>
                ))}
              </div>
            </>
          )}
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>
            COMMENTS{comments && comments.length > 0 ? ` · ${comments.length}` : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
            {comments === null && !commentsError && <div style={{ ...mono(400, 10), color: 'var(--tx3)' }}>LOADING…</div>}
            {commentsError && (
              <div style={{ fontSize: 12, color: 'var(--tx3)' }}>
                Couldn’t load comments.{' '}
                <button onClick={loadComments} style={{ border: 'none', background: 'none', color: 'var(--acc)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                  Retry
                </button>
              </div>
            )}
            {comments && comments.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No comments yet — start the thread below.</div>
            )}
            {(comments ?? []).map((c) => (
              <div key={c.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                <span
                  style={{
                    flex: 'none',
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: 'var(--bg3)',
                    border: '1px solid var(--line2)',
                    display: 'grid',
                    placeItems: 'center',
                    ...mono(500, 9),
                    color: 'var(--tx2)',
                  }}
                  title={c.author}
                >
                  {initials(c.author.split('@')[0].replace(/[._-]/g, ' '))}
                </span>
                <div style={{ flex: 1, minWidth: 0, border: '1px solid var(--line)', borderRadius: 3, padding: '7px 10px', background: 'var(--bg)' }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600 }}>{c.author}</span>
                    <span style={{ ...mono(400, 9), color: 'var(--tx3)', marginLeft: 'auto' }}>{fmtTime(c.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--tx2)', whiteSpace: 'pre-wrap' }}>{c.body}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postComment();
              }}
              rows={2}
              placeholder="Add a comment… (⌘↵ to post)"
              style={{
                flex: 1,
                boxSizing: 'border-box',
                background: 'var(--bg)',
                border: '1px solid var(--line2)',
                borderRadius: 3,
                color: 'var(--tx)',
                padding: '8px 10px',
                fontSize: 12.5,
                lineHeight: 1.5,
                resize: 'vertical',
              }}
            />
            <button
              onClick={postComment}
              disabled={!draft.trim() || posting}
              style={{
                background: 'var(--acc)',
                color: '#fff',
                border: 'none',
                borderRadius: 3,
                padding: '8px 14px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                opacity: !draft.trim() || posting ? 0.45 : 1,
              }}
            >
              {posting ? '…' : 'Comment'}
            </button>
          </div>
          {lead && (
            <div style={{ marginTop: 22, paddingTop: 12, borderTop: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
              {!delConfirm && (
                <button
                  onClick={() => setDelConfirm(true)}
                  style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 10), letterSpacing: '.06em', cursor: 'pointer', padding: 0 }}
                >
                  DELETE TICKET
                </button>
              )}
              {delConfirm && (
                <>
                  <span style={{ ...mono(400, 10), color: 'var(--bad)' }}>Delete {ticket.key} and its comments permanently?</span>
                  <button
                    onClick={onDelete}
                    style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setDelConfirm(false)}
                    style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '3px 10px', fontSize: 11, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        {proposed && lead && (
          <div style={{ flex: 'none', display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid var(--line)', background: 'var(--agentsoft)' }}>
            <button
              onClick={onAccept}
              style={{ flex: 1, border: 'none', background: 'var(--ok)', color: '#fff', borderRadius: 3, padding: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
            >
              Accept onto board
            </button>
            <button
              onClick={onDismiss}
              style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '8px 16px', fontSize: 12.5, cursor: 'pointer' }}
            >
              Dismiss
            </button>
          </div>
        )}
        {proposed && !lead && (
          <div style={{ flex: 'none', padding: '12px 18px', borderTop: '1px solid var(--line)', background: 'var(--agentsoft)', ...mono(400, 10), color: 'var(--agent)', letterSpacing: '.06em' }}>
            ◆ AWAITING ENGAGEMENT LEAD REVIEW
          </div>
        )}
      </div>
    </>
  );
}
