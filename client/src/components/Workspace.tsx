import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Engagement, EngagementDetail, RepoDetail, Ticket, TicketStatus } from '../types';
import { HEALTH_COLOR, HEALTH_LABEL, fmtD, initials, mono, pct, todayIso } from '../util';
import type { Tab } from '../App';

const COLS: [TicketStatus, string][] = [
  ['backlog', 'BACKLOG'],
  ['progress', 'IN PROGRESS'],
  ['review', 'IN REVIEW'],
  ['done', 'DONE'],
];

const SKILL_COLS = ['DBX', 'DBT', 'PY', 'BI', 'AZURE', 'PM'];

const PR_STATE_COLOR: Record<string, string> = { open: 'var(--warn)', merged: 'var(--ok)', closed: 'var(--tx3)' };

function Empty({ label }: { label: string }) {
  return <div style={{ padding: '18px 14px', fontSize: 12, color: 'var(--tx3)', textAlign: 'center' }}>{label}</div>;
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  ...mono(500, 10),
  letterSpacing: '.08em',
  color: 'var(--tx3)',
  borderBottom: '1px solid var(--line)',
  padding: 'var(--rowpad)',
};
const tdBase: React.CSSProperties = { borderBottom: '1px solid var(--line)', padding: 'var(--rowpad)' };

