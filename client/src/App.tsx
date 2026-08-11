import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { api } from './api';
import type { Engagement, EngagementDetail, Me, TicketStatus } from './types';
import { mono, STATUS_LABEL } from './util';
import { Admin } from './components/Admin';
import { Portfolio } from './components/Portfolio';
import { Setup } from './components/Setup';
import { Workspace } from './components/Workspace';
import { TicketDrawer } from './components/TicketDrawer';
import { Palette, type PaletteItem } from './components/Palette';

type Route = 'portfolio' | 'setup' | 'workspace' | 'admin';
export type Tab = 'board' | 'roadmap' | 'analytics' | 'sources' | 'team' | 'feed';

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem('eec-theme') as 'dark' | 'light') ?? 'dark',
  );
  const [route, setRoute] = useState<Route>('portfolio');
  const [engId, setEngId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('board');
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [detail, setDetail] = useState<EngagementDetail | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [toast, setToastMsg] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    clearTimeout(toastTimer.current);
    setToastMsg(msg);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2800);
  }, []);

  const refreshEngagements = useCallback(() => {
    return api
      .engagements()
      .then((rows) => {
        setEngagements(rows);
        setLoadError(null);
        setLastSync(new Date());
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const loadMe = useCallback(() => {
    void api
      .me()
      .then((m) => {
        setMe(m);
        setMeError(false);
      })
      .catch(() => {
        // Least privilege until the lookup succeeds; the top bar surfaces a retry.
        setMe({ email: 'unknown', role: 'developer', leadOf: [] });
        setMeError(true);
      });
  }, []);

  useEffect(() => {
    void refreshEngagements();
    loadMe();
  }, [refreshEngagements, loadMe]);

  const refreshDetail = useCallback(() => {
    if (!engId) return;
    void api
      .detail(engId)
      .then((d) => {
        setDetail(d);
        setDetailError(null);
      })
      .catch((e: Error) => setDetailError(e.message));
  }, [engId]);

  useEffect(() => {
    if (route !== 'workspace' || !engId) return;
    let stale = false;
    api
      .detail(engId)
      .then((d) => {
        if (!stale) {
          setDetail(d);
          setDetailError(null);
        }
      })
      .catch((e: Error) => {
        if (!stale) setDetailError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [route, engId]);

  useEffect(() => {
    localStorage.setItem('eec-theme', theme);
  }, [theme]);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === 'Escape') {
        // Close the topmost layer only.
        setPalette((p) => {
          if (!p) setDetailKey(null);
          return false;
        });
      }
    };
    window.addEventListener('keydown', kd);
    return () => window.removeEventListener('keydown', kd);
  }, []);

  const eng = useMemo(() => engagements.find((e) => e.id === engId) ?? null, [engagements, engId]);

  const isAdmin = me?.role === 'admin';
  const canCreate = isAdmin || me?.role === 'lead';
  const canLead = useCallback(
    (id: string) => isAdmin || (me?.role === 'lead' && me.leadOf.includes(id)),
    [isAdmin, me],
  );

  const openEngagement = useCallback((id: string, toTab: Tab = 'board') => {
    setEngId(id);
    setTab(toTab);
    setDetail(null);
    setDetailError(null);
    setDetailKey(null);
    setRoute('workspace');
  }, []);

  const goPortfolio = useCallback(() => {
    setRoute('portfolio');
    setDetailKey(null);
    void refreshEngagements();
  }, [refreshEngagements]);

  // ---- ticket mutations shared by board + drawer ----
  // Optimistic with rollback: the previous field values are restored on failure.
  const setTicket = useCallback((key: string, patch: { status?: TicketStatus; assignee?: string }) => {
    let prev: { status: TicketStatus; assignee: string } | null = null;
    setDetail((d) => {
      const t = d?.tickets.find((x) => x.key === key);
      if (t) prev = { status: t.status, assignee: t.assignee };
      return d ? { ...d, tickets: d.tickets.map((x) => (x.key === key ? { ...x, ...patch } : x)) } : d;
    });
    api.patchTicket(key, patch).catch((e: Error) => {
      setDetail((d) => (d && prev ? { ...d, tickets: d.tickets.map((x) => (x.key === key ? { ...x, ...prev } : x)) } : d));
      showToast(`Save failed — ${e.message}`);
    });
  }, [showToast]);

  const detailTicket = detail?.tickets.find((t) => t.key === detailKey) ?? null;
  // Latest agent task for the open ticket (agentTasks arrive newest-first).
  const detailAgentTask = detailTicket ? (detail?.agentTasks.find((a) => a.ticketKey === detailTicket.key) ?? null) : null;

  const queueForAgent = useCallback(
    (key: string, instructions: string) => {
      api
        .queueTicket(key, instructions || undefined)
        .then(() => {
          showToast(`${key} queued for agent work`);
          refreshDetail();
        })
        .catch((e: Error) => showToast(`Queue failed — ${e.message}`));
    },
    [showToast, refreshDetail],
  );

  const cancelAgent = useCallback(
    (key: string) => {
      api
        .cancelAgentTask(key)
        .then(() => {
          showToast(`Agent work on ${key} cancelled`);
          refreshDetail();
        })
        .catch((e: Error) => showToast(`Cancel failed — ${e.message}`));
    },
    [showToast, refreshDetail],
  );

  // ---- command palette ----
  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [
      { kind: 'NAV', label: 'Go to Portfolio', hint: 'G P', run: () => goPortfolio() },
      ...engagements.slice(0, 4).map((e) => ({
        kind: 'NAV',
        label: `${e.client} — open Board`,
        hint: '',
        run: () => openEngagement(e.id, 'board'),
      })),
      ...(canCreate ? [{ kind: 'ACTION', label: 'New engagement (from SOW or brief)', hint: '', run: () => setRoute('setup') }] : []),
      ...(isAdmin ? [{ kind: 'NAV', label: 'Open Admin — staffing & project lifecycle', hint: '', run: () => setRoute('admin') }] : []),
      ...(engagements[0]
        ? [
            {
              kind: 'NAV',
              label: `${engagements[0].client} — open Roadmap`,
              hint: '',
              run: () => openEngagement(engagements[0].id, 'roadmap'),
            },
            {
              kind: 'NAV',
              label: 'Open status feed',
              hint: '',
              run: () => openEngagement(engId ?? engagements[0].id, 'feed'),
            },
          ]
        : []),
      ...(detail?.tickets.slice(0, 6) ?? []).map((t) => ({
        kind: 'TICKET',
        label: `${t.key} — ${t.title}`,
        hint: STATUS_LABEL[t.status] ?? t.status,
        run: () => {
          setRoute('workspace');
          setDetailKey(t.key);
        },
      })),
    ];
    return items;
  }, [engagements, detail, engId, goPortfolio, openEngagement, canCreate, isAdmin]);

  return (
    <MotionConfig reducedMotion="user">
    <div
      className="eec"
      data-theme={theme}
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        color: 'var(--tx)',
        fontFamily: "'DM Sans', sans-serif",
        fontSize: 13,
        overflow: 'hidden',
      }}
    >
      {/* TOP BAR */}
      <div
        style={{
          height: 46,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 14px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg2)',
        }}
      >
        <div onClick={goPortfolio} style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
          <div style={{ width: 20, height: 20, background: 'var(--acc)', display: 'grid', placeItems: 'center', borderRadius: 2 }}>
            <span style={{ ...mono(700, 11), color: '#fff' }}>D</span>
          </div>
          <span style={{ ...mono(500, 12), letterSpacing: '.12em' }}>DATAVAIL</span>
          <span style={{ ...mono(400, 11), color: 'var(--tx3)', letterSpacing: '.1em' }}>[ DELIVERY CONSOLE ]</span>
        </div>
        <div style={{ flex: 1 }} />
        <div
          className="hv-border"
          onClick={() => setPalette(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            border: '1px solid var(--line2)',
            borderRadius: 3,
            padding: '5px 10px',
            cursor: 'pointer',
            color: 'var(--tx3)',
            minWidth: 220,
          }}
        >
          <span style={{ fontSize: 12 }}>Search or run a command</span>
          <span style={{ marginLeft: 'auto', ...mono(400, 10), border: '1px solid var(--line2)', borderRadius: 3, padding: '1px 5px' }}>
            Ctrl+K
          </span>
        </div>
        {lastSync && !loadError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: 'var(--ok)',
                animation: 'eec-pulse 2.4s infinite',
              }}
            />
            <span style={{ ...mono(400, 10), color: 'var(--tx2)', letterSpacing: '.06em' }}>
              SYNCED {lastSync.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}
            </span>
          </div>
        )}
        {meError && (
          <button
            onClick={loadMe}
            title="Your role couldn't be verified, so admin/lead actions are hidden. Click to retry."
            style={{
              ...mono(400, 10),
              background: 'none',
              border: '1px solid var(--warn)',
              color: 'var(--warn)',
              borderRadius: 3,
              padding: '3px 7px',
              cursor: 'pointer',
              letterSpacing: '.06em',
            }}
          >
            ROLE UNVERIFIED — RETRY
          </button>
        )}
        {isAdmin && (
        <button
          className="hv-tx2"
          onClick={() => setRoute('admin')}
          title="Staffing & project lifecycle"
          style={{
            ...mono(400, 10),
            background: 'none',
            border: `1px solid ${route === 'admin' ? 'var(--tx3)' : 'var(--line2)'}`,
            color: route === 'admin' ? 'var(--tx2)' : 'var(--tx3)',
            borderRadius: 3,
            padding: '3px 7px',
            cursor: 'pointer',
            letterSpacing: '.06em',
          }}
        >
          ADMIN
        </button>
        )}
        <button
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title="Toggle theme"
          style={{
            ...mono(400, 10),
            background: 'none',
            border: '1px solid var(--line2)',
            color: 'var(--tx3)',
            borderRadius: 3,
            padding: '3px 7px',
            cursor: 'pointer',
            letterSpacing: '.06em',
          }}
          className="hv-tx2"
        >
          {theme === 'dark' ? 'LIGHT' : 'DARK'}
        </button>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: 'var(--bg3)',
            border: '1px solid var(--line2)',
            display: 'grid',
            placeItems: 'center',
            ...mono(500, 10),
            color: 'var(--tx2)',
          }}
          title={me ? `${me.email} · ${me.role.toUpperCase()}` : ''}
        >
          {me && me.email.includes('@')
            ? me.email
                .split('@')[0]
                .split(/[._-]/)
                .filter(Boolean)
                .map((w) => w[0])
                .join('')
                .slice(0, 2)
                .toUpperCase()
            : '·'}
        </div>
      </div>

      {loadError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', background: 'var(--accsoft)', color: 'var(--bad)', ...mono(400, 11) }}>
          <span>COULDN’T LOAD ENGAGEMENTS: {loadError}</span>
          <button
            onClick={() => void refreshEngagements()}
            style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '2px 9px', ...mono(500, 10), cursor: 'pointer', letterSpacing: '.06em' }}
          >
            RETRY
          </button>
        </div>
      )}

      {route === 'portfolio' && (
        <Portfolio
          engagements={engagements}
          loading={loading}
          onOpen={openEngagement}
          onNew={() => setRoute('setup')}
          onDeleted={() => void refreshEngagements()}
          toast={showToast}
          canCreate={canCreate}
          canManage={canLead}
        />
      )}

      {route === 'admin' && isAdmin && <Admin goPortfolio={goPortfolio} toast={showToast} onChanged={() => void refreshEngagements()} />}
      {route === 'admin' && !isAdmin && (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--tx3)', ...mono(400, 11) }}>
          ADMIN ACCESS REQUIRED —{' '}
          <button onClick={goPortfolio} style={{ border: 'none', background: 'none', color: 'var(--acc)', ...mono(500, 11), cursor: 'pointer', padding: 0 }}>
            BACK TO PORTFOLIO
          </button>
        </div>
      )}

      {route === 'setup' && (
        <Setup
          goPortfolio={goPortfolio}
          toast={showToast}
          onCreated={(id) => {
            void refreshEngagements().then(() => openEngagement(id, 'roadmap'));
          }}
        />
      )}

      {route === 'workspace' && eng && (
        <Workspace
          key={eng.id}
          eng={eng}
          detail={detail}
          detailError={detailError}
          tab={tab}
          setTab={setTab}
          goPortfolio={goPortfolio}
          openTicket={setDetailKey}
          setTicket={setTicket}
          setDetail={setDetail}
          toast={showToast}
          onEngagementChanged={() => void refreshEngagements()}
          refreshDetail={refreshDetail}
          lead={canLead(eng.id)}
        />
      )}

      {detailTicket && (
        <TicketDrawer
          theme={theme}
          ticket={detailTicket}
          team={detail?.team.map((t) => t.name) ?? []}
          lead={eng ? canLead(eng.id) : false}
          agentTask={detailAgentTask}
          onQueueAgent={(instructions) => queueForAgent(detailTicket.key, instructions)}
          onCancelAgent={() => cancelAgent(detailTicket.key)}
          onAssign={(assignee) => setTicket(detailTicket.key, { assignee })}
          toast={showToast}
          refreshDetail={refreshDetail}
          onClose={() => setDetailKey(null)}
          onAccept={() => {
            setTicket(detailTicket.key, { status: 'backlog' });
            setDetailKey(null);
            showToast(`${detailTicket.key} accepted onto board`);
          }}
          onDismiss={() => {
            setTicket(detailTicket.key, { status: 'dismissed' });
            setDetailKey(null);
            showToast(`${detailTicket.key} dismissed`);
          }}
          onDelete={() => {
            const key = detailTicket.key;
            api
              .deleteTicket(key)
              .then(() => {
                setDetail((d) => (d ? { ...d, tickets: d.tickets.filter((t) => t.key !== key) } : d));
                setDetailKey(null);
                showToast(`${key} deleted`);
              })
              .catch((e: Error) => showToast(`Delete failed — ${e.message}`));
          }}
          goSources={() => {
            setTab('sources');
            setDetailKey(null);
          }}
        />
      )}

      {palette && <Palette theme={theme} items={paletteItems} onClose={() => setPalette(false)} />}

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast}
            data-theme={theme}
            initial={{ opacity: 0, transform: 'translateX(-50%) translateY(10px)' }}
            animate={{ opacity: 1, transform: 'translateX(-50%) translateY(0px)' }}
            exit={{ opacity: 0, transform: 'translateX(-50%) translateY(6px)' }}
            transition={{ type: 'spring', visualDuration: 0.25, bounce: 0.2 }}
            style={{
              position: 'fixed',
              bottom: 22,
              left: '50%',
              background: 'var(--bg3)',
              border: '1px solid var(--line2)',
              color: 'var(--tx)',
              borderRadius: 4,
              padding: '10px 18px',
              fontSize: 12.5,
              zIndex: 60,
              boxShadow: '0 8px 30px rgba(0,0,0,.4)',
            }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
