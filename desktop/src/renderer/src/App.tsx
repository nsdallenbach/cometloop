import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

// Console client conventions: inline styles + theme tokens + mono() — see
// docs/development-standards.md "Client code". mono() mirrors client/src/util.ts.
const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

const NAV = [
  { id: 'tickets', label: 'Tickets', icon: '▤' },
  { id: 'runs', label: 'Runs', icon: '◆' },
  { id: 'harnesses', label: 'Harnesses', icon: '⌬' },
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

/* ------------------------------------------------------------------- runs */

interface WorkLists {
  queued: AgentTaskRow[];
  active: AgentTaskRow[];
}

function RunsView({ onRunnerChange }: { onRunnerChange: (state: RunnerState) => void }) {
  const [snap, setSnap] = useState<RunnerSnapshot | null>(null);
  const [feed, setFeed] = useState<RunnerEvent[]>([]);
  const [work, setWork] = useState<WorkLists | null>(null);
  const [runError, setRunError] = useState('');

  useEffect(() => {
    void window.desktopBridge.runnerState().then((s) => {
      setSnap(s);
      setFeed(s.feed);
      onRunnerChange(s.state);
    });
    const off = window.desktopBridge.onRunnerEvent((ev) => {
      setFeed((f) => [...f.slice(-799), ev]);
      if (ev.kind === 'status') {
        setSnap((s) => (s ? { ...s, state: ev.state } : s));
        onRunnerChange(ev.state);
      }
    });
    return off;
  }, [onRunnerChange]);

  // The runner-facing queue: shared pool + tasks routed to this dev, live.
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
    const res = await window.desktopBridge.runnerRunTicket(key);
    if (!res.ok) setRunError(res.error ?? 'Run failed to start.');
  };

  const running = snap?.state === 'running' || snap?.state === 'completing';
  const on = snap != null && snap.state !== 'stopped';
  const act = (fn: () => Promise<RunnerSnapshot>) => () =>
    void fn().then((s) => {
      setSnap(s);
      onRunnerChange(s.state);
    });

  const lineColor: Record<RunnerEvent['kind'], string> = {
    status: 'var(--agent)',
    print: 'var(--tx2)',
    tool: 'var(--tx)',
    note: 'var(--tx3)',
    error: 'var(--bad)',
  };

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 14, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Runs</h2>
        <span
          style={{
            ...mono(500, 9.5),
            letterSpacing: '.08em',
            color: running ? 'var(--ok)' : on ? 'var(--agent)' : 'var(--tx3)',
            border: `1px solid ${running ? 'var(--ok)' : on ? 'var(--agent)' : 'var(--line2)'}`,
            borderRadius: 3,
            padding: '2px 8px',
          }}
        >
          {snap ? snap.state.toUpperCase() : '…'}
          {snap?.current ? ` · ${snap.current.ticketKey}` : ''}
        </span>
        <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>harness: {snap?.harness ?? '…'}</span>
        <div style={{ flex: 1 }} />
        {!on && (
          <button className="no-drag hv-lift" onClick={act(() => window.desktopBridge.runnerStart())} style={btnStyle('var(--ok)')}>
            ▶ Start runner
          </button>
        )}
        {on && !running && (
          <button className="no-drag" onClick={act(() => window.desktopBridge.runnerStop())} style={btnStyle('var(--warn)')}>
            ■ Stop runner
          </button>
        )}
        {running && (
          <button className="no-drag" onClick={act(() => window.desktopBridge.runnerKill())} style={btnStyle('var(--bad)')}>
            ✕ Kill run
          </button>
        )}
      </div>

      {runError && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{runError}</div>}

      {work && (work.queued.length > 0 || work.active.length > 0) && (
        <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
          <TaskSection
            title="ROUTED TO YOU"
            empty=""
            tasks={work.queued.filter((t) => t.assignee)}
            accent="var(--agent)"
            onRun={runTicket}
            hideWhenEmpty
          />
          <TaskSection
            title="SHARED POOL"
            empty=""
            tasks={work.queued.filter((t) => !t.assignee)}
            accent="var(--tx3)"
            onRun={runTicket}
            hideWhenEmpty
          />
          <TaskSection title="ACTIVE ON THIS MACHINE" empty="" tasks={work.active} accent="var(--ok)" hideWhenEmpty />
        </div>
      )}

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
        {feed.length === 0 && (
          <div style={{ color: 'var(--tx3)' }}>
            No runner activity yet. Start the runner to long-poll the queue, or ▶ Run a queued ticket
            above (queue tickets from the Tickets tab — route one to yourself and it lands here).
          </div>
        )}
        {feed.map((ev, i) => (
          <div key={i} style={{ color: lineColor[ev.kind], whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {ev.kind === 'status'
              ? `── ${ev.state.toUpperCase()}${ev.detail ? ` · ${ev.detail}` : ''} ──`
              : ev.kind === 'tool'
                ? `  > ${ev.name} ${ev.label}`
                : ev.text}
          </div>
        ))}
      </div>
    </div>
  );
}

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
}: {
  title: string;
  empty: string;
  tasks: AgentTaskRow[];
  accent: string;
  onRun?: (ticketKey: string) => void;
  hideWhenEmpty?: boolean;
}) {
  if (tasks.length === 0 && hideWhenEmpty) return null;
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
                {onRun && t.state === 'queued' && (
                  <button
                    className="no-drag hv-lift"
                    title="Claim and run this ticket on this machine"
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
            </div>
          ))}
        </div>
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