export function Workspace({
  eng,
  detail,
  detailError,
  tab,
  setTab,
  goPortfolio,
  openTicket,
  setTicket,
  setDetail,
  toast,
  onEngagementChanged,
  refreshDetail,
  lead,
}: {
  eng: Engagement;
  detail: EngagementDetail | null;
  detailError: string | null;
  tab: Tab;
  setTab: (t: Tab) => void;
  goPortfolio: () => void;
  openTicket: (key: string) => void;
  setTicket: (key: string, patch: { status?: TicketStatus; assignee?: string }) => void;
  setDetail: React.Dispatch<React.SetStateAction<EngagementDetail | null>>;
  toast: (msg: string) => void;
  onEngagementChanged: () => void;
  refreshDetail: () => void;
  lead: boolean;
}) {
  const [boardMode, setBoardMode] = useState<'kanban' | 'table'>('kanban');
  const [newTicket, setNewTicket] = useState(false);
  const [bulk, setBulk] = useState<Record<string, boolean>>({});
  const [composer, setComposer] = useState<string | null>(null);
  const [pushed, setPushed] = useState<boolean | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushConfirm, setPushConfirm] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TicketStatus | null>(null);
  const drag = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const hc = HEALTH_COLOR[eng.health];
  const tickets = detail?.tickets ?? [];
  const proposedTickets = tickets.filter((t) => t.status === 'proposed');
  const bulkKeys = Object.keys(bulk).filter((k) => bulk[k]);
  const composerText = composer ?? eng.composer;
  const isPushed = pushed ?? eng.pushed;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'board', label: 'Board' },
    { key: 'roadmap', label: 'Roadmap' },
    { key: 'sources', label: 'Sources' },
    { key: 'team', label: 'Team' },
    { key: 'feed', label: 'Status Feed' },
  ];

  // roadmap geometry — derive the window from the phase schedule when the
  // engagement row has no explicit range, never from invented dates
  const rmS = eng.rmStart ?? eng.phases?.[0]?.s ?? todayIso();
  const rmE = eng.rmEnd ?? eng.phases?.[eng.phases.length - 1]?.e ?? todayIso();
  const months = useMemo(() => {
    // Iterate in UTC: date-only strings parse as UTC, so local-time month math
    // would duplicate the first tick in negative-offset timezones.
    const out: { label: string; l: number }[] = [];
    const end = new Date(`${rmE}T00:00:00Z`);
    let d = new Date(`${rmS}T00:00:00Z`);
    while (d < end) {
      out.push({
        label:
          d.toLocaleString('en', { month: 'short', timeZone: 'UTC' }).toUpperCase() +
          (d.getUTCMonth() === 0 ? ` ${String(d.getUTCFullYear()).slice(2)}` : ''),
        l: pct(rmS, rmE, d.toISOString().slice(0, 10)),
      });
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
    return out;
  }, [rmS, rmE]);

  const acceptTicket = (t: Ticket) => {
    setTicket(t.key, { status: 'backlog' });
    toast(`${t.key} accepted onto board`);
  };
  const dismissTicket = (t: Ticket) => {
    setTicket(t.key, { status: 'dismissed' });
    toast(`${t.key} dismissed — logged to feed`);
  };

  const scheduleComposerSave = (text: string) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api
        .saveComposer(eng.id, text)
        .then(() => {
          setSavedAt(new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }));
          onEngagementChanged();
        })
        .catch(() => toast('Draft save failed'));
    }, 1200);
  };

  const ticketCard = (t: Ticket) => (
    <div
      key={t.key}
      draggable
      onDragStart={() => (drag.current = t.key)}
      onDragEnd={() => {
        drag.current = null;
        setDragOverCol(null);
      }}
      onClick={() => openTicket(t.key)}
      className="hv-border"
      style={{
        border: `1px solid ${t.blocked ? 'var(--bad)' : t.agent ? 'var(--line2)' : 'var(--line)'}`,
        background: 'var(--bg2)',
        borderRadius: 3,
        padding: '9px 11px',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)' }}>{t.key}</span>
        {t.agent && (
          <span style={{ ...mono(500, 9), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '1px 4px' }}>◆ AGENT</span>
        )}
        {t.blocked && <span style={{ ...mono(500, 9), color: 'var(--bad)' }}>BLOCKED</span>}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.35, marginBottom: 7 }}>{t.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--bg3)',
            border: '1px solid var(--line2)',
            display: 'grid',
            placeItems: 'center',
            ...mono(500, 9),
            color: 'var(--tx2)',
          }}
        >
          {initials(t.assignee)}
        </span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{t.est}</span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)', marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>
          {t.sources[0]?.type ?? ''}
        </span>
      </div>
    </div>
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* engagement header */}
      <div style={{ flex: 'none', padding: '14px 22px 0', borderBottom: '1px solid var(--line)', background: 'var(--bg2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="hv-tx2"
            onClick={goPortfolio}
            style={{ background: 'none', border: 'none', color: 'var(--tx3)', ...mono(400, 11), cursor: 'pointer', padding: 0 }}
          >
            ← PORTFOLIO
          </button>
          <span style={{ color: 'var(--tx3)' }}>/</span>
          <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>{eng.client}</span>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{eng.name}</h1>
          <span style={{ ...mono(500, 10), color: hc, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: hc }} />
            {HEALTH_LABEL[eng.health]}
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 18, ...mono(400, 10.5), color: 'var(--tx2)' }}>
            <span>
              SOW <b style={{ color: 'var(--tx)' }}>{eng.sowStatus}</b>
            </span>
            <span>{eng.dates}</span>
            <span>
              VALUE <b style={{ color: 'var(--tx)' }}>{eng.value}</b>
            </span>
            <span>
              HOURS <b style={{ color: 'var(--tx)' }}>{eng.hours}</b>
            </span>
            <span>
              TEAM <b style={{ color: 'var(--tx)' }}>{eng.teamSize}</b>
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2, marginTop: 12 }}>
          {tabs.map((t) => (
            <button
              key={t.key}
              className="hv-tx"
              onClick={() => setTab(t.key)}
              style={{
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${tab === t.key ? 'var(--acc)' : 'transparent'}`,
                color: tab === t.key ? 'var(--tx)' : 'var(--tx2)',
                padding: '8px 13px',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {t.label}
              {t.key === 'board' && proposedTickets.length > 0 && (
                <span style={{ marginLeft: 6, ...mono(500, 10), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '1px 5px' }}>
                  ◆ {proposedTickets.length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {!detail && !detailError && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tx3)', ...mono(400, 11) }}>LOADING ENGAGEMENT…</div>
      )}
      {!detail && detailError && (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ ...mono(500, 11), color: 'var(--bad)', letterSpacing: '.06em', marginBottom: 8 }}>COULDN’T LOAD THIS ENGAGEMENT</div>
          <div style={{ fontSize: 12.5, color: 'var(--tx2)', marginBottom: 14 }}>{detailError}</div>
          <button
            onClick={refreshDetail}
            style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '6px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ===== BOARD ===== */}
      {detail && tab === 'board' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 22px' }}>
            <div style={{ display: 'flex', border: '1px solid var(--line2)', borderRadius: 3, overflow: 'hidden' }}>
              <button
                onClick={() => setBoardMode('kanban')}
                style={{
                  border: 'none',
                  padding: '5px 12px',
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: boardMode === 'kanban' ? 'var(--bg3)' : 'transparent',
                  color: boardMode === 'kanban' ? 'var(--tx)' : 'var(--tx2)',
                }}
              >
                Board
              </button>
              <button
                onClick={() => setBoardMode('table')}
                style={{
                  border: 'none',
                  borderLeft: '1px solid var(--line2)',
                  padding: '5px 12px',
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: boardMode === 'table' ? 'var(--bg3)' : 'transparent',
                  color: boardMode === 'table' ? 'var(--tx)' : 'var(--tx2)',
                }}
              >
                Table
              </button>
            </div>
            <button
              className="hv-border"
              onClick={() => setNewTicket(true)}
              style={{
                border: '1px solid var(--line2)',
                background: 'none',
                color: 'var(--tx)',
                borderRadius: 3,
                padding: '5px 12px',
                fontSize: 11.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              + New ticket
            </button>
            <div style={{ flex: 1 }} />
            {bulkKeys.length > 0 && (
              <>
                <span style={{ ...mono(500, 11), color: 'var(--tx)' }}>{bulkKeys.length} SELECTED</span>
                <button
                  onClick={() => {
                    const prev = detail;
                    setDetail((d) =>
                      d ? { ...d, tickets: d.tickets.map((t) => (bulk[t.key] ? { ...t, status: 'progress' } : t)) } : d,
                    );
                    api.bulkTickets(bulkKeys, { status: 'progress' }).catch(() => {
                      setDetail(prev);
                      toast('Bulk save failed — changes rolled back');
                    });
                    setBulk({});
                    toast(`${bulkKeys.length} tickets moved to In Progress`);
                  }}
                  style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                >
                  Move to In Progress
                </button>
                <select
                  value=""
                  onChange={(e) => {
                    const who = e.target.value;
                    if (!who) return;
                    const prev = detail;
                    setDetail((d) => (d ? { ...d, tickets: d.tickets.map((t) => (bulk[t.key] ? { ...t, assignee: who } : t)) } : d));
                    api.bulkTickets(bulkKeys, { assignee: who }).catch(() => {
                      setDetail(prev);
                      toast('Bulk save failed — changes rolled back');
                    });
                    setBulk({});
                    toast(`${bulkKeys.length} tickets assigned to ${who}`);
                  }}
                  style={{ border: '1px solid var(--line2)', background: 'var(--bg)', color: 'var(--tx)', borderRadius: 3, padding: '4px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                >
                  <option value="">Assign to…</option>
                  {(detail?.team ?? []).map((m) => (
                    <option key={m.id} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button onClick={() => setBulk({})} style={{ border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 11, cursor: 'pointer' }}>
                  Clear
                </button>
              </>
            )}
          </div>

          {proposedTickets.length > 0 && (
            <div style={{ flex: 'none', margin: '0 22px 10px', border: '1px dashed var(--agent)', borderRadius: 4, background: 'var(--agentsoft)', padding: '9px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ ...mono(500, 10), color: 'var(--agent)', letterSpacing: '.08em' }}>◆ AGENT PROPOSED — REVIEW BEFORE BOARD ENTRY</span>
                <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{proposedTickets.length} pending</span>
              </div>
              <div style={{ display: 'flex', gap: 10, overflowX: 'auto' }}>
                {proposedTickets.map((t) => (
                  <div key={t.key} style={{ flex: 'none', width: 290, border: '1px dashed var(--agent)', borderRadius: 3, background: 'var(--bg2)', padding: '10px 12px' }}>
                    <div onClick={() => openTicket(t.key)} style={{ cursor: 'pointer' }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ ...mono(500, 10), color: 'var(--tx3)' }}>{t.key}</span>
                        <span style={{ ...mono(400, 10), color: 'var(--agent)' }}>{t.sources[0]?.type ?? ''}</span>
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.35 }}>{t.title}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 9, alignItems: 'center' }}>
                      {lead ? (
                        <>
                          <button
                            onClick={() => acceptTicket(t)}
                            style={{ border: '1px solid var(--ok)', background: 'none', color: 'var(--ok)', borderRadius: 3, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                          >
                            Accept
                          </button>
                          <button onClick={() => dismissTicket(t)} style={{ border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 11, cursor: 'pointer' }}>
                            Dismiss
                          </button>
                        </>
                      ) : (
                        <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>LEAD REVIEW REQUIRED</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {boardMode === 'kanban' && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 22px 20px' }}>
              {tickets.filter((t) => t.status !== 'proposed' && t.status !== 'dismissed').length === 0 && (
                <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '16px 18px', marginBottom: 12, fontSize: 12.5, color: 'var(--tx2)' }}>
                  No tickets on the board yet{proposedTickets.length > 0 ? ' — accept proposed tickets above to seed it.' : '.'}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(250px,1fr))', gap: 12, minWidth: 1040, height: '100%' }}>
                {COLS.map(([k, label]) => {
                  const colTickets = tickets.filter((t) => t.status === k);
                  return (
                    <div
                      key={k}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOverCol(k);
                      }}
                      onDragLeave={() => setDragOverCol((c) => (c === k ? null : c))}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverCol(null);
                        const key = drag.current;
                        drag.current = null;
                        if (!key) return;
                        const t = tickets.find((x) => x.key === key);
                        if (!t || t.status === k) return;
                        setTicket(key, { status: k });
                      }}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                        background: 'var(--bg)',
                        border: `1px solid ${dragOverCol === k ? 'var(--acc)' : 'var(--line)'}`,
                        borderRadius: 4,
                      }}
                    >
                      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '1px solid var(--line)' }}>
                        <span style={{ ...mono(500, 10), letterSpacing: '.1em', color: 'var(--tx2)' }}>{label}</span>
                        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{colTickets.length}</span>
                      </div>
                      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {colTickets.map(ticketCard)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {boardMode === 'table' && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 22px 20px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--line)', background: 'var(--bg2)' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 34 }}></th>
                    <th style={thStyle}>KEY</th>
                    <th style={thStyle}>TITLE</th>
                    <th style={thStyle}>STATUS</th>
                    <th style={thStyle}>ASSIGNEE</th>
                    <th style={thStyle}>EST</th>
                    <th style={thStyle}>WORKSTREAM</th>
                    <th style={thStyle}>SOURCE</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets
                    .filter((t) => t.status !== 'proposed' && t.status !== 'dismissed')
                    .map((t) => (
                      <tr key={t.key} style={{ background: bulk[t.key] ? 'var(--accsoft)' : 'transparent' }}>
                        <td style={{ ...tdBase, textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={!!bulk[t.key]}
                            onChange={() => setBulk((b) => ({ ...b, [t.key]: !b[t.key] }))}
                            style={{ accentColor: 'var(--acc)', cursor: 'pointer' }}
                          />
                        </td>
                        <td style={{ ...tdBase, ...mono(400, 11), color: 'var(--tx3)', whiteSpace: 'nowrap' }}>{t.key}</td>
                        <td onClick={() => openTicket(t.key)} style={{ ...tdBase, fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}>
                          {t.title}
                          {t.agent && (
                            <span style={{ marginLeft: 7, ...mono(500, 9), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '1px 4px' }}>◆</span>
                          )}
                        </td>
                        <td style={tdBase}>
                          <select
                            value={t.status}
                            onChange={(e) => setTicket(t.key, { status: e.target.value as TicketStatus })}
                            style={{ background: 'var(--bg)', border: '1px solid var(--line2)', color: 'var(--tx)', borderRadius: 3, padding: '3px 6px', fontSize: 11.5, cursor: 'pointer' }}
                          >
                            <option value="backlog">Backlog</option>
                            <option value="progress">In Progress</option>
                            <option value="review">In Review</option>
                            <option value="done">Done</option>
                          </select>
                        </td>
                        <td style={{ ...tdBase, whiteSpace: 'nowrap' }}>
                          <select
                            value={t.assignee}
                            onChange={(e) => setTicket(t.key, { assignee: e.target.value })}
                            style={{ background: 'var(--bg)', border: '1px solid var(--line2)', color: 'var(--tx2)', borderRadius: 3, padding: '3px 6px', fontSize: 11.5, cursor: 'pointer', maxWidth: 130 }}
                          >
                            {[...new Set(['—', ...(detail?.team.map((m) => m.name) ?? []), t.assignee])].map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ ...tdBase, ...mono(400, 11), color: 'var(--tx2)' }}>{t.est}</td>
                        <td style={{ ...tdBase, fontSize: 12, color: 'var(--tx2)', whiteSpace: 'nowrap' }}>{t.workstream}</td>
                        <td style={{ ...tdBase, ...mono(400, 10.5), color: 'var(--agent)', whiteSpace: 'nowrap' }}>{t.sources[0]?.type ?? ''}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ===== ROADMAP ===== */}
      {detail && tab === 'roadmap' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '20px 24px 26px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>Roadmap</span>
              <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>
                {eng.sowStatus === 'BRIEF' ? 'DERIVED FROM PROJECT BRIEF' : 'DERIVED FROM SOW'} · AGENT-MAINTAINED
              </span>
            </div>
            {!eng.phases && <div style={{ color: 'var(--tx3)', fontSize: 12.5 }}>No phase schedule captured for this engagement yet.</div>}
            {eng.phases && (
              <div style={{ position: 'relative' }}>
                <div style={{ display: 'flex', marginLeft: 190, borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                  {months.map((m) => (
                    <div key={m.label + m.l} style={{ flex: 1, ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
                      {m.label}
                    </div>
                  ))}
                </div>
                <div style={{ position: 'absolute', top: 24, bottom: 0, left: 190, right: 0, pointerEvents: 'none' }}>
                  {months.map((m) => (
                    <div key={`l${m.l}`} style={{ position: 'absolute', top: 0, bottom: 0, left: `${m.l}%`, width: 1, background: 'var(--line)' }} />
                  ))}
                  <div style={{ position: 'absolute', top: -24, bottom: 0, left: `${Math.max(3, pct(rmS, rmE, todayIso()))}%`, width: 1, background: 'var(--acc)' }} />
                  <div
                    style={{
                      position: 'absolute',
                      top: -24,
                      left: `${Math.max(3, pct(rmS, rmE, todayIso()))}%`,
                      transform: 'translateX(-50%)',
                      background: 'var(--acc)',
                      color: '#fff',
                      ...mono(500, 9),
                      padding: '1px 6px',
                      borderRadius: 2,
                      letterSpacing: '.06em',
                    }}
                  >
                    TODAY
                  </div>
                </div>
                <div style={{ paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {eng.phases.map((p) => {
                    const l = pct(rmS, rmE, p.s);
                    const w = pct(rmS, rmE, p.e) - l;
                    const done = p.pct === 100;
                    const active = (p.pct ?? 0) > 0 && (p.pct ?? 0) < 100;
                    return (
                      <div key={p.name} style={{ display: 'flex', alignItems: 'center' }}>
                        <div style={{ width: 190, flex: 'none', paddingRight: 16 }}>
                          <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.name}</div>
                          <div style={{ ...mono(400, 10), color: 'var(--tx3)', marginTop: 2 }}>
                            {fmtD(p.s)} – {fmtD(p.e)} · {p.pct ?? 0}% COMPLETE
                          </div>
                        </div>
                        <div style={{ flex: 1, height: 26, position: 'relative' }}>
                          <div
                            style={{
                              position: 'absolute',
                              top: 3,
                              bottom: 3,
                              left: `${l}%`,
                              width: `${w}%`,
                              background: 'var(--bg3)',
                              border: `1px solid ${done ? 'var(--line2)' : active ? 'var(--acc)' : 'var(--line2)'}`,
                              borderRadius: 3,
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                position: 'absolute',
                                top: 0,
                                bottom: 0,
                                left: 0,
                                width: `${p.pct ?? 0}%`,
                                background: done ? 'var(--line2)' : active ? 'var(--accsoft)' : 'transparent',
                              }}
                            />
                            <span
                              style={{
                                position: 'absolute',
                                left: 8,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                ...mono(500, 9),
                                color: done ? 'var(--tx2)' : active ? 'var(--acc)' : 'var(--tx3)',
                                letterSpacing: '.06em',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {done ? 'DONE' : active ? `${p.pct}%` : 'PLANNED'}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {eng.milestones && (
                  <div style={{ marginTop: 20, borderTop: '1px solid var(--line)', paddingTop: 14, display: 'flex' }}>
                    <div style={{ width: 190, flex: 'none', ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>MILESTONES</div>
                    <div style={{ flex: 1, height: 92, position: 'relative' }}>
                      {eng.milestones.map((ms, i) => {
                        const p = Math.max(1, Math.min(99, pct(rmS, rmE, ms.d)));
                        // Near either edge, grow the label inward instead of
                        // centering (centered labels clip at the container edge).
                        const nearRight = p > 85;
                        const nearLeft = p < 8;
                        const align = nearRight ? 'flex-end' : nearLeft ? 'flex-start' : 'center';
                        const tx = nearRight ? 'translateX(-100%)' : nearLeft ? 'none' : 'translateX(-50%)';
                        return (
                          <div
                            key={ms.label + ms.d}
                            title={`${ms.label} · ${fmtD(ms.d)}`}
                            style={{
                              position: 'absolute',
                              left: `${p}%`,
                              top: i % 2 === 0 ? 0 : 38,
                              transform: tx,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: align,
                              gap: 4,
                              maxWidth: 300,
                            }}
                          >
                            <div
                              style={{
                                width: 9,
                                height: 9,
                                flex: 'none',
                                transform: 'rotate(45deg)',
                                background: ms.done ? 'var(--ok)' : 'var(--bg2)',
                                border: `1.5px solid ${ms.done ? 'var(--ok)' : 'var(--tx3)'}`,
                              }}
                            />
                            <div
                              style={{
                                ...mono(400, 9),
                                color: ms.done ? 'var(--tx2)' : 'var(--tx)',
                                whiteSpace: 'nowrap',
                                maxWidth: 300,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {ms.label.toUpperCase()}
                            </div>
                            <div style={{ ...mono(400, 9), color: 'var(--tx3)' }}>{fmtD(ms.d)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== SOURCES ===== */}
      {detail && tab === 'sources' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
          <RepoCard engId={eng.id} lead={lead} toast={toast} refreshDetail={refreshDetail} />
          <table style={{ width: '100%', borderCollapse: 'collapse', border: '1px solid var(--line)', background: 'var(--bg2)' }}>
            <thead>
              <tr>
                <th style={thStyle}>SOURCE</th>
                <th style={thStyle}>TYPE</th>
                <th style={thStyle}>STATUS</th>
                <th style={thStyle}>LAST SYNC</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>LINKED TICKETS</th>
              </tr>
            </thead>
            <tbody>
              {detail.sources.length === 0 && (
                <tr>
                  <td colSpan={5} style={tdBase}>
                    <Empty label="No document sources yet — engagements created from a SOW list the document here." />
                  </td>
                </tr>
              )}
              {detail.sources.map((sr) => (
                <tr key={sr.id} className="hv-row">
                  <td style={{ ...tdBase, fontSize: 12.5, fontWeight: 500 }}>{sr.name}</td>
                  <td style={{ ...tdBase, ...mono(400, 10.5), color: 'var(--tx2)' }}>{sr.type}</td>
                  <td style={tdBase}>
                    <span style={{ ...mono(500, 10), color: `var(--${sr.statusColor})`, letterSpacing: '.06em' }}>{sr.status}</span>
                  </td>
                  <td style={{ ...tdBase, ...mono(400, 11), color: 'var(--tx2)' }}>{sr.lastSync}</td>
                  <td style={{ ...tdBase, ...mono(400, 11), color: 'var(--agent)', textAlign: 'right' }}>{sr.linked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ===== TEAM ===== */}
      {detail && tab === 'team' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px', display: 'grid', gridTemplateColumns: '1fr 360px', gap: 14, alignItems: 'start' }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
              SKILL MATRIX × CURRENT LOAD
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>PERSON</th>
                  {SKILL_COLS.map((sk) => (
                    <th key={sk} style={{ ...thStyle, textAlign: 'center' }}>
                      {sk}
                    </th>
                  ))}
                  <th style={{ ...thStyle, width: 130 }}>LOAD</th>
                </tr>
              </thead>
              <tbody>
                {detail.team.length === 0 && (
                  <tr>
                    <td colSpan={SKILL_COLS.length + 2} style={tdBase}>
                      <Empty label="No one is staffed on this engagement yet — an admin assigns people on the Admin page." />
                    </td>
                  </tr>
                )}
                {detail.team.map((p) => {
                  const loadColor = p.load > 90 ? 'var(--bad)' : p.load > 75 ? 'var(--warn)' : 'var(--ok)';
                  return (
                    <tr key={p.id} className="hv-row">
                      <td style={tdBase}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{p.name}</div>
                        <div style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{p.role}</div>
                      </td>
                      {p.skills.map((lvl, i) => (
                        <td key={SKILL_COLS[i] ?? `s${i}`} style={{ ...tdBase, textAlign: 'center' }}>
                          <div style={{ display: 'inline-flex', gap: 2 }}>
                            {[0, 1, 2].map((b) => (
                              <span key={b} style={{ width: 5, height: 12, borderRadius: 1, background: lvl > b ? 'var(--tx2)' : 'var(--bg3)' }} />
                            ))}
                          </div>
                        </td>
                      ))}
                      <td style={tdBase}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 5, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${p.load}%`, background: loadColor }} />
                          </div>
                          <span style={{ ...mono(400, 10), color: loadColor }}>{p.load}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ ...mono(500, 10), color: 'var(--agent)', letterSpacing: '.08em' }}>◆ SUGGESTED ASSIGNMENTS</div>
            {detail.suggestions.length === 0 && (
              <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)' }}>
                <Empty label="No assignment suggestions right now." />
              </div>
            )}
            {detail.suggestions.map((sg) => (
              <div key={sg.id} style={{ border: '1px dashed var(--agent)', borderRadius: 4, background: 'var(--bg2)', padding: '12px 14px' }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
                  {sg.ticket} → {sg.person}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.45, marginBottom: 9 }}>{sg.rationale}</div>
                {!sg.decision && !lead && (
                  <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>LEAD DECISION</span>
                )}
                {!sg.decision && lead && (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      onClick={() => {
                        const prev = detail;
                        setDetail((d) =>
                          d
                            ? {
                                ...d,
                                suggestions: d.suggestions.map((x) => (x.id === sg.id ? { ...x, decision: 'acc' } : x)),
                                tickets: d.tickets.map((t) => (t.key === sg.ticket ? { ...t, assignee: sg.person } : t)),
                              }
                            : d,
                        );
                        api
                          .decideSuggestion(sg.id, 'acc')
                          .then(refreshDetail)
                          .catch(() => {
                            setDetail(prev);
                            toast('Save failed — decision rolled back');
                          });
                        toast(`${sg.ticket} assigned to ${sg.person}`);
                      }}
                      style={{ border: '1px solid var(--ok)', background: 'none', color: 'var(--ok)', borderRadius: 3, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => {
                        const prev = detail;
                        setDetail((d) => (d ? { ...d, suggestions: d.suggestions.map((x) => (x.id === sg.id ? { ...x, decision: 'ovr' } : x)) } : d));
                        api
                          .decideSuggestion(sg.id, 'ovr')
                          .then(refreshDetail)
                          .catch(() => {
                            setDetail(prev);
                            toast('Save failed — decision rolled back');
                          });
                      }}
                      style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '4px 12px', fontSize: 11, cursor: 'pointer' }}
                    >
                      Override
                    </button>
                  </div>
                )}
                {sg.decision === 'acc' && <span style={{ ...mono(500, 10), color: 'var(--ok)' }}>✓ ASSIGNED</span>}
                {sg.decision === 'ovr' && <span style={{ ...mono(500, 10), color: 'var(--tx3)' }}>OVERRIDDEN — PICK IN BOARD</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== STATUS FEED ===== */}
      {detail && tab === 'feed' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px', display: 'grid', gridTemplateColumns: '1fr 400px', gap: 14, alignItems: 'start' }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
              ACTIVITY — EVERY AGENT ACTION IS ATTRIBUTABLE AND REVERSIBLE
            </div>
            {detail.feed.length === 0 && <Empty label="No activity yet — agent actions and status pushes land here." />}
            {detail.feed.map((f) => (
              <div key={f.id} className="hv-bg" style={{ display: 'flex', gap: 12, padding: 'var(--rowpad)', borderBottom: '1px solid var(--line)', alignItems: 'flex-start' }}>
                <span
                  style={{
                    flex: 'none',
                    marginTop: 2,
                    ...mono(500, 9),
                    borderRadius: 2,
                    padding: '2px 6px',
                    background: f.actor === 'AGENT' ? 'var(--agentsoft)' : 'var(--bg3)',
                    color: f.actor === 'AGENT' ? 'var(--agent)' : 'var(--tx2)',
                    letterSpacing: '.06em',
                  }}
                >
                  {f.actor}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>{f.text}</div>
                  <div style={{ display: 'flex', gap: 8, ...mono(400, 10), color: 'var(--tx3)', marginTop: 3 }}>
                    <span>{f.timeLabel}</span>
                    {f.source && <span style={{ color: 'var(--agent)' }}>{f.source}</span>}
                  </div>
                </div>
                {f.reversible && lead && revertConfirm !== f.id && (
                  <button
                    className="hv-bad"
                    onClick={() => setRevertConfirm(f.id)}
                    style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 10), cursor: 'pointer', padding: '2px 4px' }}
                  >
                    REVERT
                  </button>
                )}
                {f.reversible && lead && revertConfirm === f.id && (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <button
                      onClick={() => {
                        setRevertConfirm(null);
                        const prev = detail;
                        setDetail((d) => (d ? { ...d, feed: d.feed.filter((x) => x.id !== f.id) } : d));
                        api
                          .revertFeed(f.id)
                          .then(() => {
                            toast('Reverted — change undone and logged');
                            refreshDetail();
                          })
                          .catch(() => {
                            setDetail(prev);
                            toast('Revert failed');
                          });
                      }}
                      style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '2px 8px', ...mono(500, 10), cursor: 'pointer' }}
                    >
                      CONFIRM
                    </button>
                    <button
                      onClick={() => setRevertConfirm(null)}
                      style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 10), cursor: 'pointer' }}
                    >
                      CANCEL
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ ...mono(500, 10), background: 'var(--agentsoft)', color: 'var(--agent)', borderRadius: 2, padding: '2px 7px', letterSpacing: '.06em' }}>◆ AGENT DRAFT</span>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Weekly status update</span>
            </div>
            <textarea
              value={composerText}
              readOnly={!lead}
              onChange={(e) => {
                setComposer(e.target.value);
                setSavedAt(null);
                scheduleComposerSave(e.target.value);
              }}
              onBlur={() => {
                if (composer !== null && composer !== eng.composer) {
                  clearTimeout(saveTimer.current);
                  api
                    .saveComposer(eng.id, composer)
                    .then(() => {
                      setSavedAt(new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }));
                      onEngagementChanged();
                    })
                    .catch(() => toast('Draft save failed'));
                }
              }}
              rows={11}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: 'var(--bg)',
                border: '1px solid var(--line2)',
                borderRadius: 3,
                color: 'var(--tx)',
                padding: '10px 12px',
                fontSize: 12.5,
                lineHeight: 1.55,
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>→ Teams delivery channel</span>
              {savedAt && <span style={{ ...mono(400, 10), color: 'var(--ok)' }}>SAVED {savedAt}</span>}
              <div style={{ flex: 1 }} />
              {!lead && <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>LEAD SENDS THIS</span>}
              {lead && (
              <>
              <button
                className="hv-bg"
                disabled={drafting}
                onClick={() => {
                  setDrafting(true);
                  api
                    .generateDraft(eng.id)
                    .then(({ text }) => {
                      setComposer(text);
                      setPushed(false);
                      toast('Draft regenerated from latest board state');
                    })
                    .catch(() => toast('Draft generation failed — model endpoint unavailable'))
                    .finally(() => setDrafting(false));
                }}
                style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '5px 12px', fontSize: 11.5, cursor: 'pointer', opacity: drafting ? 0.5 : 1 }}
              >
                {drafting ? 'Drafting…' : 'Regenerate'}
              </button>
              {!isPushed && !pushConfirm && (
                <button
                  className="hv-bright"
                  onClick={() => setPushConfirm(true)}
                  style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '6px 14px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}
                >
                  Push to Teams
                </button>
              )}
              {!isPushed && pushConfirm && (
                <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ ...mono(400, 10), color: 'var(--tx2)' }}>Send to the client channel?</span>
                  <button
                    disabled={pushing}
                    onClick={() => {
                      setPushing(true);
                      api
                        .pushComposer(eng.id)
                        .then(() => {
                          setPushed(true);
                          setPushConfirm(false);
                          toast('Posted to Teams delivery channel');
                          onEngagementChanged();
                          refreshDetail();
                        })
                        .catch(() => toast('Push failed — draft not sent'))
                        .finally(() => setPushing(false));
                    }}
                    style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '6px 14px', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', opacity: pushing ? 0.6 : 1 }}
                  >
                    {pushing ? 'Sending…' : 'Confirm push'}
                  </button>
                  <button
                    disabled={pushing}
                    onClick={() => setPushConfirm(false)}
                    style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '5px 10px', fontSize: 11.5, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </span>
              )}
              </>
              )}
              {isPushed && <span style={{ ...mono(500, 10), color: 'var(--ok)' }}>✓ PUSHED</span>}
            </div>
          </div>
        </div>
      )}

      {newTicket && (
        <NewTicketModal
          engId={eng.id}
          team={(detail?.team ?? []).map((m) => m.name)}
          toast={toast}
          onClose={() => setNewTicket(false)}
          onCreated={(t) => {
            setNewTicket(false);
            setDetail((d) => (d ? { ...d, tickets: [...d.tickets, t] } : d));
            toast(`${t.key} created`);
          }}
        />
      )}
    </div>
  );
}

