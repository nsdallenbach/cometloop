import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { TerminalPane, type TerminalOpenRequest } from './TerminalPane';

// Console client conventions: inline styles + theme tokens + mono() — see
// docs/development-standards.md "Client code". mono() mirrors client/src/util.ts.
const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

const NAV = [
  { id: 'tickets', label: 'Tickets', icon: '▤' },
  { id: 'agents', label: 'Agents', icon: '◆' },
  { id: 'identity', label: 'Identity', icon: '⛉' },
  { id: 'sync', label: 'Sync', icon: '⇅' },
  { id: 'deploys', label: 'Deploys', icon: '▲' },
] as const;

type NavId = (typeof NAV)[number]['id'];

function TitleBar() {
  const btn: CSSProperties = {
    width: 44,
    height: 34,
    border: 'none',
    background: 'transparent',
    color: 'var(--tx2)',
    fontSize: 12,
    cursor: 'pointer',
  };
  return (
    <div
      className="titlebar"
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 34,
        background: 'var(--bg2)',
        borderBottom: '1px solid var(--line)',
        paddingLeft: 12,
        gap: 8,
        flex: 'none',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--acc)' }} />
      <span style={{ ...mono(500, 11), color: 'var(--tx2)', letterSpacing: '.08em' }}>
        DELIVERY CONSOLE
      </span>
      <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>desktop</span>
      <div style={{ flex: 1 }} />
      <button style={btn} onClick={() => window.desktopBridge.windowControl('minimize')}>
        —
      </button>
      <button style={btn} onClick={() => window.desktopBridge.windowControl('maximize')}>
        ▢
      </button>
      <button
        style={{ ...btn, fontSize: 14 }}
        onClick={() => window.desktopBridge.windowControl('close')}
      >
        ×
      </button>
    </div>
  );
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ padding: 28 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)', maxWidth: 520, lineHeight: 1.5 }}>
        {note}
      </p>
      <div
        style={{
          ...mono(500, 10),
          display: 'inline-block',
          marginTop: 14,
          color: 'var(--agent)',
          border: '1px solid var(--agent)',
          borderRadius: 3,
          padding: '2px 7px',
          letterSpacing: '.06em',
        }}
      >
        COMING IN A LATER PHASE
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tickets */

/**
 * The Tickets tab IS the web console (DAT-232): the deployed app rendered in
 * a webview whose session gets the dev's workspace bearer token injected by
 * the main process — full board/drawer/planning parity with zero duplicated
 * UI, signed in as you without a second login.
 */
