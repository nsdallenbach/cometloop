import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentTask, Ticket, TicketComment, TicketDev } from '../types';
import { STATUS_LABEL, initials, mono } from '../util';

const AGENT_STATE_LABEL: Record<AgentTask['state'], string> = {
  queued: 'QUEUED — WAITING FOR A RUNNER',
  claimed: 'CLAIMED',
  working: 'WORKING',
  done: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};

const PR_STATE_COLOR: Record<string, string> = { open: 'var(--warn)', merged: 'var(--ok)', closed: 'var(--tx3)' };

const DEPLOY_BADGE: Record<string, { label: string; color: string; pulse?: boolean }> = {
  pending: { label: '◌ DEPLOY QUEUED', color: 'var(--warn)', pulse: true },
  running: { label: '◌ DEPLOYING…', color: 'var(--acc)', pulse: true },
  success: { label: '✓ DEPLOYED', color: 'var(--ok)' },
  failed: { label: '✕ DEPLOY FAILED', color: 'var(--bad)' },
  none: { label: '— NO PIPELINE', color: 'var(--tx3)' },
};

const DEPLOY_NOTE: Record<string, string> = {
  pending: 'Waiting for the pipeline to pick up the merge — the ticket moves to Done when it succeeds.',
  running: 'Pipeline running — the ticket moves to Done when it succeeds.',
  success: 'Pipeline succeeded — the ticket moved to Done.',
  failed: 'Pipeline failed — the ticket stays in Review until a passing run.',
  none: 'No deploy pipeline detected — the ticket moved straight to Done.',
};