/** Modal for creating a ticket manually — lands in Backlog alongside agent-seeded work. */
function NewTicketModal({
  engId,
  team,
  toast,
  onClose,
  onCreated,
}: {
  engId: string;
  team: string[];
  toast: (msg: string) => void;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('—');
  const [est, setEst] = useState('');
  const [workstream, setWorkstream] = useState('');
  const [creating, setCreating] = useState(false);

  const inputStyle: React.CSSProperties = {
    boxSizing: 'border-box',
    width: '100%',
    background: 'var(--bg)',
    border: '1px solid var(--line2)',
    borderRadius: 3,
    color: 'var(--tx)',
    padding: '7px 10px',
    fontSize: 12.5,
    fontFamily: 'inherit',
  };
  const labelStyle: React.CSSProperties = { ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 5 };

  const create = () => {
    if (!title.trim() || creating) return;
    setCreating(true);
    api
      .createTicket(engId, {
        title: title.trim(),
        description: description.trim() || undefined,
        assignee: assignee === '—' ? undefined : assignee,
        est: est.trim() || undefined,
        workstream: workstream.trim() || undefined,
      })
      .then(onCreated)
      .catch((e: Error) => toast(`Create failed — ${e.message}`))
      .finally(() => setCreating(false));
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 40 }} />
      <div
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') create();
        }}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%,-50%)',
          width: 460,
          maxWidth: 'calc(100vw - 40px)',
          background: 'var(--bg2)',
          border: '1px solid var(--line)',
          borderRadius: 4,
          zIndex: 41,
          boxShadow: '0 12px 40px rgba(0,0,0,.45)',
          animation: 'eec-fadeUp .15s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '13px 18px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ ...mono(500, 11), letterSpacing: '.1em', color: 'var(--tx2)' }}>NEW TICKET</span>
          <button
            className="hv-tx"
            onClick={onClose}
            style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 16, cursor: 'pointer', padding: '2px 6px' }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <div>
            <div style={labelStyle}>TITLE</div>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to get done?" style={inputStyle} />
          </div>
          <div>
            <div style={labelStyle}>DESCRIPTION</div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Context, scope, links… (optional)"
              style={{ ...inputStyle, lineHeight: 1.5, resize: 'vertical' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <div style={labelStyle}>ASSIGNEE</div>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                {[...new Set(['—', ...team])].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={labelStyle}>ESTIMATE</div>
              <input value={est} onChange={(e) => setEst(e.target.value)} placeholder="e.g. 3d" style={inputStyle} />
            </div>
            <div>
              <div style={labelStyle}>WORKSTREAM</div>
              <input value={workstream} onChange={(e) => setWorkstream(e.target.value)} placeholder="Optional" style={inputStyle} />
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '13px 18px', borderTop: '1px solid var(--line)' }}>
          <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>LANDS IN BACKLOG · ⌘↵ TO CREATE</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '7px 14px', fontSize: 12, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!title.trim() || creating}
            style={{
              background: 'var(--acc)',
              color: '#fff',
              border: 'none',
              borderRadius: 3,
              padding: '7px 16px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              opacity: !title.trim() || creating ? 0.45 : 1,
            }}
          >
            {creating ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </div>
    </>
  );
}

