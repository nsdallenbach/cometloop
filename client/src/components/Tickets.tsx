import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { api } from '../api';
import { ticketMatchesQuery } from '../lib/ticket-tags';
import type { TicketStatus, TicketWithEngagement } from '../types';
import { initials, mono, STATUS_LABEL } from '../util';
import { runnerBrand } from './RunnerLogo';

const th: React.CSSProperties = {
  textAlign: 'left',
  ...mono(500, 10),
  letterSpacing: '.08em',
  color: 'var(--tx3)',
  borderBottom: '1px solid var(--line)',
  padding: '8px 10px',
};
const td: React.CSSProperties = { borderBottom: '1px solid var(--line)', padding: '8px 10px' };

const STATUS_FILTERS: ('All' | TicketStatus)[] = ['All', 'backlog', 'progress', 'review', 'done', 'proposed'];

/** Cross-project tickets list (/tickets); rows link to /tickets/:key. */
export function Tickets({ onOpen }: { onOpen: (key: string, engagementId: string) => void }) {
  const [rows, setRows] = useState<TicketWithEngagement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fStatus, setFStatus] = useState<'All' | TicketStatus>('All');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let stale = false;
    api
      .tickets()
      .then((t) => {
        if (!stale) setRows(t);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((t) => (fStatus === 'All' || t.status === fStatus) && ticketMatchesQuery(t, query));
  }, [rows, fStatus, query]);

  const nProgress = rows?.filter((t) => t.status === 'progress').length ?? 0;
  const nBlocked = rows?.filter((t) => t.blocked).length ?? 0;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Tickets</h1>
        {rows && (
          <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>
            {rows.length} TOTAL · {nProgress} IN PROGRESS · {nBlocked} BLOCKED
          </span>
        )}
        <div style={{ flex: 1 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by key, title, assignee, project, tag…"
          style={{
            border: '1px solid var(--line2)',
            background: 'var(--bg2)',
            color: 'var(--tx)',
            borderRadius: 3,
            padding: '5px 10px',
            fontSize: 12,
            minWidth: 260,
            outline: 'none',
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>STATUS</span>
        {STATUS_FILTERS.map((o) => {
          const active = o === fStatus;
          return (
            <button
              key={o}
              className="hv-border"
              onClick={() => setFStatus(o)}
              style={{
                border: `1px solid ${active ? 'var(--tx3)' : 'var(--line)'}`,
                background: active ? 'var(--bg3)' : 'transparent',
                color: active ? 'var(--tx)' : 'var(--tx2)',
                borderRadius: 3,
                padding: '4px 9px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {o === 'All' ? 'All' : STATUS_LABEL[o]}
            </button>
          );
        })}
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid var(--bad)', borderRadius: 4, color: 'var(--bad)', ...mono(400, 11) }}>
          <span>COULDN’T LOAD TICKETS: {error}</span>
        </div>
      )}

      {!error && !rows && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} style={{ border: '1px solid var(--line)', background: 'var(--bg2)', borderRadius: 4, height: 36, animation: 'eec-pulse 1.6s infinite' }} />
          ))}
        </div>
      )}

      {rows && rows.length === 0 && (
        <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '44px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No tickets yet</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)' }}>Tickets created on any project board show up here.</div>
        </div>
      )}

      {rows && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={th}>KEY</th>
              <th style={th}>TITLE</th>
              <th style={th}>PROJECT</th>
              <th style={th}>STATUS</th>
              <th style={th}>ASSIGNEE</th>
              <th style={th}>BRANCH</th>
              <th style={th}>EST</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.key} className="hv-row" onClick={() => onOpen(t.key, t.engagementId)} style={{ cursor: 'pointer' }}>
                <td style={{ ...td, ...mono(500, 11), color: 'var(--tx2)', whiteSpace: 'nowrap' }}>{t.key}</td>
                <td style={{ ...td, fontWeight: 500 }}>
                  {t.title}
                  {t.blocked && <span style={{ ...mono(500, 10), color: 'var(--bad)', marginLeft: 8 }}>BLOCKED</span>}
                </td>
                <td style={{ ...td, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
                  <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>{t.client}</span>
                  <span style={{ color: 'var(--tx3)' }}> · </span>
                  {t.engagementName}
                </td>
                <td style={{ ...td, ...mono(400, 11), color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
                  {STATUS_LABEL[t.status] ?? t.status}
                </td>
                <td style={{ ...td, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>
                  {t.assignee && t.assignee !== '—' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <span
                        title={t.runner !== null ? `${t.assignee} (${runnerBrand(t.runner).label} runner)` : t.assignee}
                        style={{
                          width: 20,
                          height: 20,
                          flex: 'none',
                          borderRadius: '50%',
                          background: 'var(--bg3)',
                          border: '1px solid var(--line2)',
                          display: 'grid',
                          placeItems: 'center',
                          ...mono(500, 9),
                          color: 'var(--tx2)',
                        }}
                      >
                        {t.runner !== null ? runnerBrand(t.runner).mark(12) : initials(t.assignee)}
                      </span>
                      {t.assignee}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td
                  title={t.branch ?? undefined}
                  style={{ ...td, ...mono(400, 10), color: 'var(--tx3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}
                >
                  {t.branch ? <>⎇ {t.branch}</> : '—'}
                </td>
                <td style={{ ...td, ...mono(400, 11), color: 'var(--tx3)', whiteSpace: 'nowrap' }}>{t.est || '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--tx3)', padding: '24px 10px' }}>
                  No tickets match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
