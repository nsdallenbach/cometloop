import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DeployEventItem, DeployMirrorEntry } from '../types';
import { mono } from '../util';

/**
 * Deploys tab (DAT-236): the READ-ONLY mirror of the local deployment queues.
 * Everything here is rendered purely from deploy events the desktop clients
 * report home — deploys run on developers' machines with their identity, and
 * this view deliberately exposes no action that could reach one. PMs get full
 * visibility; laptops get zero inbound surface.
 */

const STATE_COLOR: Record<DeployMirrorEntry['state'], string> = {
  queued: 'var(--tx3)',
  deploying: 'var(--agent)',
  succeeded: 'var(--ok)',
  failed: 'var(--bad)',
};

const EVENT_LABEL: Record<DeployEventItem['event'], string> = {
  queued: 'queued',
  started: 'deploy started',
  succeeded: 'deploy succeeded',
  failed: 'deploy FAILED',
  removed: 'left the queue',
};

function ago(iso: string): string {
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

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  ...mono(500, 10),
  letterSpacing: '.08em',
  color: 'var(--tx3)',
  borderBottom: '1px solid var(--line)',
  padding: 'var(--rowpad)',
};
const tdStyle: React.CSSProperties = { borderBottom: '1px solid var(--line)', padding: 'var(--rowpad)', fontSize: 12.5 };

export function DeploysMirror({ engId, openTicket }: { engId: string; openTicket: (key: string) => void }) {
  const [queue, setQueue] = useState<DeployMirrorEntry[]>([]);
  const [events, setEvents] = useState<DeployEventItem[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const d = await api.deploys(engId);
        if (stop) return;
        setQueue(d.queue);
        setEvents(d.events);
        setError('');
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : 'Failed to load deployments');
      } finally {
        if (!stop) setLoaded(true);
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [engId]);

  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 980 }}>
      <div>
        <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>
          ▲ DEPLOYMENT QUEUE · READ-ONLY MIRROR
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--tx2)', lineHeight: 1.5, maxWidth: 720 }}>
          Merged tickets deploy from each developer&rsquo;s own machine, with their identity. This view is
          rendered purely from deploy events those machines report — there is no path from here into
          anyone&rsquo;s laptop.
        </div>
      </div>

      {error && <div style={{ fontSize: 12, color: 'var(--warn)' }}>⚠ {error}</div>}

      <div style={{ background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={thStyle}>TICKET</th>
              <th style={thStyle}>TITLE</th>
              <th style={thStyle}>PR</th>
              <th style={thStyle}>MACHINE</th>
              <th style={thStyle}>RUNS AS</th>
              <th style={thStyle}>STATE</th>
              <th style={thStyle}>UPDATED</th>
            </tr>
          </thead>
          <tbody>
            {queue.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...tdStyle, borderBottom: 'none', color: 'var(--tx3)', textAlign: 'center', padding: '18px 14px' }}>
                  {loaded ? 'No local deploys reported yet — the queue fills as clients announce merged tickets.' : 'Loading…'}
                </td>
              </tr>
            )}
            {queue.map((e, idx) => (
              <tr key={e.ticketKey}>
                <td style={{ ...tdStyle, ...(idx === queue.length - 1 ? { borderBottom: 'none' } : {}) }}>
                  <button
                    onClick={() => openTicket(e.ticketKey)}
                    style={{ ...mono(500, 11.5), background: 'none', border: 'none', color: 'var(--link)', cursor: 'pointer', padding: 0 }}
                  >
                    {e.ticketKey}
                  </button>
                </td>
                <td style={{ ...tdStyle, ...(idx === queue.length - 1 ? { borderBottom: 'none' } : {}), maxWidth: 260, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {e.title || '—'}
                </td>
                <td style={{ ...tdStyle, ...(idx === queue.length - 1 ? { borderBottom: 'none' } : {}), ...mono(400, 11) }}>
                  {e.prNumber === null ? '—' : `#${e.prNumber}`}
                </td>
                <td style={{ ...tdStyle, ...(idx === queue.length - 1 ? { borderBottom: 'none' } : {}), ...mono(400, 11), color: 'var(--tx2)' }}>
                  {e.agent || '—'}
                </td>
                <td style={{ ...tdStyle, ...(idx === queue.length - 1 ? { borderBottom: 'none' } : {}), ...mono(400, 11), color: 'var(--tx2)' }}>
                  {e.actor || '—'}
                </td>
                <td style={{ ...tdStyle, ...(idx === queue.length - 1 ? { borderBottom: 'none' } : {}) }}>
                  <span
                    title={e.state === 'failed' && e.detail ? e.detail : undefined}
                    style={{
                      ...mono(500, 9.5),
                      letterSpacing: '.06em',
                      color: STATE_COLOR[e.state],
                      border: `1px solid ${STATE_COLOR[e.state]}`,
                      borderRadius: 3,
                      padding: '2px 7px',
                      ...(e.state === 'deploying' ? { animation: 'eec-pulse 2.4s infinite' } : {}),
                    }}
                  >
                    {e.state.toUpperCase()}
                  </span>
                </td>
                <td style={{ ...tdStyle, ...(idx === queue.length - 1 ? { borderBottom: 'none' } : {}), ...mono(400, 10.5), color: 'var(--tx3)', whiteSpace: 'nowrap' }}>
                  {ago(e.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {queue.some((e) => e.state === 'failed' && e.detail) && (
        <div style={{ display: 'grid', gap: 8 }}>
          {queue
            .filter((e) => e.state === 'failed' && e.detail)
            .map((e) => (
              <div
                key={e.ticketKey}
                style={{ background: 'var(--bg2)', border: '1px solid var(--bad)', borderRadius: 8, padding: '10px 14px' }}
              >
                <div style={{ ...mono(500, 10), color: 'var(--bad)', letterSpacing: '.06em', marginBottom: 4 }}>
                  ⚠ {e.ticketKey} — DEPLOY FAILED ON {e.agent.toUpperCase() || 'UNKNOWN MACHINE'}
                </div>
                <div style={{ ...mono(400, 11), color: 'var(--tx2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 140, overflowY: 'auto' }}>
                  {e.detail}
                </div>
              </div>
            ))}
        </div>
      )}

      <div>
        <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 8 }}>
          RECENT DEPLOY EVENTS
        </div>
        {events.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No deploy events yet.</div>
        ) : (
          <div style={{ background: 'var(--bg2)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px', display: 'grid', gap: 3 }}>
            {events.map((ev) => (
              <div key={ev.id} style={{ ...mono(400, 11), color: ev.event === 'failed' ? 'var(--bad)' : ev.event === 'succeeded' ? 'var(--ok)' : 'var(--tx2)' }}>
                <span style={{ color: 'var(--tx3)' }}>{ago(ev.createdAt)}</span>
                {' · '}
                {ev.ticketKey} {EVENT_LABEL[ev.event]} on {ev.agent}
                {ev.actor ? ` (as ${ev.actor})` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