/** Git repository connection card on the Sources tab. */
function RepoCard({
  engId,
  lead,
  toast,
  refreshDetail,
}: {
  engId: string;
  lead: boolean;
  toast: (msg: string) => void;
  refreshDetail: () => void;
}) {
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);

  const fetchRepo = () => {
    api
      .repo(engId)
      .then((r) => {
        setRepo(r);
        setLoadState('ready');
      })
      .catch(() => setLoadState('error'));
  };

  const load = () => {
    setLoadState('loading');
    fetchRepo();
  };

  // Initial state is already 'loading'; the effect only starts the fetch.
  useEffect(fetchRepo, [engId]);

  const connect = () => {
    if (!url.trim() || !token.trim() || connecting) return;
    setConnecting(true);
    api
      .connectRepo(engId, url.trim(), token.trim())
      .then(() => {
        toast('Repository connected — first sync complete');
        setUrl('');
        setToken('');
        load();
        refreshDetail();
      })
      .catch((e: Error) => toast(e.message))
      .finally(() => setConnecting(false));
  };

  const syncNow = () => {
    if (syncing) return;
    setSyncing(true);
    api
      .syncRepo(engId)
      .then((r) => {
        toast(`Synced — ${r.commits} new commit${r.commits === 1 ? '' : 's'}, ${r.prs} PR update${r.prs === 1 ? '' : 's'}`);
        load();
        refreshDetail();
      })
      .catch((e: Error) => toast(`Sync failed: ${e.message}`))
      .finally(() => setSyncing(false));
  };

  const conn = repo?.connection ?? null;
  const openPrs = (repo?.prs ?? []).filter((p) => p.state === 'open');

  const inputStyle: React.CSSProperties = {
    boxSizing: 'border-box',
    background: 'var(--bg)',
    border: '1px solid var(--line2)',
    borderRadius: 3,
    color: 'var(--tx)',
    padding: '7px 10px',
    fontSize: 12.5,
  };

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>REPOSITORY</span>
        {conn && (
          <span style={{ ...mono(500, 9), border: '1px solid var(--line2)', color: 'var(--tx2)', borderRadius: 2, padding: '1px 6px', letterSpacing: '.06em' }}>
            {conn.provider === 'github' ? 'GITHUB' : 'AZURE DEVOPS'}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {conn && (
          <button
            onClick={syncNow}
            disabled={syncing}
            style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx)', borderRadius: 3, padding: '4px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: syncing ? 0.5 : 1 }}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        {conn && lead && !disconnectConfirm && (
          <button
            className="hv-bad"
            onClick={() => setDisconnectConfirm(true)}
            style={{ border: 'none', background: 'none', color: 'var(--tx3)', ...mono(400, 10), cursor: 'pointer', letterSpacing: '.06em' }}
          >
            DISCONNECT
          </button>
        )}
        {conn && lead && disconnectConfirm && (
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              onClick={() => {
                api
                  .disconnectRepo(engId)
                  .then(() => {
                    toast('Repository disconnected');
                    setDisconnectConfirm(false);
                    load();
                  })
                  .catch(() => toast('Disconnect failed'));
              }}
              style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '3px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
            >
              Confirm
            </button>
            <button
              onClick={() => setDisconnectConfirm(false)}
              style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '3px 8px', fontSize: 11, cursor: 'pointer' }}
            >
              Cancel
            </button>
          </span>
        )}
      </div>

      {loadState === 'loading' && <Empty label="Loading repository…" />}
      {loadState === 'error' && (
        <div style={{ padding: '14px', fontSize: 12, color: 'var(--tx3)', textAlign: 'center' }}>
          Couldn’t load the repository connection.{' '}
          <button onClick={load} style={{ border: 'none', background: 'none', color: 'var(--acc)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
            Retry
          </button>
        </div>
      )}

      {loadState === 'ready' && !conn && !lead && (
        <Empty label="No repository connected — an engagement lead can connect GitHub or Azure DevOps here." />
      )}

      {loadState === 'ready' && !conn && lead && (
        <div style={{ padding: '14px 16px' }}>
          <div style={{ fontSize: 12.5, color: 'var(--tx2)', marginBottom: 10, lineHeight: 1.5 }}>
            Connect the delivery repo to link commits and PRs to tickets by key (e.g. <span className="mono">ABC-104</span> in a branch or PR
            title). Opening a linked PR moves its ticket to Review; merging moves it to Done.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo or https://dev.azure.com/org/project/_git/repo"
              style={{ ...inputStyle, flex: '1 1 340px' }}
            />
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              type="password"
              placeholder="Access token (read-only scope)"
              autoComplete="off"
              style={{ ...inputStyle, flex: '1 1 180px' }}
            />
            <button
              onClick={connect}
              disabled={!url.trim() || !token.trim() || connecting}
              style={{
                background: 'var(--acc)',
                color: '#fff',
                border: 'none',
                borderRadius: 3,
                padding: '7px 16px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                opacity: !url.trim() || !token.trim() || connecting ? 0.45 : 1,
              }}
            >
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      {loadState === 'ready' && conn && (
        <div style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: repo && (repo.prs.length > 0 || repo.commits.length > 0) ? 12 : 0 }}>
            <a href={conn.repoUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600, color: 'var(--tx)', textDecoration: 'none' }}>
              {conn.repoName}
            </a>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{conn.defaultBranch}</span>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
              {openPrs.length} OPEN PR{openPrs.length === 1 ? '' : 'S'}
            </span>
            <span style={{ ...mono(400, 10), color: conn.status === 'error' ? 'var(--bad)' : 'var(--ok)', letterSpacing: '.06em' }}>
              {conn.status === 'error' ? 'SYNC ERROR' : 'CONNECTED'}
            </span>
            {conn.lastSyncAt && (
              <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>
                SYNCED{' '}
                {new Date(conn.lastSyncAt).toLocaleString('en', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).toUpperCase()}
              </span>
            )}
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>TOKEN {conn.tokenHint}</span>
          </div>
          {conn.status === 'error' && conn.lastError && (
            <div style={{ fontSize: 12, color: 'var(--bad)', marginBottom: 10 }}>{conn.lastError}</div>
          )}
          {repo && (repo.prs.length > 0 || repo.commits.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>PULL REQUESTS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {repo.prs.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>None synced yet.</span>}
                  {repo.prs.slice(0, 6).map((pr) => (
                    <a
                      key={pr.number}
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--tx2)', textDecoration: 'none', minWidth: 0 }}
                    >
                      <span style={{ ...mono(500, 9), color: PR_STATE_COLOR[pr.state], flex: 'none' }}>{pr.state.toUpperCase()}</span>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        #{pr.number} {pr.title}
                      </span>
                      {pr.ticketKey && <span style={{ ...mono(400, 9), color: 'var(--agent)', flex: 'none' }}>{pr.ticketKey}</span>}
                    </a>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>RECENT COMMITS</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {repo.commits.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--tx3)' }}>None synced yet.</span>}
                  {repo.commits.slice(0, 6).map((c) => (
                    <a
                      key={c.sha}
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--tx2)', textDecoration: 'none', minWidth: 0 }}
                    >
                      <span style={{ ...mono(400, 9), color: 'var(--tx3)', flex: 'none' }}>{c.sha.slice(0, 7)}</span>
                      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.message.split('\n')[0]}</span>
                      {c.ticketKey && <span style={{ ...mono(400, 9), color: 'var(--agent)', flex: 'none' }}>{c.ticketKey}</span>}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
