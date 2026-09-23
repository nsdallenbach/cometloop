import { useMemo, useState } from 'react';
import type React from 'react';
import { ticketMatchesQuery } from '../lib/ticket-tags';
import type { Ticket, TicketStatus } from '../types';
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

const STATUS_FILTERS: ('All' | TicketStatus)[] = ['All', 'backlog', 'progress', 'review', 'deploying', 'done', 'proposed'];

/**
 * The project's Tickets tab (/projects/:id/tickets): every ticket on this
 * engagement as a filterable list. It reads the same detail payload the
 * board renders from, so the two never disagree; rows open /tickets/:key.
 */
export function Tickets({ tickets, onOpen }: { tickets: Ticket[]; onOpen: (key: string) => void }) {
  const [fStatus, setFStatus] = useState<'All' | TicketStatus>('All');
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () => tickets.filter((t) => (fStatus === 'All' || t.status === fStatus) && ticketMatchesQuery(t, query)),
    [tickets, fStatus, query],
  );

  const nProgress = tickets.filter((t) => t.status === 'progress').length;
  const nBlocked = tickets.filter((t) => t.blocked).length;

  return (
    <div className="tab-pane" style={{ flex: 1, overflow: 'auto', padding: '20px 22px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Tickets</h1>
        <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>
          {tickets.length} TOTAL · {nProgress} IN PROGRESS · {nBlocked} BLOCKED
        </span>
        <div style={{ flex: 1 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by key, title, assignee, tag…"
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

      {tickets.length === 0 && (
        <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '44px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No tickets yet</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)' }}>Tickets created on this project&rsquo;s board show up here.</div>
        </div>
      )}

      {tickets.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr>
              <th style={th}>KEY</th>
              <th style={th}>TITLE</th>
              <th style={th}>STATUS</th>
              <th style={th}>ASSIGNEE</th>
              <th style={th}>BRANCH</th>
              <th style={th}>EST</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.key} className="hv-row" onClick={() => onOpen(t.key)} style={{ cursor: 'pointer' }}>
                <td style={{ ...td, ...mono(500, 11), color: 'var(--tx2)', whiteSpace: 'nowrap' }}>{t.key}</td>
                <td style={{ ...td, fontWeight: 500 }}>
                  {t.title}
                  {t.blocked && <span style={{ ...mono(500, 10), color: 'var(--bad)', marginLeft: 8 }}>BLOCKED</span>}
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
                <td colSpan={6} style={{ ...td, textAlign: 'center', color: 'var(--tx3)', padding: '24px 10px' }}>
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
