import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

// Console client conventions: inline styles + theme tokens + mono() — see
// docs/development-standards.md "Client code". mono() mirrors client/src/util.ts.
const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

const NAV = [
  { id: 'tickets', label: 'My Tickets', icon: '▤' },
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

const AUTH_LABEL: Record<AuthMode, { text: string; color: string }> = {
  oauth: { text: 'signed in (browser OAuth)', color: 'var(--ok)' },
  cli: { text: 'signed in via Databricks CLI', color: 'var(--ok)' },
  'dev-token': { text: 'dev token from env', color: 'var(--warn)' },
  'signed-out': { text: 'not signed in', color: 'var(--tx3)' },
};

function TicketsView() {
  const [cfg, setCfg] = useState<Awaited<ReturnType<DesktopBridge['getConfig']>> | null>(null);
  const [auth, setAuth] = useState<AuthMode>('signed-out');
  const [state, setState] = useState<'idle' | 'signing-in' | 'testing' | 'ok' | 'error'>('idle');
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [error, setError] = useState('');
  const [needSignIn, setNeedSignIn] = useState(false);

  useEffect(() => {
    void window.desktopBridge.getConfig().then(setCfg);
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
  }, []);

  const test = async () => {
    setState('testing');
    setError('');
    setNeedSignIn(false);
    const res = await window.desktopBridge.listEngagements();
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
    if (res.ok) {
      setEngagements(res.engagements);
      setState('ok');
    } else {
      setError(res.error);
      setNeedSignIn(Boolean(res.signInRequired));
      setState('error');
    }
  };

  // Browser round trip: the workspace sign-in page opens in the default
  // browser; we hold "signing in…" until the loopback redirect lands.
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

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>My Tickets</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)' }}>
          Assigned work lands here once the assignee-scoped queue ships. For now: verify this
          machine can reach the console as you.
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
          CONNECTION
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
          {(auth === 'signed-out' || needSignIn) && (
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
            style={{
              background: auth === 'signed-out' || needSignIn ? 'var(--bg3)' : 'var(--acc)',
              color: auth === 'signed-out' || needSignIn ? 'var(--tx2)' : '#fff',
              border: '1px solid var(--line2)',
              borderRadius: 6,
              padding: '9px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: state === 'testing' ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {state === 'testing' ? 'Connecting…' : 'Test connection'}
          </button>
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
      </div>

      {state === 'ok' && (
        <div style={{ maxWidth: 560, display: 'grid', gap: 8 }}>
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
                background: 'var(--bg2)',
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
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
      <span style={{ ...mono(400, 11), color: 'var(--tx3)', width: 78, flex: 'none' }}>{k}</span>
      <span style={{ color: warn ? 'var(--warn)' : 'var(--tx)', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

const VIEWS: Record<NavId, ReactNode> = {
  tickets: <TicketsView />,
  runs: (
    <Placeholder
      title="Runs"
      note="Live harness runs — the tool-call stream, heartbeats, and an embedded terminal pane. Harnesses run headless (no console windows); this is where you watch them."
    />
  ),
  harnesses: (
    <Placeholder
      title="Harnesses"
      note="Detect and configure coding agents (Claude Code, Codex, …) per project. Adapters are shared with the devbox runner — one entry drives both."
    />
  ),
  identity: (
    <Placeholder
      title="Identity"
      note="Databricks, GitHub, Azure and ADO login state. Tokens live in the OS keychain, minted short-lived, never at rest in files."
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
      note="Your local deployment queue: merged tickets that deploy with your identity, reporting deploy events back to the board."
    />
  ),
};

export function App() {
  const [nav, setNav] = useState<NavId>('tickets');
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
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', padding: '0 10px 6px' }}>
            phase 1 scaffold
          </div>
        </nav>
        <main style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>{VIEWS[nav]}</main>
      </div>
    </div>
  );
}
