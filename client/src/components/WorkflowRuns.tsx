import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { mono } from '../util';
import { TRIGGERS } from '../../../shared/workflows/catalog';
import type { WorkflowRun, WorkflowRunSummary } from '../lib/workflow-graph';

/**
 * Run history (DAT-288): the table of runs — every workflow's on the list
 * page, one workflow's on its Runs tab — and the detail of one run, step by
 * step, the way a job's run page reads: what fired it, what each node did,
 * which branch a condition took, and where a failed run stopped.
 */

export const RUN_COLOR: Record<string, string> = {
  running: 'var(--agent)',
  succeeded: 'var(--ok)',
  failed: 'var(--bad)',
};

export function ago(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function duration(start: string, end: string | null): string {
  if (!end) return '…';
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export const triggerLabel = (id: string): string => TRIGGERS.find((t) => t.id === id)?.label ?? id;

export const th: CSSProperties = { textAlign: 'left', ...mono(500, 10), letterSpacing: '.08em', color: 'var(--tx3)', borderBottom: '1px solid var(--line)', padding: '8px 10px', whiteSpace: 'nowrap' };
export const td: CSSProperties = { borderBottom: '1px solid var(--line)', padding: '8px 10px', fontSize: 12.5, verticalAlign: 'top' };

export function StatePill({ state }: { state: string }) {
  return (
    <span style={{ ...mono(500, 9.5), letterSpacing: '.08em', color: RUN_COLOR[state] ?? 'var(--tx2)', border: `1px solid ${RUN_COLOR[state] ?? 'var(--line2)'}`, borderRadius: 2, padding: '1px 6px', whiteSpace: 'nowrap' }}>
      {state.toUpperCase()}
    </span>
  );
}

export function RunDetail({ run, onClose }: { run: WorkflowRun; onClose: () => void }) {
  const [showPayload, setShowPayload] = useState(false);
  return (
    <div style={{ border: '1px solid var(--line2)', borderRadius: 5, background: 'var(--bg2)', padding: '14px 16px', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatePill state={run.state} />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{run.workflowName}</span>
        <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>
          RUN #{run.id} · {triggerLabel(run.trigger).toUpperCase()}
          {run.subject ? ` · ${run.subject}` : ''} · {new Date(run.startedAt).toLocaleString()} · {duration(run.startedAt, run.finishedAt)}
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowPayload((v) => !v)} style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '3px 9px', ...mono(500, 10), cursor: 'pointer' }}>
          {showPayload ? 'HIDE EVENT' : 'SHOW EVENT'}
        </button>
        <button onClick={onClose} aria-label="Close run" style={{ border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 15, cursor: 'pointer', padding: 0 }}>
          ×
        </button>
      </div>
      {run.error && <div style={{ fontSize: 12.5, color: 'var(--bad)', lineHeight: 1.45 }}>{run.error}</div>}
      {showPayload && (
        <pre style={{ margin: 0, ...mono(400, 10.5), color: 'var(--tx2)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 3, padding: 10, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(run.payload, null, 2)}
        </pre>
      )}
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
        {run.steps.map((s, i) => (
          <li key={`${s.nodeId}-${i}`} style={{ display: 'grid', gridTemplateColumns: '18px 120px 1fr auto', gap: 10, alignItems: 'baseline', padding: '6px 8px', borderRadius: 3, background: 'var(--bg)', border: `1px solid ${s.state === 'failed' ? 'var(--bad)' : 'var(--line)'}` }}>
            <span style={{ ...mono(500, 10), color: s.state === 'failed' ? 'var(--bad)' : 'var(--ok)' }}>{s.state === 'failed' ? '✕' : '✓'}</span>
            <span style={{ ...mono(500, 9.5), letterSpacing: '.08em', color: 'var(--tx3)' }}>{s.kind.toUpperCase()}</span>
            <span style={{ fontSize: 12.5, lineHeight: 1.4 }}>
              <span style={{ fontWeight: 600 }}>{s.title || s.type}</span>
              {s.outcome && <span style={{ ...mono(500, 10), color: 'var(--warn)', marginLeft: 8 }}>→ {s.outcome.toUpperCase()}</span>}
              <div style={{ color: 'var(--tx2)', marginTop: 2, wordBreak: 'break-word' }}>{s.detail}</div>
            </span>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{s.ms}ms</span>
          </li>
        ))}
        {run.steps.length === 0 && <li style={{ fontSize: 12.5, color: 'var(--tx3)' }}>No steps recorded{run.state === 'running' ? ' yet' : ''}.</li>}
      </ol>
    </div>
  );
}

export function RunsTable({ runs, showWorkflow, onOpen, openId }: { runs: WorkflowRunSummary[]; showWorkflow: boolean; onOpen: (id: number) => void; openId: number | null }) {
  if (runs.length === 0) return <div style={{ padding: '18px 0', fontSize: 12.5, color: 'var(--tx3)' }}>No runs yet. Enable a workflow and let its trigger fire, or press Run now.</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={th}>STATE</th>
          {showWorkflow && <th style={th}>WORKFLOW</th>}
          <th style={th}>TRIGGER</th>
          <th style={th}>SUBJECT</th>
          <th style={th}>STARTED</th>
          <th style={th}>TOOK</th>
          <th style={th}>STEPS</th>
          <th style={{ ...th, width: '40%' }}>RESULT</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} onClick={() => onOpen(r.id)} className="hv-row" style={{ cursor: 'pointer', background: openId === r.id ? 'var(--bg3)' : undefined }}>
            <td style={td}>
              <StatePill state={r.state} />
            </td>
            {showWorkflow && <td style={{ ...td, fontWeight: 600 }}>{r.workflowName}</td>}
            <td style={td}>{triggerLabel(r.trigger)}</td>
            <td style={{ ...td, ...mono(500, 11.5) }}>{r.subject || '—'}</td>
            <td style={{ ...td, whiteSpace: 'nowrap' }} title={new Date(r.startedAt).toLocaleString()}>
              {ago(r.startedAt)}
            </td>
            <td style={{ ...td, ...mono(400, 11) }}>{duration(r.startedAt, r.finishedAt)}</td>
            <td style={{ ...td, ...mono(400, 11) }}>{r.stepCount}</td>
            <td style={{ ...td, color: r.error ? 'var(--bad)' : 'var(--tx2)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 420, whiteSpace: 'nowrap' }}>{r.error || (r.state === 'succeeded' ? 'ok' : '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Runs for one workflow (or all), polled, with one run opened in place. */
export function WorkflowRunsPanel({ workflowId, limit = 50, toast, refreshKey = 0, title }: { workflowId?: number; limit?: number; toast: (msg: string) => void; refreshKey?: number; title?: string }) {
  const [runs, setRuns] = useState<WorkflowRunSummary[] | null>(null);
  const [open, setOpen] = useState<WorkflowRun | null>(null);

  const load = useCallback(() => api.workflowRuns({ workflow: workflowId, limit }).then(setRuns), [workflowId, limit]);
  useEffect(() => {
    let stop = false;
    const tick = () =>
      load().catch((e: Error) => {
        if (!stop) toast(`Couldn’t load runs — ${e.message}`);
      });
    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [load, toast, refreshKey]);

  const openRun = (id: number) => {
    if (open?.id === id) {
      setOpen(null);
      return;
    }
    api
      .workflowRun(id)
      .then(setOpen)
      .catch((e: Error) => toast(`Couldn’t open that run — ${e.message}`));
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h2>
          <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>{runs ? `${runs.length} SHOWN · REFRESHES EVERY 15S` : 'LOADING…'}</span>
        </div>
      )}
      {open && <RunDetail run={open} onClose={() => setOpen(null)} />}
      {runs && <RunsTable runs={runs} showWorkflow={!workflowId} onOpen={openRun} openId={open?.id ?? null} />}
    </div>
  );
}