function IdentityView() {
  const [cfg, setCfg] = useState<Awaited<ReturnType<DesktopBridge['getConfig']>> | null>(null);
  const [auth, setAuth] = useState<AuthMode>('signed-out');
  const [state, setState] = useState<'idle' | 'signing-in' | 'testing' | 'ok' | 'error'>('idle');
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void window.desktopBridge.getConfig().then(setCfg);
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
  }, []);

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
          Databricks is the console&rsquo;s identity; GitHub, Azure and ADO logins land here in a
          later phase. Tokens are minted short-lived; the refresh token lives encrypted in the OS
          keychain.
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
  harnesses: (
    <Placeholder
      title="Harnesses"
      note="Detect and configure coding agents (Claude Code, Codex, …) per project. Adapters are shared with the devbox runner — one entry drives both. Today: set `harness` in config.json or the HARNESS env var."
    />
  ),
  sync: (
    <Placeholder
      title="Sync"
      note="The managed file store: context, prompts, skills and standards synced through a git-backed allowlist manifest — nothing unlisted ever leaves this machine."
    />
  ),
  deploys: (
    <Placeholder
      title="Deploys"
      note="Your local deployment queue: merged tickets that deploy with your identity. The web app gets a read-only mirror fed by deploy events — visibility without a path into anyone's laptop."
    />
  ),
};

export function App() {
  const [nav, setNav] = useState<NavId>('tickets');
  const [runnerState, setRunnerState] = useState<RunnerState>('stopped');
  // The embedded console stays mounted no matter which tab is active —
  // unmounting the webview would reset it to the portfolio, so leaving
  // Tickets and coming back must find you exactly where you were. Hidden
  // via visibility (not display:none, which breaks Electron webviews).
  const overlay =
    nav === 'runs' ? (
      <RunsView onRunnerChange={setRunnerState} />
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
              {n.id === 'runs' && runnerState !== 'stopped' && (
                <span
                  title={`runner ${runnerState}`}
                  style={{
                    marginLeft: 'auto',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: runnerState === 'waiting' ? 'var(--agent)' : 'var(--ok)',
                    animation: 'eec-pulse 2.4s infinite',
                  }}
                />
              )}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', padding: '0 10px 6px' }}>
            phase A
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