function ConsoleView() {
  const [cfg, setCfg] = useState<Awaited<ReturnType<DesktopBridge['getConfig']>> | null>(null);
  const [auth, setAuth] = useState<AuthMode | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState('');
  const viewRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void window.desktopBridge.getConfig().then(setCfg);
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
  }, []);

  // Remember where you were (the app routes by URL), so a restart reopens the
  // same project/board instead of the portfolio. Tab switches don't even hit
  // this — the webview stays mounted (see App) and keeps its state live.
  useEffect(() => {
    const wv = viewRef.current;
    if (!wv || !cfg) return;
    const save = (e: Event) => {
      const url = (e as unknown as { url?: string }).url;
      if (typeof url === 'string' && url.startsWith(cfg.consoleUrl)) {
        try {
          localStorage.setItem('console-last-url', url);
        } catch {
          // storage unavailable — restart lands on the portfolio, no harm
        }
      }
    };
    wv.addEventListener('did-navigate', save);
    wv.addEventListener('did-navigate-in-page', save);
    return () => {
      wv.removeEventListener('did-navigate', save);
      wv.removeEventListener('did-navigate-in-page', save);
    };
  }, [cfg, auth]);

  const initialUrl = (() => {
    if (!cfg) return '';
    try {
      const saved = localStorage.getItem('console-last-url');
      return saved && saved.startsWith(cfg.consoleUrl) ? saved : cfg.consoleUrl;
    } catch {
      return cfg.consoleUrl;
    }
  })();

  const signIn = async () => {
    setSigningIn(true);
    setSignInError('');
    const res = await window.desktopBridge.authLogin();
    setSigningIn(false);
    if (res.ok) setAuth(res.mode);
    else setSignInError(res.error);
  };

  if (!cfg || auth === null) return null;

  if (auth === 'signed-out') {
    return (
      <div style={{ padding: 28, display: 'grid', gap: 12, maxWidth: 480 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Tickets</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)', lineHeight: 1.5 }}>
          The full console loads here once you&rsquo;re signed in to Databricks.
        </p>
        <div>
          <button
            className="no-drag hv-lift"
            onClick={() => void signIn()}
            disabled={signingIn}
            style={{
              background: 'var(--acc)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '9px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: signingIn ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {signingIn ? 'Waiting for browser…' : 'Sign in to Databricks'}
          </button>
        </div>
        {signInError && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{signInError}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--bg2)',
          flex: 'none',
        }}
      >
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>
          ▤ CONSOLE
        </span>
        <span
          style={{
            ...mono(400, 10),
            color: 'var(--tx3)',
            minWidth: 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {cfg.consoleUrl}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="no-drag"
          title="Reload the console"
          onClick={() => {
            const wv = viewRef.current as unknown as { reload?: () => void } | null;
            wv?.reload?.();
          }}
          style={{ border: 'none', background: 'none', color: 'var(--tx2)', cursor: 'pointer', fontSize: 13 }}
        >
          ↻
        </button>
        <a
          href={cfg.consoleUrl}
          target="_blank"
          rel="noreferrer"
          title="Open in your browser"
          style={{ ...mono(400, 10), color: 'var(--link)' }}
        >
          open in browser ↗
        </a>
      </div>
      <webview
        ref={(el: HTMLElement | null) => {
          viewRef.current = el;
        }}
        src={initialUrl}
        partition="persist:console"
        style={{ flex: 1, minHeight: 0 }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- agents */

const KIND_LABEL: Record<AgentKind, string> = { claude: 'Claude Code', codex: 'Codex' };

/**
 * Agents (DAT-245): configure how many instances of each coding agent run on
 * this machine, tab between live instances, and watch their feeds. Native-app
 * exclusive — the web console never gets a path into anyone's laptop.
 */
function AgentsView({ onActivity }: { onActivity: (active: boolean) => void }) {
  const [agents, setAgents] = useState<AgentsState | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [work, setWork] = useState<{ queued: AgentTaskRow[]; active: AgentTaskRow[] } | null>(null);
  const [runError, setRunError] = useState('');
  // Interactive terminal (DAT-240): pane docked at the bottom of the page;
  // sessions live in the main process, so hiding the pane kills nothing.
  const [termOpen, setTermOpen] = useState(false);
  const [termReq, setTermReq] = useState<TerminalOpenRequest | null>(null);
  const openShell = (taskId: number, ticketKey: string) => {
    setTermReq({ taskId, ticketKey, nonce: Date.now() });
    setTermOpen(true);
  };

  const apply = (s: AgentsState) => {
    setAgents(s);
    onActivity(s.instances.some((i) => i.state !== 'stopped'));
    setTab((t) => (t && s.instances.some((i) => i.id === t) ? t : (s.instances[0]?.id ?? null)));
  };

  useEffect(() => {
    void window.desktopBridge.agentsState().then(apply);
    const off = window.desktopBridge.onAgentsEvent(({ instanceId, ev }) => {
      setAgents((s) => {
        if (!s) return s;
        const next = {
          ...s,
          instances: s.instances.map((i) => {
            if (i.id !== instanceId) return i;
            const feed = [...i.feed.slice(-799), ev];
            return ev.kind === 'status' ? { ...i, state: ev.state, feed } : { ...i, feed };
          }),
        };
        onActivity(next.instances.some((i) => i.state !== 'stopped'));
        return next;
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The machine's queue view: shared pool + tasks routed to this dev.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const res = await window.desktopBridge.listWork();
      if (!stop && res.ok) setWork(res.work);
    };
    void tick();
    const t = setInterval(() => void tick(), 8000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const runTicket = async (key: string) => {
    setRunError('');
    const res = await window.desktopBridge.agentsRunTicket(key);
    if (!res.ok) setRunError(res.error ?? 'Run failed to start.');
  };

  const configure = (kind: AgentKind, opts: { instances?: number; autoStart?: boolean }) =>
    void window.desktopBridge.agentsConfigure(kind, opts).then(apply);

  const act = (fn: (id: string) => Promise<AgentsState>, id: string) => () => void fn(id).then(apply);

  const selected = agents?.instances.find((i) => i.id === tab) ?? null;
  const liveIds = new Set((agents?.instances ?? []).map((i) => i.current?.taskId).filter((x) => x != null));

  const lineColor: Record<RunnerEvent['kind'], string> = {
    status: 'var(--agent)',
    print: 'var(--tx2)',
    tool: 'var(--tx)',
    note: 'var(--tx3)',
    error: 'var(--bad)',
  };

  const stateColor = (s: RunnerState): string =>
    s === 'running' || s === 'completing' ? 'var(--ok)' : s === 'waiting' ? 'var(--agent)' : 'var(--tx3)';

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 14, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Agents</h2>
        <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>
          coding agents running on this machine — configured here, invisible to the web app
        </span>
      </div>

      {/* Per-agent-type config: install status, instance count, auto-start. */}
      {agents && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {(Object.keys(agents.kinds) as AgentKind[]).map((kind) => {
            const k = agents.kinds[kind];
            return (
              <div
                key={kind}
                style={{
                  background: 'var(--bg2)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  minWidth: 320,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{KIND_LABEL[kind]}</div>
                  <div style={{ ...mono(400, 10), color: k.installed ? 'var(--ok)' : 'var(--warn)', marginTop: 2 }}>
                    {k.installed ? `✓ ${k.version ?? 'installed'}` : '⚠ not found on PATH'}
                  </div>
                </div>
                <div style={{ flex: 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title="Concurrent instances of this agent">
                  <button className="no-drag" onClick={() => configure(kind, { instances: k.instances - 1 })} disabled={k.instances <= 0} style={stepBtn}>
                    −
                  </button>
                  <span style={{ ...mono(600, 14), width: 18, textAlign: 'center' }}>{k.instances}</span>
                  <button className="no-drag" onClick={() => configure(kind, { instances: k.instances + 1 })} disabled={k.instances >= 4 || !k.installed} style={stepBtn}>
                    +
                  </button>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--tx2)', cursor: 'pointer' }} title="Launch these instances with the app so the queue never stalls">
                  <input
                    type="checkbox"
                    checked={k.autoStart}
                    onChange={(e) => configure(kind, { autoStart: e.target.checked })}
                  />
                  auto-start
                </label>
              </div>
            );
          })}
        </div>
      )}

      {runError && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{runError}</div>}

      {work && (work.queued.length > 0 || work.active.length > 0) && (
        <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
          <TaskSection title="ROUTED TO YOU" empty="" tasks={work.queued.filter((t) => t.assignee)} accent="var(--agent)" onRun={runTicket} hideWhenEmpty />
          <TaskSection title="SHARED POOL" empty="" tasks={work.queued.filter((t) => !t.assignee)} accent="var(--tx3)" onRun={runTicket} hideWhenEmpty />
          <TaskSection
            title="ACTIVE ON THIS MACHINE"
            empty=""
            tasks={work.active}
            accent="var(--ok)"
            hideWhenEmpty
            liveTaskIds={liveIds}
            onShell={openShell}
            onRelease={async (taskId) => {
              const res = await window.desktopBridge.agentsRelease(taskId);
              if (!res.ok) setRunError(res.error ?? 'Release failed.');
              const w = await window.desktopBridge.listWork();
              if (w.ok) setWork(w.work);
            }}
          />
        </div>
      )}

      {/* Instance tabs */}
      {agents && agents.instances.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--tx2)' }}>
          No agent instances configured — add one above (Claude Code + is the usual first move).
        </div>
      )}
      {agents && agents.instances.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--line)', flexWrap: 'wrap' }}>
            {agents.instances.map((i) => (
              <button
                key={i.id}
                className="no-drag"
                onClick={() => setTab(i.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  background: 'transparent',
                  border: 'none',
                  borderBottom: `2px solid ${tab === i.id ? 'var(--acc)' : 'transparent'}`,
                  color: tab === i.id ? 'var(--tx)' : 'var(--tx2)',
                  padding: '7px 12px',
                  fontSize: 12.5,
                  fontWeight: tab === i.id ? 600 : 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: stateColor(i.state), flex: 'none' }} />
                {i.label}
                {i.current && <span style={{ ...mono(400, 9.5), color: 'var(--tx3)' }}>{i.current.ticketKey}</span>}
              </button>
            ))}
          </div>

          {selected && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span
                  style={{
                    ...mono(500, 9.5),
                    letterSpacing: '.08em',
                    color: stateColor(selected.state),
                    border: `1px solid ${stateColor(selected.state)}`,
                    borderRadius: 3,
                    padding: '2px 8px',
                  }}
                >
                  {selected.state.toUpperCase()}
                  {selected.current ? ` · ${selected.current.ticketKey}` : ''}
                </span>
                <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{selected.agentName}</span>
                <div style={{ flex: 1 }} />
                {selected.state === 'stopped' && (
                  <button className="no-drag hv-lift" onClick={act((id) => window.desktopBridge.agentsStart(id), selected.id)} style={btnStyle('var(--ok)')}>
                    ▶ Start
                  </button>
                )}
                {selected.state === 'waiting' && (
                  <button className="no-drag" onClick={act((id) => window.desktopBridge.agentsStop(id), selected.id)} style={btnStyle('var(--warn)')}>
                    ■ Stop
                  </button>
                )}
                {(selected.state === 'running' || selected.state === 'completing') && (
                  <button className="no-drag" onClick={act((id) => window.desktopBridge.agentsKill(id), selected.id)} style={btnStyle('var(--bad)')}>
                    ✕ Kill run
                  </button>
                )}
                <button
                  className="no-drag"
                  onClick={() => setTermOpen((o) => !o)}
                  title="Toggle the terminal pane (sessions keep running when hidden)"
                  style={btnStyle(termOpen ? 'var(--tx)' : 'var(--tx2)')}
                >
                  ⌨ Terminal
                </button>
              </div>

              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  background: 'var(--bg2)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: '12px 14px',
                  ...mono(400, 11.5),
                  lineHeight: 1.55,
                  userSelect: 'text',
                }}
              >
                {selected.feed.length === 0 && (
                  <div style={{ color: 'var(--tx3)' }}>
                    No activity yet on {selected.label}. It claims work automatically while waiting, or ▶ Run a
                    queued ticket above.
                  </div>
                )}
                {selected.feed.map((ev, i) => (
                  <div key={i} style={{ color: lineColor[ev.kind], whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {ev.kind === 'status'
                      ? `── ${ev.state.toUpperCase()}${ev.detail ? ` · ${ev.detail}` : ''} ──`
                      : ev.kind === 'tool'
                        ? `  > ${ev.name} ${ev.label}`
                        : ev.text}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* DAT-240: interactive terminal, docked at the bottom of the Agents
          page. Sessions live in the main process — hiding kills nothing. */}
      <TerminalPane
        current={selected?.current ?? null}
        openRequest={termReq}
        open={termOpen}
        onToggle={setTermOpen}
      />
    </div>
  );
}

const stepBtn: CSSProperties = {
  width: 24,
  height: 24,
  border: '1px solid var(--line2)',
  background: 'var(--bg3)',
  color: 'var(--tx)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  fontFamily: 'inherit',
};

const btnStyle = (color: string): CSSProperties => ({
  background: 'transparent',
  color,
  border: `1px solid ${color}`,
  borderRadius: 6,
  padding: '7px 14px',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
});

function TaskSection({
  title,
  empty,
  tasks,
  accent,
  onRun,
  hideWhenEmpty,
  liveTaskIds,
  onRelease,
  onShell,
}: {
  title: string;
  empty: string;
  tasks: AgentTaskRow[];
  accent: string;
  onRun?: (ticketKey: string) => void;
  hideWhenEmpty?: boolean;
  /** Tasks executing in live processes; any other active row is an orphan (DAT-234). */
  liveTaskIds?: Set<number | null | undefined>;
  onRelease?: (taskId: number) => void;
  /** Open a shell in this task's workdir (DAT-240). */
  onShell?: (taskId: number, ticketKey: string) => void;
}) {
  if (tasks.length === 0 && hideWhenEmpty) return null;
  const isOrphan = (t: AgentTaskRow): boolean =>
    onRelease != null && ['claimed', 'working'].includes(t.state) && !(liveTaskIds?.has(t.id) ?? false);
  return (
    <div>
      <div style={{ ...mono(500, 10), color: accent, letterSpacing: '.08em', marginBottom: 8 }}>
        ◆ {title} · {tasks.length}
      </div>
      {tasks.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--tx3)' }}>{empty}</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {tasks.map((t) => (
            <div
              key={t.id}
              style={{
                background: 'var(--bg2)',
                border: '1px solid var(--line)',
                borderLeft: `3px solid ${accent}`,
                borderRadius: 6,
                padding: 'var(--rowpad)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...mono(500, 11), color: 'var(--tx2)' }}>{t.ticket_key}</span>
                <span style={{ ...mono(400, 9.5), color: 'var(--tx3)' }}>{t.engagement_id}</span>
                <span style={{ marginLeft: 'auto', ...mono(500, 9), color: accent, letterSpacing: '.06em' }}>
                  {t.state.toUpperCase()}
                </span>
                {onShell && ['claimed', 'working'].includes(t.state) && (
                  <button
                    className="no-drag"
                    title="Open a shell in this task's working directory"
                    onClick={() => onShell(t.id, t.ticket_key)}
                    style={{
                      border: '1px solid var(--line2)',
                      background: 'transparent',
                      color: 'var(--tx2)',
                      borderRadius: 4,
                      padding: '2px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    ⌨
                  </button>
                )}
                {onRun && t.state === 'queued' && (
                  <button
                    className="no-drag hv-lift"
                    title="Claim and run this ticket on an idle agent instance"
                    onClick={() => onRun(t.ticket_key)}
                    style={{
                      border: '1px solid var(--ok)',
                      background: 'transparent',
                      color: 'var(--ok)',
                      borderRadius: 4,
                      padding: '2px 9px',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    ▶ Run
                  </button>
                )}
              </div>
              {t.instructions && (
                <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--tx3)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {t.instructions}
                </div>
              )}
              {t.last_note && t.state !== 'queued' && (
                <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--tx2)' }}>{t.last_note}</div>
              )}
              {isOrphan(t) && (
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--warn)', fontWeight: 600 }}>
                    ⚠ No process on this machine — the app restarted while this run was in flight.
                  </span>
                  <button
                    className="no-drag"
                    title="Fail the task with an honest summary so the ticket returns to the backlog"
                    onClick={() => onRelease?.(t.id)}
                    style={{
                      border: '1px solid var(--warn)',
                      background: 'transparent',
                      color: 'var(--warn)',
                      borderRadius: 4,
                      padding: '2px 9px',
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Release
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ deploys */

const DEPLOY_STATE_COLOR: Record<DeployState, string> = {
  queued: 'var(--tx3)',
  deploying: 'var(--agent)',
  succeeded: 'var(--ok)',
  failed: 'var(--bad)',
};

/**
 * Deploys (DAT-236): the local deployment queue. Merged tickets assigned to
 * you land here and deploy from THIS machine with YOUR identity — one click,
 * live log. The console only receives events; the web app renders a read-only
 * mirror from them and has no path back into this laptop.
 */
function DeploysView() {
  const [snap, setSnap] = useState<DeploysSnapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    const refresh = () => void window.desktopBridge.deploysState().then(setSnap);
    refresh();
    const off = window.desktopBridge.onDeploysEvent((ev) => {
      if (ev.kind === 'items') {
        refresh();
      } else {
        // Live log lines append in place — no full refetch per line.
        setSnap((s) =>
          s && {
            ...s,
            items: s.items.map((i) =>
              i.ticketKey === ev.ticketKey ? { ...i, log: [...i.log.slice(-1999), ev.line] } : i,
            ),
          },
        );
      }
    });
    const t = setInterval(refresh, 15_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const items = snap?.items ?? [];
  const current = items.find((i) => i.ticketKey === (snap?.deploying ?? selected)) ?? items[0] ?? null;

  const run = async (key: string) => {
    setActionError('');
    setSelected(key);
    const res = await window.desktopBridge.deploysRun(key);
    if (!res.ok) setActionError(res.error ?? 'Deploy failed to start.');
  };

  const dismiss = async (key: string) => {
    setActionError('');
    const res = await window.desktopBridge.deploysDismiss(key);
    if (!res.ok) setActionError(res.error ?? 'Could not remove the item.');
  };

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 14, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Deploys</h2>
        <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>
          your merged tickets deploy from this machine, with your identity — the web app only sees a read-only mirror
        </span>
        <div style={{ flex: 1 }} />
        <button
          className="no-drag"
          title="Check the console for newly merged tickets now"
          onClick={() => void window.desktopBridge.deploysRefresh().then(setSnap)}
          style={{ border: 'none', background: 'none', color: 'var(--tx2)', cursor: 'pointer', fontSize: 13 }}
        >
          ↻
        </button>
      </div>

      {snap?.pollError && (
        <div style={{ fontSize: 12, color: 'var(--warn)' }}>⚠ queue refresh failing: {snap.pollError}</div>
      )}
      {actionError && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{actionError}</div>}

      {items.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--tx2)', maxWidth: 560, lineHeight: 1.5 }}>
          Nothing waiting to deploy. When a PR for one of your tickets merges, the ticket queues here
          automatically{snap?.polledAt ? '' : ' once you are signed in'}.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6, maxWidth: 720 }}>
          {items.map((i) => (
            <div
              key={i.ticketKey}
              onClick={() => setSelected(i.ticketKey)}
              style={{
                background: 'var(--bg2)',
                border: `1px solid ${current?.ticketKey === i.ticketKey ? 'var(--line2)' : 'var(--line)'}`,
                borderLeft: `3px solid ${DEPLOY_STATE_COLOR[i.state]}`,
                borderRadius: 6,
                padding: 'var(--rowpad)',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ ...mono(500, 11), color: 'var(--tx2)' }}>{i.ticketKey}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                  {i.title}
                </span>
                {i.prNumber !== null && <span style={{ ...mono(400, 9.5), color: 'var(--tx3)' }}>PR #{i.prNumber}</span>}
                <span style={{ ...mono(400, 9.5), color: 'var(--tx3)' }}>{i.repoName}</span>
                <span style={{ marginLeft: 'auto', ...mono(500, 9), color: DEPLOY_STATE_COLOR[i.state], letterSpacing: '.06em' }}>
                  {i.state.toUpperCase()}
                </span>
                {(i.state === 'queued' || i.state === 'failed') && (
                  <>
                    <button
                      className="no-drag hv-lift"
                      title={i.state === 'failed' ? 'Retry the deploy on this machine' : 'Deploy on this machine, as you'}
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(i.ticketKey);
                      }}
                      style={{
                        border: '1px solid var(--ok)',
                        background: 'transparent',
                        color: 'var(--ok)',
                        borderRadius: 4,
                        padding: '2px 9px',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      ▶ {i.state === 'failed' ? 'Retry' : 'Deploy'}
                    </button>
                    <button
                      className="no-drag"
                      title="Drop this item from the local queue"
                      onClick={(e) => {
                        e.stopPropagation();
                        void dismiss(i.ticketKey);
                      }}
                      style={{
                        border: '1px solid var(--line2)',
                        background: 'transparent',
                        color: 'var(--tx3)',
                        borderRadius: 4,
                        padding: '2px 7px',
                        fontSize: 11,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
              {i.state === 'failed' && i.error && (
                <div style={{ marginTop: 4, fontSize: 11.5, color: 'var(--bad)' }}>{i.error}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {current && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                ...mono(500, 9.5),
                letterSpacing: '.08em',
                color: DEPLOY_STATE_COLOR[current.state],
                border: `1px solid ${DEPLOY_STATE_COLOR[current.state]}`,
                borderRadius: 3,
                padding: '2px 8px',
              }}
            >
              {current.state.toUpperCase()} · {current.ticketKey}
            </span>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>deploy log</span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 120,
              overflowY: 'auto',
              background: 'var(--bg2)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '12px 14px',
              ...mono(400, 11.5),
              lineHeight: 1.55,
              userSelect: 'text',
            }}
          >
            {current.log.length === 0 && (
              <div style={{ color: 'var(--tx3)' }}>
                No output yet — ▶ Deploy runs the checkout and deploy here, streaming every line.
              </div>
            )}
            {current.log.map((line, i) => (
              <div key={i} style={{ color: line.startsWith('⚠') || line.startsWith('✕') ? 'var(--bad)' : line.startsWith('>') ? 'var(--tx)' : 'var(--tx2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {line}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- identity */

const AUTH_LABEL: Record<AuthMode, { text: string; color: string }> = {
  oauth: { text: 'signed in (browser OAuth)', color: 'var(--ok)' },
  cli: { text: 'signed in via Databricks CLI', color: 'var(--ok)' },
  'dev-token': { text: 'dev token from env', color: 'var(--warn)' },
  'signed-out': { text: 'not signed in', color: 'var(--tx3)' },
};

const PROVIDER_LABEL: Record<IdentityProvider, { name: string; note: string }> = {
  github: { name: 'GitHub', note: 'client-owned GitHub repos — pushes and PRs as you' },
  azure: { name: 'Azure', note: 'az — ARM APIs with your subscription access' },
  ado: { name: 'Azure DevOps', note: 'client-owned ADO repos — git runs as you' },
};

function IdentityView() {
  const [cfg, setCfg] = useState<Awaited<ReturnType<DesktopBridge['getConfig']>> | null>(null);
  const [auth, setAuth] = useState<AuthMode>('signed-out');
  const [state, setState] = useState<'idle' | 'signing-in' | 'testing' | 'ok' | 'error'>('idle');
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [error, setError] = useState('');
  const [ids, setIds] = useState<IdentityStatusRow[]>([]);
  const [idErr, setIdErr] = useState<Partial<Record<IdentityProvider, string>>>({});

  useEffect(() => {
    void window.desktopBridge.getConfig().then(setCfg);
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
    void window.desktopBridge.identityStatus().then(setIds);
    // Device flows resolve out-of-band (browser side) — events keep the rows live.
    return window.desktopBridge.onIdentityEvent((row) => {
      setIds((rows) => rows.map((r) => (r.provider === row.provider ? row : r)));
    });
  }, []);

  const providerLogin = async (p: IdentityProvider) => {
    setIdErr((e) => ({ ...e, [p]: undefined }));
    const res = await window.desktopBridge.identityLogin(p);
    if (res.ok) {
      setIds((rows) => rows.map((r) => (r.provider === p ? res.status : r)));
    } else {
      setIdErr((e) => ({ ...e, [p]: res.error }));
      void window.desktopBridge.identityStatus().then(setIds);
    }
  };

  const providerSignOut = async (p: IdentityProvider) => {
    setIds(await window.desktopBridge.identitySignOut(p));
  };

  const test = async () => {
    setState('testing');
    setError('');
    const res = await window.desktopBridge.listEngagements();
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
    if (res.ok) {
      setEngagements(res.engagements);
      setState('ok');
    } else {
      setError(res.error);
      setState('error');
    }
  };

  const signIn = async () => {
    setState('signing-in');
    setError('');
    const res = await window.desktopBridge.authLogin();
    if (res.ok) {
      setAuth(res.mode);
      await test();
    } else {
      setError(res.error);
      setState('error');
    }
  };

  const signOut = async () => {
    const res = await window.desktopBridge.authSignOut();
    setAuth(res.mode);
    setEngagements([]);
    setState('idle');
  };

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>Identity</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)', maxWidth: 520, lineHeight: 1.5 }}>
          Databricks is the console&rsquo;s identity; GitHub, Azure and Azure DevOps sign in below
          so work on client-owned repos runs as you (work repos keep console-vended tokens).
          Everything at rest is encrypted via the OS keychain — never plaintext files.
        </p>
      </div>

      <div
        style={{
          background: 'var(--bg2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: 18,
          maxWidth: 560,
        }}
      >
        <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 10 }}>
          DATABRICKS
        </div>
        {cfg && (
          <div style={{ display: 'grid', gap: 4, marginBottom: 14 }}>
            <Row k="console" v={cfg.consoleUrl} />
            <Row k="workspace" v={cfg.databricksHost} />
            <Row k="agent" v={cfg.agentName} />
            <div style={{ display: 'flex', gap: 10, fontSize: 12.5, alignItems: 'center' }}>
              <span style={{ ...mono(400, 11), color: 'var(--tx3)', width: 78, flex: 'none' }}>auth</span>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: AUTH_LABEL[auth].color, flex: 'none' }} />
              <span style={{ color: AUTH_LABEL[auth].color }}>{AUTH_LABEL[auth].text}</span>
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {auth === 'signed-out' && (
            <button
              className="no-drag hv-lift"
              onClick={() => void signIn()}
              disabled={state === 'signing-in'}
              style={{
                background: 'var(--acc)',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '9px 18px',
                fontSize: 13,
                fontWeight: 600,
                cursor: state === 'signing-in' ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {state === 'signing-in' ? 'Waiting for browser…' : 'Sign in to Databricks'}
            </button>
          )}
          <button
            className="no-drag hv-lift"
            onClick={() => void test()}
            disabled={state === 'testing' || state === 'signing-in'}
            style={{ ...btnStyle('var(--agent)'), padding: '9px 18px', fontSize: 13 }}
          >
            {state === 'testing' ? 'Connecting…' : 'Test connection'}
          </button>
          {auth === 'oauth' && (
            <button className="no-drag" onClick={() => void signOut()} style={{ ...btnStyle('var(--tx3)'), padding: '9px 14px' }}>
              Sign out
            </button>
          )}
        </div>
        {state === 'signing-in' && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
            Your browser opened the workspace sign-in page — finish there and this window picks it
            up automatically.
          </div>
        )}
        {state === 'error' && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--bad)', lineHeight: 1.5 }}>
            {error}
          </div>
        )}
        {state === 'ok' && (
          <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
            <div style={{ ...mono(500, 10), color: 'var(--ok)', letterSpacing: '.08em' }}>
              ✓ CONNECTED · {engagements.length} ENGAGEMENT{engagements.length === 1 ? '' : 'S'}
            </div>
            {engagements.map((e) => (
              <div
                key={e.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  padding: 'var(--rowpad)',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: e.health === 'ok' ? 'var(--ok)' : 'var(--warn)',
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{e.name}</span>
                <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>{e.client}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--tx2)' }}>
                  {e.phase}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* DAT-235: dev identities — device-code flows, login state per provider. */}
      <div
        style={{
          background: 'var(--bg2)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: 18,
          maxWidth: 560,
        }}
      >
        <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 4 }}>
          DEVELOPER IDENTITIES
        </div>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--tx3)', lineHeight: 1.5 }}>
          Sign-ins happen in your browser (device code); tokens stay in the OS keychain and renew
          silently. Runs on this machine pick them up automatically.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {ids.map((row) => (
            <ProviderRow
              key={row.provider}
              row={row}
              error={idErr[row.provider]}
              onLogin={() => void providerLogin(row.provider)}
              onSignOut={() => void providerSignOut(row.provider)}
            />
          ))}
        </div>
      </div>

      <McpAuthCard />
    </div>
  );
}

function ProviderRow({
  row,
  error,
  onLogin,
  onSignOut,
}: {
  row: IdentityStatusRow;
  error?: string;
  onLogin: () => void;
  onSignOut: () => void;
}) {
  const label = PROVIDER_LABEL[row.provider];
  const color =
    row.state === 'signed-in' ? 'var(--ok)' : row.state === 'pending' ? 'var(--agent)' : 'var(--tx3)';
  return (
    <div
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: 'var(--rowpad)',
        display: 'grid',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{label.name}</span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {row.state === 'signed-in' ? (row.account ?? 'signed in') : label.note}
        </span>
        <div style={{ flex: 1 }} />
        {row.state === 'signed-out' && (
          <button className="no-drag hv-lift" onClick={onLogin} style={{ ...btnStyle('var(--acc)'), padding: '4px 12px', fontSize: 11.5 }}>
            Sign in
          </button>
        )}
        {row.state === 'pending' && (
          <span style={{ ...mono(500, 9.5), color: 'var(--agent)', letterSpacing: '.06em' }}>WAITING FOR BROWSER…</span>
        )}
        {row.state === 'signed-in' && (
          <button className="no-drag" onClick={onSignOut} style={{ ...btnStyle('var(--tx3)'), padding: '4px 12px', fontSize: 11.5 }}>
            Sign out
          </button>
        )}
      </div>
      {row.state === 'pending' && row.prompt && (
        <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.5 }}>
          Enter code{' '}
          <span style={{ ...mono(600, 13), color: 'var(--tx)', letterSpacing: '.12em', userSelect: 'text' }}>
            {row.prompt.userCode}
          </span>{' '}
          at{' '}
          <a href={row.prompt.verificationUri} target="_blank" rel="noreferrer" style={{ color: 'var(--link)' }}>
            {row.prompt.verificationUri}
          </a>{' '}
          — the browser is already open on it.
        </div>
      )}
      {error && <div style={{ fontSize: 11.5, color: 'var(--bad)' }}>{error}</div>}
    </div>
  );
}

/**
 * Per-MCP-server auth (DAT-235): named secrets stored in the keychain and
 * handed to harness runs as `MCP_AUTH_<NAME>` env — never written to a file.
 * The bundled delivery-console server authenticates via Databricks and needs
 * no secret; rows here cover third-party MCP servers wired into workdirs.
 */
function McpAuthCard() {
  const [rows, setRows] = useState<McpAuthRow[]>([]);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');

  useEffect(() => {
    void window.desktopBridge.identityMcpList().then(setRows);
  }, []);

  const add = async () => {
    if (!name.trim() || !secret) return;
    setRows(await window.desktopBridge.identityMcpSet(name.trim(), secret));
    setName('');
    setSecret('');
  };

  const inputStyle: CSSProperties = {
    background: 'var(--bg)',
    border: '1px solid var(--line2)',
    borderRadius: 5,
    color: 'var(--tx)',
    padding: '5px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    minWidth: 0,
  };

  return (
    <div
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: 18,
        maxWidth: 560,
      }}
    >
      <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 4 }}>
        MCP SERVER AUTH
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--tx3)', lineHeight: 1.5 }}>
        Secrets for MCP servers your runs use, one per server — kept in the keychain, passed to
        harness runs as <span style={mono(500, 11)}>MCP_AUTH_&lt;NAME&gt;</span> env. The bundled
        delivery-console server signs in via Databricks and needs nothing here.
      </p>
      <div style={{ display: 'grid', gap: 6 }}>
        {rows.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--tx3)' }}>No MCP server secrets stored.</div>
        )}
        {rows.map((r) => (
          <div
            key={r.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: 'var(--rowpad)',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', flex: 'none' }} />
            <span style={{ ...mono(500, 11.5) }}>{r.name}</span>
            <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>secret stored</span>
            <div style={{ flex: 1 }} />
            <button
              className="no-drag"
              onClick={() => void window.desktopBridge.identityMcpClear(r.name).then(setRows)}
              style={{ ...btnStyle('var(--tx3)'), padding: '3px 10px', fontSize: 11 }}
            >
              Clear
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <input
            className="no-drag"
            placeholder="server name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...inputStyle, width: 150 }}
          />
          <input
            className="no-drag"
            type="password"
            placeholder="secret / token"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            className="no-drag hv-lift"
            onClick={() => void add()}
            disabled={!name.trim() || !secret}
            style={{ ...btnStyle('var(--acc)'), padding: '5px 14px', fontSize: 11.5, opacity: !name.trim() || !secret ? 0.5 : 1 }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
      <span style={{ ...mono(400, 11), color: 'var(--tx3)', width: 78, flex: 'none' }}>{k}</span>
      <span style={{ color: 'var(--tx)', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

/* -------------------------------------------------------------------- app */

const VIEWS_STATIC: Partial<Record<NavId, ReactNode>> = {
  sync: (
    <Placeholder
      title="Sync"
      note="The managed file store: context, prompts, skills and standards synced through a git-backed allowlist manifest — nothing unlisted ever leaves this machine."
    />
  ),
};

export function App() {
  const [nav, setNav] = useState<NavId>('tickets');
  const [agentsActive, setAgentsActive] = useState(false);
  // The embedded console stays mounted no matter which tab is active —
  // unmounting the webview would reset it to the portfolio, so leaving
  // Tickets and coming back must find you exactly where you were. Hidden
  // via visibility (not display:none, which breaks Electron webviews).
  const overlay =
    nav === 'agents' ? (
      <AgentsView onActivity={setAgentsActive} />
    ) : nav === 'deploys' ? (
      <DeploysView />
    ) : nav === 'identity' ? (
      <IdentityView />
    ) : nav === 'tickets' ? null : (
      VIEWS_STATIC[nav]
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TitleBar />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav
          style={{
            width: 172,
            flex: 'none',
            background: 'var(--bg2)',
            borderRight: '1px solid var(--line)',
            padding: '10px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {NAV.map((n) => (
            <button
              key={n.id}
              className="no-drag"
              onClick={() => setNav(n.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                background: nav === n.id ? 'var(--bg3)' : 'transparent',
                color: nav === n.id ? 'var(--tx)' : 'var(--tx2)',
                border: 'none',
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 13,
                fontWeight: nav === n.id ? 600 : 500,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ color: nav === n.id ? 'var(--acc)' : 'var(--tx3)', width: 14 }}>
                {n.icon}
              </span>
              {n.label}
              {n.id === 'agents' && agentsActive && (
                <span
                  title="agents active"
                  style={{
                    marginLeft: 'auto',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: 'var(--ok)',
                    animation: 'eec-pulse 2.4s infinite',
                  }}
                />
              )}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', padding: '0 10px 6px' }}>
            phase A+
          </div>
        </nav>
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              visibility: nav === 'tickets' ? 'visible' : 'hidden',
            }}
          >
            <ConsoleView />
          </div>
          {overlay && (
            <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', background: 'var(--bg)' }}>
              {overlay}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
