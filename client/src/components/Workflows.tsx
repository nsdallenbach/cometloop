import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, ApiError } from '../api';
import { paths } from '../routes';
import { mono } from '../util';
import { sampleWorkflow, type Workflow, type WorkflowSummary } from '../lib/workflow-graph';
import { StatePill, WorkflowRunsPanel, ago, td, th } from './WorkflowRuns';

/**
 * Workflows (DAT-284 / DAT-288): the list — every workflow, what starts it,
 * whether it is on, how its last run went and the week's tally — with Run
 * now and the on/off switch inline, and the recent runs across all of them
 * underneath. Click a name to open the builder. Modelled on a jobs page:
 * the list is where you see what is running, the builder is where you
 * change it.
 */

const EMPTY: Workflow = { nodes: [], edges: [] };

const btn: CSSProperties = { border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '5px 12px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' };
const small: CSSProperties = { ...btn, padding: '3px 9px', ...mono(500, 10), color: 'var(--tx2)' };

export function Toggle({ on, busy, onChange, title }: { on: boolean; busy?: boolean; onChange: (next: boolean) => void; title?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={title}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      style={{ width: 34, height: 18, borderRadius: 9, border: `1px solid ${on ? 'var(--ok)' : 'var(--line2)'}`, background: on ? 'var(--ok)' : 'var(--bg3)', position: 'relative', cursor: busy ? 'wait' : 'pointer', padding: 0, opacity: busy ? 0.6 : 1 }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 17 : 2, width: 12, height: 12, borderRadius: '50%', background: on ? '#fff' : 'var(--tx3)', transition: 'left .12s' }} />
    </button>
  );
}

export function Workflows({ toast, navigate, canLead }: { toast: (msg: string) => void; navigate: (path: string) => void; canLead: boolean }) {
  const [list, setList] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(
    () =>
      api
        .workflows()
        .then((all) => {
          setList(all);
          setError(null);
        })
        .catch((e: Error) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const create = (name: string, graph: Workflow) =>
    api
      .createWorkflow(name, graph)
      .then((w) => navigate(paths.workflow(w.id)))
      .catch((e: Error) => toast(`Couldn’t create the workflow — ${e.message}`));

  const setEnabled = (w: WorkflowSummary, enabled: boolean) => {
    setBusy(w.id);
    api
      .saveWorkflow(w.id, { enabled })
      .then(() => {
        toast(enabled ? `“${w.name}” is on` : `“${w.name}” is off`);
        return refresh();
      })
      .catch((e: Error) => toast(e instanceof ApiError && e.status === 403 ? 'Only leads and admins switch workflows on' : `Couldn’t ${enabled ? 'enable' : 'disable'} “${w.name}” — ${e.message}`))
      .finally(() => setBusy(null));
  };

  const runNow = (w: WorkflowSummary) => {
    setBusy(w.id);
    api
      .runWorkflow(w.id)
      .then((r) => {
        toast(r.state === 'succeeded' ? `“${w.name}” ran: ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}` : `“${w.name}” failed — ${r.error}`);
        setRefreshKey((k) => k + 1);
        return refresh();
      })
      .catch((e: Error) => toast(`Couldn’t run “${w.name}” — ${e.message}`))
      .finally(() => setBusy(null));
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ padding: '20px 22px 28px', display: 'grid', gap: 18, maxWidth: 1240 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Workflows</h1>
          <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>
            {list ? `${list.length} WORKFLOW${list.length === 1 ? '' : 'S'} · ${list.filter((w) => w.enabled).length} ON` : 'LOADING…'}
          </span>
          <div style={{ flex: 1 }} />
          <button className="hv-border" onClick={() => void create('Untitled workflow', EMPTY)} style={btn}>
            + New workflow
          </button>
          <button className="hv-border" onClick={() => void create('PR triage (sample)', sampleWorkflow())} style={{ ...btn, color: 'var(--tx2)' }}>
            New from sample
          </button>
        </div>
        <p style={{ margin: '-8px 0 0', fontSize: 12.5, color: 'var(--tx2)', maxWidth: 760, lineHeight: 1.5 }}>
          A workflow starts on a trigger — a ticket moving, a pull request, an agent finishing, a schedule, an idle ticket — walks its graph, and every run is recorded below. Conditions branch on a rule or on a
          decision model (Jev, or Databricks ai_decide). Switch one on when its graph is complete; leads and admins can.
        </p>
        {error && <div style={{ ...mono(400, 10.5), color: 'var(--bad)' }}>COULDN’T LOAD WORKFLOWS: {error}</div>}

        {list && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>ON</th>
                <th style={th}>NAME</th>
                <th style={th}>TRIGGER</th>
                <th style={th}>LAST RUN</th>
                <th style={th}>7 DAYS</th>
                <th style={th}>UPDATED</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((w) => (
                <tr key={w.id} className="hv-row" onClick={() => navigate(paths.workflow(w.id))} style={{ cursor: 'pointer' }}>
                  <td style={td}>
                    <Toggle on={w.enabled} busy={busy === w.id} onChange={(next) => setEnabled(w, next)} title={canLead ? (w.enabled ? 'Switch off' : 'Switch on') : 'Leads and admins switch workflows on'} />
                  </td>
                  <td style={{ ...td, fontWeight: 600 }}>
                    {w.name}
                    <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 2 }}>
                      {w.nodes} NODE{w.nodes === 1 ? '' : 'S'}
                    </div>
                  </td>
                  <td style={{ ...td, color: 'var(--tx2)', maxWidth: 320 }}>{w.trigger}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {w.lastRun ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <StatePill state={w.lastRun.state} />
                        <span style={{ color: 'var(--tx2)' }} title={w.lastRun.error || new Date(w.lastRun.startedAt).toLocaleString()}>
                          {ago(w.lastRun.startedAt)}
                        </span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--tx3)' }}>never</span>
                    )}
                  </td>
                  <td style={{ ...td, ...mono(400, 11), whiteSpace: 'nowrap' }}>
                    <span style={{ color: 'var(--ok)' }}>{w.runs7d.ok} ok</span>
                    {w.runs7d.failed > 0 && <span style={{ color: 'var(--bad)', marginLeft: 8 }}>{w.runs7d.failed} failed</span>}
                  </td>
                  <td style={{ ...td, color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                    {ago(w.updatedAt)}
                    {w.updatedBy ? ` · ${w.updatedBy}` : ''}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button
                      className="hv-border"
                      disabled={busy === w.id || !canLead}
                      title={canLead ? 'Run from its manual (or first) trigger now' : 'Leads and admins run workflows'}
                      onClick={(e) => {
                        e.stopPropagation();
                        runNow(w);
                      }}
                      style={{ ...small, marginRight: 6 }}
                    >
                      RUN NOW
                    </button>
                    <button
                      className="hv-border"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(paths.workflow(w.id, 'runs'));
                      }}
                      style={small}
                    >
                      RUNS
                    </button>
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ ...td, color: 'var(--tx3)', padding: '18px 10px' }}>
                    No workflows yet. Start from the sample to see a PR triage with a decision node and an idle-ticket nudge.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        <WorkflowRunsPanel limit={40} toast={toast} refreshKey={refreshKey} title="Recent runs" />
      </div>
    </div>
  );
}