export function TicketDrawer({
  theme,
  ticket,
  team,
  lead,
  agentTask,
  onQueueAgent,
  onCancelAgent,
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
  agentTask: AgentTask | null;
  onQueueAgent: (instructions: string) => void;
  onCancelAgent: () => void;
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
  // Drag the drawer's left edge to resize; the width sticks across sessions.
  const [drawerW, setDrawerW] = useState(() => {
    const saved = Number(localStorage.getItem('eec-drawer-w'));
    return Number.isFinite(saved) && saved >= 380 ? Math.min(saved, 1200) : 620;
  });
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = drawerW;
    const clamp = (w: number) => Math.min(1200, Math.max(380, w));
    const move = (ev: MouseEvent) => setDrawerW(clamp(startW + (startX - ev.clientX)));
    const up = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem('eec-drawer-w', String(clamp(startW + (startX - ev.clientX))));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  const [queueOpen, setQueueOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const agentActive = agentTask !== null && ['queued', 'claimed', 'working'].includes(agentTask.state);
  const canQueue = lead && !agentActive && ['backlog', 'progress'].includes(ticket.status);
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

  const loadDev = useCallback(() => {
    void api
      .ticketDev(ticket.key)
      .then((data) => setDev({ key: ticket.key, data }))
      .catch(() => setDev({ key: ticket.key, data: null }));
  }, [ticket.key]);

  useEffect(loadDev, [loadDev]);

  // Stale results from a previously opened ticket render as "loading".
  const comments = loaded && loaded.key === ticket.key && !loaded.error ? loaded.list : null;
  const commentsError = loaded !== null && loaded.key === ticket.key && loaded.error;
  const devData = dev && dev.key === ticket.key ? dev.data : null;

  // Live dev activity: while a PR is open or its deploy pipeline is in flight,
  // poll so merges and pipeline progress show up without reopening the drawer.
  // ('failed' stays watched too — a re-run pipeline can still turn it green.)
  const watchDev =
    devData?.prs.some((p) => p.state === 'open' || ['pending', 'running', 'failed'].includes(p.deployState ?? '')) ?? false;
  useEffect(() => {
    if (!watchDev) return;
    const iv = setInterval(loadDev, 8000);
    return () => clearInterval(iv);
  }, [watchDev, loadDev]);

  const [mergeArm, setMergeArm] = useState<number | null>(null);
  const [merging, setMerging] = useState<number | null>(null);
  const mergePr = (number: number) => {
    setMergeArm(null);
    setMerging(number);
    api
      .mergePr(ticket.key, number)
      .then(() => {
        toast(`PR #${number} merged — watching the deploy pipeline`);
        loadDev();
      })
      .catch((e: Error) => toast(`Merge failed — ${e.message}`))
      .finally(() => setMerging(null));
  };

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
          width: `min(${drawerW}px, 94vw)`,
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
        <div
          onMouseDown={startResize}
          title="Drag to resize"
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize', zIndex: 1 }}
        />
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
          {(agentTask || canQueue) && (
            <>
              <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>AGENT WORK</div>
              <div style={{ border: `1px solid ${agentActive ? 'var(--agent)' : 'var(--line)'}`, borderRadius: 3, padding: '10px 12px', marginBottom: 18 }}>
                {agentTask && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ ...mono(500, 9), color: 'var(--agent)', border: '1px solid var(--agent)', borderRadius: 2, padding: '1px 5px', letterSpacing: '.06em' }}>
                        ◆ {AGENT_STATE_LABEL[agentTask.state]}
                      </span>
                      {agentTask.agent && <span style={{ ...mono(400, 10), color: 'var(--tx2)' }}>{agentTask.agent}</span>}
                      {agentActive && lead && (
                        <button
                          className="hv-bad"
                          onClick={onCancelAgent}
                          style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 9), cursor: 'pointer', letterSpacing: '.06em' }}
                        >
                          CANCEL
                        </button>
                      )}
                    </div>
                    {agentTask.instructions && (
                      <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>{agentTask.instructions}</div>
                    )}
                    {agentTask.flag && ['claimed', 'working'].includes(agentTask.state) && (
                      <div style={{ fontSize: 12, color: 'var(--warn)', fontWeight: 600, lineHeight: 1.5 }}>⚠ {agentTask.flag}</div>
                    )}
                    {agentTask.result && (agentTask.state === 'done' || agentTask.state === 'failed') && (
                      <div style={{ fontSize: 12, color: agentTask.state === 'done' ? 'var(--tx2)' : 'var(--bad)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                        {agentTask.result}
                      </div>
                    )}
                    {agentTask.resultUrl && (
                      <a href={agentTask.resultUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--acc)', wordBreak: 'break-all' }}>
                        {agentTask.resultUrl}
                      </a>
                    )}
                  </div>
                )}
                {canQueue && !queueOpen && (
                  <button
                    onClick={() => setQueueOpen(true)}
                    style={{
                      marginTop: agentTask ? 10 : 0,
                      border: '1px solid var(--agent)',
                      background: 'var(--agentsoft)',
                      color: 'var(--agent)',
                      borderRadius: 3,
                      padding: '6px 12px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    ◆ {agentTask ? 'Queue again for agent' : 'Queue for agent'}
                  </button>
                )}
                {canQueue && queueOpen && (
                  <div style={{ marginTop: agentTask ? 10 : 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <textarea
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      rows={3}
                      placeholder="Optional instructions for the agent — constraints, branch naming, what done looks like…"
                      style={{
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
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        onClick={() => {
                          onQueueAgent(instructions.trim());
                          setQueueOpen(false);
                          setInstructions('');
                        }}
                        style={{ border: 'none', background: 'var(--agent)', color: '#fff', borderRadius: 3, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Add to queue
                      </button>
                      <button
                        onClick={() => setQueueOpen(false)}
                        style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          {devData && (devData.prs.length > 0 || devData.commits.length > 0) && (
            <>
              <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>DEVELOPMENT</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
                {devData.prs.map((pr) => {
                  const dep = pr.deployState ? DEPLOY_BADGE[pr.deployState] : null;
                  return (
                  <div key={`pr${pr.number}`} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hv-agent"
                      onMouseLeave={() => setMergeArm((cur) => (cur === pr.number ? null : cur))}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--line)', borderRadius: dep ? '3px 3px 0 0' : 3, padding: '8px 11px', textDecoration: 'none', color: 'inherit' }}
                    >
                      <span style={{ ...mono(500, 9), color: PR_STATE_COLOR[pr.state], border: `1px solid ${PR_STATE_COLOR[pr.state]}`, borderRadius: 2, padding: '1px 5px', letterSpacing: '.06em' }}>
                        PR {pr.state.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--tx)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        #{pr.number} {pr.title}
                      </span>
                      {pr.branch && <span style={{ ...mono(400, 9), color: 'var(--tx3)', maxWidth: 110, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pr.branch}</span>}
                      {lead && pr.state === 'open' && (
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (merging !== null) return;
                            if (mergeArm === pr.number) mergePr(pr.number);
                            else setMergeArm(pr.number);
                          }}
                          title={mergeArm === pr.number ? 'Click again to merge' : `Merge PR #${pr.number}`}
                          style={{
                            flex: 'none',
                            border: `1px solid ${mergeArm === pr.number ? 'var(--warn)' : 'var(--ok)'}`,
                            background: 'none',
                            color: mergeArm === pr.number ? 'var(--warn)' : 'var(--ok)',
                            borderRadius: 2,
                            padding: '2px 8px',
                            ...mono(500, 9),
                            letterSpacing: '.06em',
                            cursor: merging !== null ? 'default' : 'pointer',
                            opacity: merging !== null && merging !== pr.number ? 0.5 : 1,
                          }}
                        >
                          {merging === pr.number ? 'MERGING…' : mergeArm === pr.number ? 'CONFIRM MERGE?' : 'MERGE'}
                        </button>
                      )}
                    </a>
                    {dep && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          border: '1px solid var(--line)',
                          borderTop: 'none',
                          borderRadius: '0 0 3px 3px',
                          padding: '6px 11px',
                          background: 'var(--bg)',
                        }}
                      >
                        <span
                          style={{
                            ...mono(500, 9),
                            color: dep.color,
                            border: `1px solid ${dep.color}`,
                            borderRadius: 2,
                            padding: '1px 5px',
                            letterSpacing: '.06em',
                            animation: dep.pulse ? 'eec-pulse 2.4s infinite' : 'none',
                          }}
                        >
                          {dep.label}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--tx3)', flex: 1, minWidth: 0 }}>{DEPLOY_NOTE[pr.deployState ?? '']}</span>
                        {pr.deployUrl && (
                          <a href={pr.deployUrl} target="_blank" rel="noreferrer" style={{ ...mono(400, 9), color: 'var(--acc)', flex: 'none' }}>
                            VIEW RUN ↗
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
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
