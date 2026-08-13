import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api';
import { canonicalTag, suggestedTags } from '../lib/ticket-tags';
import type {
  AgentTask,
  Ticket,
  TicketAttachment,
  TicketComment,
  TicketDev,
  TicketEscalation,
  TicketLinkType,
  TicketLinks,
  ToolCall,
} from '../types';
import { STATUS_LABEL, fmtDuration, initials, mono } from '../util';
import { runnerBrand } from './RunnerLogo';
import { Markdown } from './Markdown';
import { CoordCommentBody, parseCoordComment } from './AgentComment';

const AGENT_STATE_LABEL: Record<AgentTask['state'], string> = {
  queued: 'QUEUED — WAITING FOR A RUNNER',
  claimed: 'CLAIMED',
  working: 'WORKING',
  done: 'COMPLETED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
};

const PR_STATE_COLOR: Record<string, string> = { open: 'var(--warn)', merged: 'var(--ok)', closed: 'var(--tx3)' };

const fmtSize = (bytes: number) =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

const LINK_BADGE: Record<TicketLinkType, { label: string; color: string }> = {
  blocked_by: { label: '⧗ WAITING ON', color: 'var(--bad)' },
  blocks: { label: 'BLOCKS', color: 'var(--warn)' },
  relates: { label: 'RELATES', color: 'var(--acc)' },
  mention: { label: 'MENTIONED', color: 'var(--tx3)' },
};

/** How the user phrases the link when creating it from this ticket's side. */
const LINK_TYPE_OPTIONS: { value: 'blocked_by' | 'blocks' | 'relates'; label: string }[] = [
  { value: 'blocked_by', label: 'is blocked by' },
  { value: 'blocks', label: 'blocks' },
  { value: 'relates', label: 'relates to' },
];

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
  allTickets,
  onOpenTicket,
  onQueueAgent,
  onCancelAgent,
  onAssign,
  onTags,
  toast,
  refreshDetail,
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
  allTickets: Ticket[];
  onOpenTicket: (key: string) => void;
  onQueueAgent: (instructions: string) => void;
  onCancelAgent: () => void;
  onAssign: (assignee: string) => void;
  onTags: (tags: string[]) => void;
  toast: (msg: string) => void;
  refreshDetail: () => void;
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
  const [refining, setRefining] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; list: TicketComment[] | null; error: boolean } | null>(null);
  const [dev, setDev] = useState<{ key: string; data: TicketDev | null } | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  // Waiting on the planning agent: a comment on a never-picked-up ticket makes
  // the server rework the plan and reply as "Planning Agent". Track the post so
  // the thread can show a typing indicator until the reply lands (or times out).
  const [planning, setPlanning] = useState<{ key: string; afterId: number; at: number } | null>(null);
  // Client mirror of the server's eligibility check (status + never claimed).
  const planningEligible =
    ['backlog', 'progress', 'proposed'].includes(ticket.status) &&
    (agentTask === null || ['queued', 'cancelled'].includes(agentTask.state));
  const [tagDraft, setTagDraft] = useState('');

  // One path for both ways of adding a tag — typed free text and the standard
  // feature/bug chips (DAT-210) — so the dedupe and limit rules can't diverge.
  const addTag = (raw: string) => {
    const tag = canonicalTag(raw);
    if (!tag) return;
    if (ticket.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    if (tag.length > 40) {
      toast('Tags are limited to 40 characters');
      return;
    }
    if (ticket.tags.length >= 20) {
      toast('Tickets are limited to 20 tags');
      return;
    }
    onTags([...ticket.tags, tag]);
  };

  const commitTagDraft = () => {
    if (!tagDraft.trim()) return;
    const draft = tagDraft;
    setTagDraft('');
    addTag(draft);
  };

  // Standard tags this ticket doesn't carry yet — the picker's suggestions.
  const tagOptions = suggestedTags(ticket.tags);

  // Branch edits are keyed to the ticket so a draft never bleeds into another
  // ticket, and board polls don't clobber text mid-edit.
  const [branchEdit, setBranchEdit] = useState<{ key: string; value: string } | null>(null);
  const branchValue = branchEdit && branchEdit.key === ticket.key ? branchEdit.value : (ticket.branch ?? '');
  const saveBranch = () => {
    const next = branchValue.trim();
    if (next === (ticket.branch ?? '')) return;
    api
      .patchTicket(ticket.key, { branch: next })
      .then(() => {
        toast(next ? `${ticket.key} branch set to ${next}` : `${ticket.key} branch cleared`);
        refreshDetail();
      })
      .catch((e: Error) => toast(`Branch update failed — ${e.message}`));
  };

  // Estimate edits (DAT-195): same keying rule as branch edits. Both time
  // estimates are mandatory — clearing or a non-positive value is blocked
  // with an inline error instead of a save.
  const [estEdit, setEstEdit] = useState<{ key: string; field: 'estHours' | 'humanEstHours'; value: string } | null>(null);
  const [estError, setEstError] = useState<{ key: string; field: 'estHours' | 'humanEstHours'; msg: string } | null>(null);
  const estEditValue = (field: 'estHours' | 'humanEstHours'): string | null =>
    estEdit && estEdit.key === ticket.key && estEdit.field === field ? estEdit.value : null;
  const estFieldError = (field: 'estHours' | 'humanEstHours'): string | null =>
    estError && estError.key === ticket.key && estError.field === field ? estError.msg : null;
  const saveEstimate = (field: 'estHours' | 'humanEstHours') => {
    const raw = estEditValue(field);
    if (raw === null) return;
    const max = field === 'estHours' ? 400 : 999;
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0 || n > max) {
      setEstError({ key: ticket.key, field, msg: `Required — enter hours between 0 and ${max}` });
      return;
    }
    setEstError(null);
    setEstEdit(null);
    const rounded = Math.round(n * 10) / 10;
    if (rounded === (field === 'estHours' ? ticket.estHours : ticket.humanEstHours)) return;
    api
      .patchTicket(ticket.key, field === 'estHours' ? { estHours: rounded } : { humanEstHours: rounded })
      .then(() => {
        toast(`${ticket.key} ${field === 'estHours' ? 'agent' : 'human dev'} estimate set to ${rounded}h`);
        refreshDetail();
      })
      .catch((e: Error) => toast(`Estimate update failed — ${e.message}`));
  };

  // Description edits follow the same keying rule as branch edits: the draft
  // belongs to one ticket and survives board polls until saved or cancelled.
  const [descEdit, setDescEdit] = useState<{ key: string; value: string } | null>(null);
  const [savingDesc, setSavingDesc] = useState(false);
  const descValue = descEdit !== null && descEdit.key === ticket.key ? descEdit.value : null;
  const saveDescription = () => {
    if (descValue === null || savingDesc || !descValue.trim()) return;
    if (descValue === ticket.description) {
      setDescEdit(null);
      return;
    }
    setSavingDesc(true);
    api
      .patchTicket(ticket.key, { description: descValue })
      .then(() => {
        setDescEdit(null);
        toast(`${ticket.key} description updated`);
        refreshDetail();
      })
      .catch((e: Error) => toast(`Save failed — ${e.message}`))
      .finally(() => setSavingDesc(false));
  };

  const loadComments = useCallback(() => {
    void api
      .comments(ticket.key)
      .then((list) =>
        setLoaded((cur) => {
          // A poll that started before a just-posted comment resolved would
          // otherwise briefly erase it — keep locally known comments on top.
          if (cur && cur.key === ticket.key && cur.list) {
            const seen = new Set(list.map((c) => c.id));
            const extra = cur.list.filter((c) => !seen.has(c.id));
            return { key: ticket.key, list: [...list, ...extra], error: false };
          }
          return { key: ticket.key, list, error: false };
        }),
      )
      .catch(() => setLoaded((cur) => (cur && cur.key === ticket.key && cur.list ? cur : { key: ticket.key, list: null, error: true })));
  }, [ticket.key]);

  useEffect(loadComments, [loadComments]);

  const [attach, setAttach] = useState<{ key: string; list: TicketAttachment[] | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [attachArm, setAttachArm] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadAttachments = useCallback(() => {
    void api
      .attachments(ticket.key)
      .then((list) => setAttach({ key: ticket.key, list }))
      .catch(() => setAttach({ key: ticket.key, list: null }));
  }, [ticket.key]);

  useEffect(loadAttachments, [loadAttachments]);

  const uploadAttachment = (file: File) => {
    setUploading(true);
    api
      .uploadAttachment(ticket.key, file)
      .then(() => {
        toast(`Attached ${file.name}`);
        loadAttachments();
      })
      .catch((e: Error) => toast(`Attach failed — ${e.message}`))
      .finally(() => setUploading(false));
  };

  const removeAttachment = (a: TicketAttachment) => {
    setAttachArm(null);
    api
      .deleteAttachment(ticket.key, a.id)
      .then(() => {
        toast(`Removed ${a.filename}`);
        loadAttachments();
      })
      .catch((e: Error) => toast(`Delete failed — ${e.message}`));
  };

  const loadDev = useCallback(() => {
    void api
      .ticketDev(ticket.key)
      .then((data) => setDev({ key: ticket.key, data }))
      .catch(() => setDev({ key: ticket.key, data: null }));
  }, [ticket.key]);

  useEffect(loadDev, [loadDev]);

  // ---- review SLA (DAT-201) ----
  const [escalation, setEscalation] = useState<{ key: string; data: TicketEscalation | null } | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const loadEscalation = useCallback(() => {
    void api
      .ticketEscalation(ticket.key)
      .then((data) => setEscalation({ key: ticket.key, data }))
      .catch(() => setEscalation({ key: ticket.key, data: null }));
  }, [ticket.key]);

  useEffect(loadEscalation, [loadEscalation]);

  const esc = escalation && escalation.key === ticket.key ? escalation.data : null;

  const dismissEscalation = () => {
    if (dismissing) return;
    setDismissing(true);
    api
      .dismissEscalation(ticket.key)
      .then(() => {
        toast(`Review escalation dismissed — 24h and 48h timers reset for ${ticket.key}`);
        loadEscalation();
        refreshDetail(); // clears the flag chip on the board card
      })
      .catch((e: Error) => toast(`Dismiss failed — ${e.message}`))
      .finally(() => setDismissing(false));
  };

  // ---- linked tickets & branches ----
  const [linked, setLinked] = useState<{ key: string; data: TicketLinks | null } | null>(null);
  const [linkType, setLinkType] = useState<'blocked_by' | 'blocks' | 'relates'>('blocked_by');
  const [linkTarget, setLinkTarget] = useState('');
  const [linking, setLinking] = useState(false);

  const loadLinks = useCallback(() => {
    void api
      .ticketLinks(ticket.key)
      .then((data) => setLinked({ key: ticket.key, data }))
      .catch(() => setLinked({ key: ticket.key, data: null }));
  }, [ticket.key]);

  useEffect(loadLinks, [loadLinks]);

  const linksData = linked && linked.key === ticket.key ? linked.data : null;
  const linkedKeys = new Set((linksData?.links ?? []).filter((l) => l.type !== 'mention').map((l) => l.key));
  const linkableTickets = allTickets.filter(
    (t) => t.key !== ticket.key && !linkedKeys.has(t.key) && !['dismissed', 'proposed'].includes(t.status),
  );

  const addLink = () => {
    if (!linkTarget || linking) return;
    setLinking(true);
    api
      .addTicketLink(ticket.key, linkTarget, linkType)
      .then(() => {
        setLinkTarget('');
        loadLinks();
        refreshDetail(); // board cards show dependency chips
      })
      .catch((e: Error) => toast(`Link failed — ${e.message}`))
      .finally(() => setLinking(false));
  };

  const removeLink = (id: number) => {
    api
      .removeTicketLink(ticket.key, id)
      .then(() => {
        loadLinks();
        refreshDetail();
      })
      .catch((e: Error) => toast(`Unlink failed — ${e.message}`));
  };

  // Tool-call feed streamed from the runner: polled live while the agent works,
  // loaded once for finished runs so the trace stays reviewable. Polls are
  // incremental (`after` = last seen id) so long runs don't re-ship history.
  const agentRunning = agentTask !== null && ['claimed', 'working'].includes(agentTask.state);
  const [toolFeed, setToolFeed] = useState<{ key: string; taskId: number | null; calls: ToolCall[] } | null>(null);
  const toolCursor = useRef({ key: '', last: 0 });
  const feedBox = useRef<HTMLDivElement | null>(null);

  const loadToolCalls = useCallback(() => {
    const after = toolCursor.current.key === ticket.key ? toolCursor.current.last : 0;
    void api
      .toolCalls(ticket.key, after || undefined)
      .then((d) => {
        setToolFeed((cur) => {
          // Ids are globally monotonic, so appending is safe even when a newer
          // run takes over — its rows always sort after the previous run's.
          const grow = after > 0 && cur !== null && cur.key === ticket.key && cur.taskId === d.taskId;
          const calls = grow ? [...cur.calls, ...d.calls] : d.calls;
          if (calls.length > 0) toolCursor.current = { key: ticket.key, last: calls[calls.length - 1].id };
          else if (after === 0) toolCursor.current = { key: ticket.key, last: 0 };
          return { key: ticket.key, taskId: d.taskId, calls };
        });
      })
      .catch(() => {});
  }, [ticket.key]);

  useEffect(() => {
    if (agentTask === null) return;
    loadToolCalls();
    if (!agentRunning) return;
    const iv = setInterval(loadToolCalls, 4000);
    return () => clearInterval(iv);
  }, [agentTask, agentRunning, loadToolCalls]);

  // The feed shows only the newest calls; keep it pinned to the bottom.
  const toolCalls = toolFeed !== null && toolFeed.key === ticket.key ? toolFeed.calls.slice(-500) : [];
  useEffect(() => {
    if (feedBox.current) feedBox.current.scrollTop = feedBox.current.scrollHeight;
  }, [toolCalls.length]);

  // Stale results from a previously opened ticket render as "loading".
  const attachments = attach && attach.key === ticket.key ? attach.list : null;
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

  // The indicator lives while the post's reply is still outstanding on the
  // same ticket; the expiry timer below covers the failure path (the server
  // logs rework failures and moves on without replying).
  const planningReplied =
    planning !== null && (loaded?.list ?? []).some((c) => c.id > planning.afterId && c.author === 'Planning Agent');
  const planningActive = planning !== null && planning.key === ticket.key && !planningReplied;

  useEffect(() => {
    if (!planningActive || planning === null) return;
    const timer = setTimeout(() => setPlanning(null), Math.max(0, planning.at + 45_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [planningActive, planning]);

  // Agent replies land as comments: poll while the drawer is open — fast while
  // an agent is actively on the ticket or a planning reply is due, relaxed
  // otherwise — so responses appear without reopening the drawer.
  useEffect(() => {
    const iv = setInterval(loadComments, agentActive || planningActive ? 5000 : 15000);
    return () => clearInterval(iv);
  }, [agentActive, planningActive, loadComments]);

  // The planning rework replaces the title/description/AC that sit above the
  // comment thread, which destroys the browser's scroll anchor and yanks the
  // drawer to the top. When the user is in the lower half (at the thread),
  // re-anchor to bottom-distance across the content swap instead.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodyScroll = useRef({ bottomDist: 0, nearBottom: false });
  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    bodyScroll.current = {
      bottomDist: el.scrollHeight - el.scrollTop,
      nearBottom: el.scrollTop + el.clientHeight > el.scrollHeight * 0.55,
    };
  };
  const planContent = `${ticket.key} ${ticket.title} ${ticket.description} ${ticket.ac.join('|')}`;
  const prevPlanContent = useRef(planContent);
  useLayoutEffect(() => {
    if (prevPlanContent.current === planContent) return;
    const keyChanged = !prevPlanContent.current.startsWith(`${ticket.key} `);
    prevPlanContent.current = planContent;
    if (keyChanged) return; // switching tickets is a real navigation, not a rework
    const el = bodyRef.current;
    if (el && bodyScroll.current.nearBottom) el.scrollTop = el.scrollHeight - bodyScroll.current.bottomDist;
  }, [planContent, ticket.key]);

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
        // On un-picked-up tickets the planning agent may rework the plan and
        // reply — show the typing indicator and poll a few times so both land
        // without reopening the drawer.
        if (planningEligible) setPlanning({ key: ticket.key, afterId: c.id, at: Date.now() });
        [4000, 9000, 16000].forEach((ms) =>
          setTimeout(() => {
            loadComments();
            refreshDetail();
          }, ms),
        );
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

  // Signed % over/under estimate, from the rounded value so ±0.4% shows as neutral 0%, not a colored +0%.
  const estDiffPct =
    ticket.actualHours != null && ticket.estHours != null && ticket.estHours > 0
      ? Math.round(((ticket.actualHours - ticket.estHours) / ticket.estHours) * 100)
      : null;

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
        <div ref={bodyRef} onScroll={onBodyScroll} style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
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
            {/* Deploy gate (DAT-213): the board refuses a drop into Done while
                this is set, so the drawer spells out what is missing. */}
            {ticket.doneBlockedReason !== null && (
              <div style={{ gridColumn: '1 / -1', border: '1px solid var(--warn)', borderRadius: 3, padding: '8px 11px' }}>
                <div style={{ ...mono(400, 9), color: 'var(--warn)', letterSpacing: '.08em', marginBottom: 3 }}>⛔ BLOCKED FROM DONE</div>
                <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>{ticket.doneBlockedReason}</div>
              </div>
            )}
            <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--agent)', letterSpacing: '.08em', marginBottom: 3 }}>◆ AGENT ESTIMATE (H)</div>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={estEditValue('estHours') ?? (ticket.estHours != null ? String(ticket.estHours) : '')}
                onChange={(e) => {
                  setEstEdit({ key: ticket.key, field: 'estHours', value: e.target.value });
                  if (estFieldError('estHours')) setEstError(null);
                }}
                onBlur={() => saveEstimate('estHours')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                title="Agent (LLM) time estimate in hours — required, cannot be cleared"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: 'var(--bg)',
                  border: `1px solid ${estFieldError('estHours') ? 'var(--bad)' : 'var(--line2)'}`,
                  color: 'var(--tx)',
                  borderRadius: 3,
                  padding: '3px 6px',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              />
              {estFieldError('estHours') && (
                <div style={{ ...mono(400, 9.5), color: 'var(--bad)', marginTop: 3 }}>{estFieldError('estHours')}</div>
              )}
              {ticket.actualHours != null && (
                <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 2 }}>
                  actual {fmtDuration(ticket.actualHours)}
                  {estDiffPct != null && (
                    <>
                      {' ('}
                      <span style={{ color: estDiffPct > 0 ? 'var(--bad)' : estDiffPct < 0 ? 'var(--ok)' : undefined }}>
                        {estDiffPct > 0 ? '+' : ''}
                        {estDiffPct}%
                      </span>
                      {')'}
                    </>
                  )}
                </div>
              )}
            </div>
            <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>HUMAN DEV ESTIMATE (H)</div>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={estEditValue('humanEstHours') ?? (ticket.humanEstHours != null ? String(ticket.humanEstHours) : '')}
                onChange={(e) => {
                  setEstEdit({ key: ticket.key, field: 'humanEstHours', value: e.target.value });
                  if (estFieldError('humanEstHours')) setEstError(null);
                }}
                onBlur={() => saveEstimate('humanEstHours')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                title="Estimated time for a human developer to deliver the same scope — required, cannot be cleared"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: 'var(--bg)',
                  border: `1px solid ${estFieldError('humanEstHours') ? 'var(--bad)' : 'var(--line2)'}`,
                  color: 'var(--tx)',
                  borderRadius: 3,
                  padding: '3px 6px',
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              />
              {estFieldError('humanEstHours') && (
                <div style={{ ...mono(400, 9.5), color: 'var(--bad)', marginTop: 3 }}>{estFieldError('humanEstHours')}</div>
              )}
            </div>
            <div style={{ gridColumn: '1 / -1', border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>WORKSTREAM</div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{ticket.workstream}</div>
            </div>
            <div style={{ gridColumn: '1 / -1', border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px' }}>
              <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>BRANCH</div>
              <input
                value={branchValue}
                onChange={(e) => setBranchEdit({ key: ticket.key, value: e.target.value })}
                onBlur={saveBranch}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                maxLength={255}
                spellCheck={false}
                placeholder="Set the git branch — auto-filled from the latest linked PR"
                title="Git branch for this ticket's work — shown on the board card"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: 'var(--bg)',
                  border: '1px solid var(--line2)',
                  color: 'var(--tx)',
                  borderRadius: 3,
                  padding: '3px 6px',
                  ...mono(400, 11),
                }}
              />
            </div>
          </div>
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>TAGS</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 16 }}>
            {ticket.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  ...mono(500, 10),
                  color: 'var(--tx2)',
                  border: '1px solid var(--line2)',
                  background: 'var(--bg)',
                  borderRadius: 2,
                  padding: '2px 4px 2px 7px',
                }}
              >
                {tag}
                <button
                  className="hv-bad"
                  title={`Remove tag "${tag}"`}
                  onClick={() => onTags(ticket.tags.filter((t) => t !== tag))}
                  style={{ border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 11, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  commitTagDraft();
                }
              }}
              onBlur={commitTagDraft}
              list={`tag-options-${ticket.key}`}
              placeholder={ticket.tags.length === 0 ? 'Add a tag…' : '+ tag'}
              style={{
                width: ticket.tags.length === 0 ? 120 : 70,
                background: 'var(--bg)',
                border: '1px dashed var(--line2)',
                borderRadius: 2,
                color: 'var(--tx)',
                padding: '3px 7px',
                fontSize: 11.5,
              }}
            />
            {/* Standard tags (DAT-210): suggested in the input's dropdown and
                one click away as chips. Ordinary tags either way — nothing
                here writes a field the free-text input can't. */}
            <datalist id={`tag-options-${ticket.key}`}>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            {tagOptions.map((tag) => (
              <button
                key={tag}
                className="hv-border"
                title={`Tag this ticket "${tag}"`}
                onClick={() => addTag(tag)}
                style={{
                  ...mono(500, 10),
                  color: 'var(--tx3)',
                  border: '1px dashed var(--line2)',
                  background: 'none',
                  borderRadius: 2,
                  padding: '2px 7px',
                  cursor: 'pointer',
                }}
              >
                + {tag}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>DESCRIPTION</span>
            {ticket.updatedAt && (
              <span style={{ ...mono(400, 9), color: 'var(--tx3)' }} title="When the ticket content was last edited">
                · EDITED {fmtTime(ticket.updatedAt)}
              </span>
            )}
            {!proposed && !['done', 'dismissed'].includes(ticket.status) && descValue === null && (
              <>
                <button
                  className="hv-border"
                  title="Edit the ticket description"
                  onClick={() => setDescEdit({ key: ticket.key, value: ticket.description })}
                  style={{
                    marginLeft: 'auto',
                    border: '1px solid var(--line2)',
                    background: 'none',
                    color: 'var(--tx2)',
                    borderRadius: 3,
                    padding: '2px 9px',
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  ✎ Edit
                </button>
                <button
                  className="hv-border"
                  title="Rewrite this ticket as a planned ticket (context, approach, dependencies, acceptance criteria) via the planning model"
                  disabled={refining}
                  onClick={() => {
                    if (refining) return;
                    setRefining(true);
                    api
                      .refineTicket(ticket.key)
                      .then(() => {
                        toast(`${ticket.key} refined into a planned ticket`);
                        refreshDetail();
                      })
                      .catch((e: Error) => toast(`Refine failed — ${e.message}`))
                      .finally(() => setRefining(false));
                  }}
                  style={{
                    border: '1px solid var(--line2)',
                    background: 'none',
                    color: 'var(--tx2)',
                    borderRadius: 3,
                    padding: '2px 9px',
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: refining ? 0.5 : 1,
                  }}
                >
                  {refining ? 'Refining…' : '✦ Refine'}
                </button>
              </>
            )}
            {descValue !== null && (
              <>
                <button
                  title="Save the edited description (Ctrl+Enter)"
                  disabled={savingDesc || !descValue.trim()}
                  onClick={saveDescription}
                  style={{
                    marginLeft: 'auto',
                    border: '1px solid var(--acc)',
                    background: 'none',
                    color: 'var(--acc)',
                    borderRadius: 3,
                    padding: '2px 9px',
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: savingDesc || !descValue.trim() ? 0.5 : 1,
                  }}
                >
                  {savingDesc ? 'Saving…' : 'Save'}
                </button>
                <button
                  className="hv-border"
                  title="Discard the edit (Esc)"
                  disabled={savingDesc}
                  onClick={() => setDescEdit(null)}
                  style={{
                    border: '1px solid var(--line2)',
                    background: 'none',
                    color: 'var(--tx2)',
                    borderRadius: 3,
                    padding: '2px 9px',
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: savingDesc ? 0.5 : 1,
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
          <div style={{ margin: '0 0 16px' }}>
            {descValue !== null ? (
              <>
                <textarea
                  autoFocus
                  value={descValue}
                  onChange={(e) => setDescEdit({ key: ticket.key, value: e.target.value })}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDescription();
                    if (e.key === 'Escape' && !savingDesc) setDescEdit(null);
                  }}
                  rows={14}
                  maxLength={20000}
                  spellCheck={false}
                  style={{
                    width: '100%',
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
                <div style={{ ...mono(400, 9), color: 'var(--tx3)', marginTop: 4 }}>
                  Markdown supported — Ctrl+Enter to save, Esc to cancel
                </div>
              </>
            ) : (
              <Markdown text={ticket.description} />
            )}
          </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
              ATTACHMENTS{attachments && attachments.length > 0 ? ` · ${attachments.length}` : ''}
            </span>
            <input
              ref={fileInput}
              type="file"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) uploadAttachment(file);
              }}
            />
            <button
              className="hv-border"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
              title="Attach a file to this ticket (max 25 MB)"
              style={{
                marginLeft: 'auto',
                border: '1px solid var(--line2)',
                background: 'none',
                color: 'var(--tx2)',
                borderRadius: 3,
                padding: '2px 9px',
                fontSize: 10.5,
                fontWeight: 600,
                cursor: 'pointer',
                opacity: uploading ? 0.5 : 1,
              }}
            >
              {uploading ? 'Uploading…' : '+ Attach file'}
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
            {attachments && attachments.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No files attached.</div>
            )}
            {(attachments ?? []).map((a) => (
              <div
                key={a.id}
                style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--line)', borderRadius: 3, padding: '7px 11px' }}
              >
                <span style={{ ...mono(500, 9), color: 'var(--tx3)', border: '1px solid var(--line2)', borderRadius: 2, padding: '1px 5px' }}>
                  {fmtSize(a.size)}
                </span>
                <a
                  href={a.url}
                  download={a.filename}
                  title={`Uploaded by ${a.uploader}${a.createdAt ? ` · ${fmtTime(a.createdAt)}` : ''}`}
                  style={{ fontSize: 12, color: 'var(--tx)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: 'none' }}
                >
                  {a.filename}
                </a>
                <span style={{ ...mono(400, 9), color: 'var(--tx3)', maxWidth: 140, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {a.uploader.split('@')[0]}
                </span>
                {lead && (
                  <button
                    className="hv-bad"
                    onClick={() => (attachArm === a.id ? removeAttachment(a) : setAttachArm(a.id))}
                    onMouseLeave={() => setAttachArm((cur) => (cur === a.id ? null : cur))}
                    title={attachArm === a.id ? 'Click again to delete' : `Delete ${a.filename}`}
                    style={{
                      flex: 'none',
                      border: 'none',
                      background: 'none',
                      color: attachArm === a.id ? 'var(--bad)' : 'var(--tx3)',
                      ...mono(500, 9),
                      letterSpacing: '.06em',
                      cursor: 'pointer',
                      padding: '2px 4px',
                    }}
                  >
                    {attachArm === a.id ? 'CONFIRM?' : '✕'}
                  </button>
                )}
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
                      {agentTask.agent && (
                        <span
                          title={`${agentTask.agent} (${runnerBrand(agentTask.agent).label} runner)`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...mono(400, 10), color: 'var(--tx2)' }}
                        >
                          {runnerBrand(agentTask.agent).mark(11)}
                          {agentTask.agent}
                        </span>
                      )}
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
                    {(agentRunning || toolCalls.length > 0) && (
                      <div>
                        <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', margin: '3px 0 4px' }}>
                          TOOL ACTIVITY
                          {toolCalls.length > 0 ? ` · ${toolCalls.length}${toolFeed && toolFeed.calls.length > toolCalls.length ? ' LATEST' : ''}` : ''}
                          {agentRunning && (
                            <span style={{ color: 'var(--agent)', animation: 'eec-pulse 2.4s infinite' }}> · LIVE</span>
                          )}
                        </div>
                        <div
                          ref={feedBox}
                          style={{
                            maxHeight: 170,
                            overflowY: 'auto',
                            background: 'var(--bg)',
                            border: '1px solid var(--line)',
                            borderRadius: 3,
                            padding: '6px 9px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 2,
                          }}
                        >
                          {toolCalls.length === 0 && (
                            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>WAITING FOR TOOL ACTIVITY…</span>
                          )}
                          {toolCalls.map((c) => (
                            <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', ...mono(400, 10), lineHeight: 1.55 }}>
                              <span style={{ flex: 'none', color: 'var(--tx3)' }}>
                                {new Date(c.calledAt).toLocaleTimeString('en', { hour12: false })}
                              </span>
                              <span style={{ flex: 'none', color: 'var(--agent)', fontWeight: 500 }}>{c.tool}</span>
                              <span
                                title={c.detail}
                                style={{ color: 'var(--tx2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                              >
                                {c.detail}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
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
          <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>
            LINKED WORK{linksData && linksData.links.length > 0 ? ` · ${linksData.links.length}` : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18 }}>
            {linksData === null && linked?.key === ticket.key && (
              <div style={{ fontSize: 12, color: 'var(--tx3)' }}>
                Couldn’t load linked work.{' '}
                <button onClick={loadLinks} style={{ border: 'none', background: 'none', color: 'var(--acc)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
                  Retry
                </button>
              </div>
            )}
            {(linksData?.links ?? []).map((l) => {
              const badge = LINK_BADGE[l.type];
              const statusColor = l.status === 'done' ? 'var(--ok)' : l.status === 'review' ? 'var(--warn)' : 'var(--tx3)';
              return (
                <div
                  key={`${l.type}-${l.key}-${l.id ?? 'm'}`}
                  className="hv-agent"
                  onClick={() => onOpenTicket(l.key)}
                  title={`Open ${l.key}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--line)', borderRadius: 3, padding: '8px 11px', cursor: 'pointer' }}
                >
                  <span style={{ ...mono(500, 9), color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 2, padding: '1px 5px', letterSpacing: '.06em', flex: 'none' }}>
                    {badge.label}
                  </span>
                  <span style={{ ...mono(500, 10), color: 'var(--tx3)', flex: 'none' }}>{l.key}</span>
                  <span style={{ fontSize: 12, color: 'var(--tx)', flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.title}
                  </span>
                  <span style={{ ...mono(400, 9), color: statusColor, flex: 'none', letterSpacing: '.06em' }}>
                    {(STATUS_LABEL[l.status] ?? l.status).toUpperCase()}
                  </span>
                  {l.id !== null && (
                    <button
                      className="hv-bad"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeLink(l.id as number);
                      }}
                      title="Remove link"
                      style={{ flex: 'none', border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 13, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                    >
                      ×
                    </button>
                  )}
                </div>
              );
            })}
            {(linksData?.branches.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em' }}>BRANCHES</span>
                {(linksData?.branches ?? []).map((b) => (
                  <a
                    key={b.branch}
                    href={b.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`PR #${b.prNumber} — ${b.state}`}
                    className="hv-border"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--line)', borderRadius: 3, padding: '3px 8px', textDecoration: 'none' }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: PR_STATE_COLOR[b.state] ?? 'var(--tx3)', flex: 'none' }} />
                    <span style={{ ...mono(400, 10), color: 'var(--tx2)', maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {b.branch}
                    </span>
                  </a>
                ))}
              </div>
            )}
            {linkableTickets.length > 0 && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ ...mono(400, 10), color: 'var(--tx3)', flex: 'none' }}>{ticket.key}</span>
                <select
                  value={linkType}
                  onChange={(e) => setLinkType(e.target.value as typeof linkType)}
                  style={{ background: 'var(--bg)', border: '1px solid var(--line2)', color: 'var(--tx)', borderRadius: 3, padding: '3px 6px', fontSize: 11.5, cursor: 'pointer' }}
                >
                  {LINK_TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  value={linkTarget}
                  onChange={(e) => setLinkTarget(e.target.value)}
                  style={{ flex: 1, minWidth: 0, background: 'var(--bg)', border: '1px solid var(--line2)', color: 'var(--tx)', borderRadius: 3, padding: '3px 6px', fontSize: 11.5, cursor: 'pointer' }}
                >
                  <option value="">Select a ticket…</option>
                  {linkableTickets.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.key} — {t.title}
                    </option>
                  ))}
                </select>
                <button
                  onClick={addLink}
                  disabled={!linkTarget || linking}
                  style={{
                    flex: 'none',
                    border: '1px solid var(--line2)',
                    background: 'none',
                    color: 'var(--tx2)',
                    borderRadius: 3,
                    padding: '3px 10px',
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: !linkTarget || linking ? 0.45 : 1,
                  }}
                >
                  {linking ? '…' : 'Link'}
                </button>
              </div>
            )}
          </div>
          {/* Review SLA (DAT-201): visible once the lead has been pinged at 24h.
              Dismissing resets both timers and clears the board flag. */}
          {esc && (esc.stage === 'pinged' || esc.stage === 'flagged') && (
            <>
              <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>REVIEW SLA</div>
              <div
                style={{
                  border: `1px solid ${esc.stage === 'flagged' ? 'var(--bad)' : 'var(--warn)'}`,
                  borderRadius: 3,
                  padding: '9px 11px',
                  marginBottom: 18,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    ...mono(500, 9),
                    color: esc.stage === 'flagged' ? 'var(--bad)' : 'var(--warn)',
                    border: `1px solid ${esc.stage === 'flagged' ? 'var(--bad)' : 'var(--warn)'}`,
                    borderRadius: 2,
                    padding: '1px 5px',
                    letterSpacing: '.06em',
                    flex: 'none',
                  }}
                >
                  {esc.stage === 'flagged' ? '⚠ 48H BREACH' : '⏰ 24H PING'}
                </span>
                <span style={{ fontSize: 11.5, color: 'var(--tx2)', flex: 1, minWidth: 180, lineHeight: 1.45 }}>
                  {esc.stage === 'flagged'
                    ? `PR #${esc.prNumber} has been unreviewed for ${esc.hoursUnreviewed}h — a summary was posted on the PR and this ticket is flagged on the board.`
                    : `PR #${esc.prNumber} has been unreviewed for ${esc.hoursUnreviewed}h — ${esc.leadEmail ?? 'the engagement lead'} was pinged${
                        esc.hoursUntilNextStage === null ? '' : `. ${esc.hoursUntilNextStage}h until the 48h escalation`
                      }.`}
                  {esc.dismissCount > 0 && ' (timers were reset by a previous dismissal)'}
                </span>
                {lead && (
                  <button
                    onClick={dismissEscalation}
                    disabled={dismissing}
                    title="Reset the 24h and 48h timers and clear the flag"
                    style={{
                      flex: 'none',
                      border: '1px solid var(--line2)',
                      background: 'none',
                      color: 'var(--tx2)',
                      borderRadius: 2,
                      padding: '2px 9px',
                      ...mono(500, 9),
                      letterSpacing: '.06em',
                      cursor: dismissing ? 'default' : 'pointer',
                      opacity: dismissing ? 0.5 : 1,
                    }}
                  >
                    {dismissing ? 'DISMISSING…' : 'DISMISS'}
                  </button>
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
            {(comments ?? []).map((c) => {
              const coord = parseCoordComment(c.body);
              return (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, transform: 'translateY(4px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)' }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}
              >
                <span
                  style={{
                    flex: 'none',
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: coord ? 'var(--agentsoft)' : 'var(--bg3)',
                    border: `1px solid ${coord ? 'var(--agent)' : 'var(--line2)'}`,
                    display: 'grid',
                    placeItems: 'center',
                    ...mono(500, 9),
                    color: coord ? 'var(--agent)' : 'var(--tx2)',
                  }}
                  title={c.author}
                >
                  {coord ? '◆' : initials(c.author.split('@')[0].replace(/[._-]/g, ' '))}
                </span>
                <div
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: `1px solid ${coord ? 'var(--agent)' : 'var(--line)'}`,
                    borderLeft: coord ? '3px solid var(--agent)' : '1px solid var(--line)',
                    borderRadius: 3,
                    padding: '7px 10px',
                    background: coord ? 'var(--agentsoft)' : 'var(--bg)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: coord ? 5 : 3 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: coord ? 'var(--agent)' : 'var(--tx)' }}>{c.author}</span>
                    {coord && <span style={{ ...mono(500, 8), color: 'var(--tx3)', letterSpacing: '.08em' }}>AGENT&nbsp;COMMS</span>}
                    <span style={{ ...mono(400, 9), color: 'var(--tx3)', marginLeft: 'auto' }}>{fmtTime(c.createdAt)}</span>
                  </div>
                  {coord ? (
                    <CoordCommentBody meta={coord.meta} text={coord.text} onOpenTicket={onOpenTicket} />
                  ) : (
                    <Markdown text={c.body} />
                  )}
                </div>
              </motion.div>
              );
            })}
            {(planningActive || (agentTask !== null && ['claimed', 'working'].includes(agentTask.state))) && (
              <motion.div
                key="agent-typing"
                initial={{ opacity: 0, transform: 'translateY(4px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)' }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                style={{ display: 'flex', gap: 9, alignItems: 'center' }}
              >
                <span
                  style={{
                    flex: 'none',
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: 'var(--agentsoft)',
                    border: '1px solid var(--agent)',
                    display: 'grid',
                    placeItems: 'center',
                    ...mono(500, 10),
                    color: 'var(--agent)',
                  }}
                  title={
                    planningActive
                      ? 'Planning Agent'
                      : agentTask?.agent
                        ? `${agentTask.agent} (${runnerBrand(agentTask.agent).label} runner)`
                        : 'Agent'
                  }
                >
                  {!planningActive && agentTask?.agent ? runnerBrand(agentTask.agent).mark(13) : '◆'}
                </span>
                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    border: '1px solid var(--line)',
                    borderRadius: 3,
                    padding: '8px 12px',
                    background: 'var(--bg)',
                  }}
                >
                  {[0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      animate={{
                        opacity: [0.3, 1, 0.3],
                        transform: ['translateY(0px)', 'translateY(-2.5px)', 'translateY(0px)'],
                      }}
                      transition={{ repeat: Infinity, duration: 1, delay: i * 0.16, ease: 'easeInOut' }}
                      style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--agent)', display: 'inline-block' }}
                    />
                  ))}
                  <span style={{ ...mono(400, 9.5), color: 'var(--tx3)', letterSpacing: '.06em', marginLeft: 5 }}>
                    {planningActive ? 'PLANNING AGENT IS REWORKING THE PLAN…' : 'AGENT IS WORKING — REPLIES LAND HERE'}
                  </span>
                </div>
              </motion.div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') postComment();
              }}
              rows={2}
              placeholder="Add a comment… markdown supported (Ctrl+Enter to post)"
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
