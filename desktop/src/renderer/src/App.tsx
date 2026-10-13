import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Bot, FolderKanban, Gauge, KeyRound, RefreshCw, Rocket, Settings, Workflow, Wrench } from 'lucide-react';
import { TerminalPane, type TerminalOpenRequest } from './TerminalPane';
import { IdentityView } from './IdentityView';
import { SignInGate } from './SignInGate';
import { ToolsView } from './ToolsView';
import { AgentWizard } from './AgentWizard';
import { harnessBrand, providerBrand } from '../../../../shared/design/AgentLogos';
import { Wordmark } from '../../../../shared/design/Brand';
import { TitleBarTools, type Theme } from './TitleBarTools';

// Console client conventions: inline styles + theme tokens + mono() — see
// docs/development-standards.md "Client code". mono() mirrors client/src/util.ts.
const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

const NAV_ICON = { size: 15, strokeWidth: 1.75 } as const;
const NAV = [
  { id: 'projects', label: 'Projects', icon: <FolderKanban {...NAV_ICON} /> },
  { id: 'workflows', label: 'Workflows', icon: <Workflow {...NAV_ICON} /> },
  { id: 'agents', label: 'Agents', icon: <Bot {...NAV_ICON} /> },
  { id: 'tools', label: 'Agent Tools', icon: <Wrench {...NAV_ICON} /> },
  { id: 'metrics', label: 'Metrics', icon: <Gauge {...NAV_ICON} /> },
  { id: 'identity', label: 'Identity', icon: <KeyRound {...NAV_ICON} /> },
  { id: 'sync', label: 'Sync', icon: <RefreshCw {...NAV_ICON} /> },
  { id: 'deploys', label: 'Deploys', icon: <Rocket {...NAV_ICON} /> },
] as const;
/** Pinned to the bottom of the sidebar, below the surfaces. */
const NAV_FOOTER = [{ id: 'settings', label: 'Settings', icon: <Settings {...NAV_ICON} /> }] as const;

type NavId = (typeof NAV)[number]['id'] | (typeof NAV_FOOTER)[number]['id'];

function TitleBar({ theme, onToggleTheme, onOpenTicket }: { theme: Theme; onToggleTheme: () => void; onOpenTicket: (key: string) => void }) {
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
      <Wordmark size={18} color="var(--tx2)" />
      <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>desktop</span>
      <div style={{ flex: 1 }} />
      <TitleBarTools theme={theme} onToggleTheme={onToggleTheme} onOpenTicket={onOpenTicket} />
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

/* ------------------------------------------------------------------ console */

/**
 * Projects IS the web console (DAT-232): the deployed app rendered in a
 * webview whose session gets the dev's workspace bearer token injected by
 * the main process — full board/drawer/planning parity with zero duplicated
 * UI, signed in as you without a second login. Workflows, Metrics and
 * Settings are the same webview routed to those console pages; the console
 * renders no top bar of its own inside the shell, so this sidebar is the
 * only navigation.
 */
/** Console sections the sidebar can open in the one embedded webview, and the console path each routes to. */
type ConsoleSection = 'projects' | 'workflows' | 'metrics' | 'settings';
const CONSOLE_PATHS: Record<ConsoleSection, string> = {
  projects: '/projects',
  workflows: '/workflows',
  metrics: '/metrics',
  settings: '/settings',
};
const isConsoleSection = (id: string): id is ConsoleSection => id in CONSOLE_PATHS;
/** Which sidebar entry a console pathname belongs to (/admin is Settings' old URL). */
const sectionOfPath = (pathname: string): ConsoleSection =>
  pathname.startsWith('/workflows')
    ? 'workflows'
    : pathname.startsWith('/metrics')
      ? 'metrics'
      : pathname.startsWith('/settings') || pathname.startsWith('/admin')
        ? 'settings'
        : 'projects';

type WebviewEl = HTMLElement & {
  executeJavaScript?: (code: string) => Promise<unknown>;
  getURL?: () => string;
  loadURL?: (url: string) => Promise<void>;
  reload?: () => void;
};

/**
 * Run a snippet in the embedded console. executeJavaScript throws
 * synchronously until the guest's dom-ready has fired and rejects on a
 * crashed or error page; both mean "nothing to do right now", never an
 * error for the shell.
 */
const runInConsole = (wv: HTMLElement | null, code: string): void => {
  try {
    void (wv as WebviewEl | null)?.executeJavaScript?.(code).catch(() => undefined);
  } catch {
    /* not attached or not ready yet */
  }
};

/** Reload backoff after the console fails to load: 1.5s, 3s, 6s, then every 10s, giving up after 2 min. */
const RETRY_DELAYS_MS = [1_500, 3_000, 6_000];
const RETRY_STEADY_MS = 10_000;
const RETRY_CAP_MS = 120_000;
/** Errors that are not a failure to reach the console: -3 ERR_ABORTED (a navigation superseded by another). */
const IGNORED_LOAD_ERRORS = new Set([-3]);

function ConsoleView({
  section,
  onSectionChange,
  reloadToken,
  theme,
  ticketRequest,
}: {
  section: ConsoleSection;
  /** The console moved on its own (palette command, link) — keep the sidebar lit accordingly. */
  onSectionChange: (section: ConsoleSection) => void;
  /** Bumped by the sidebar's ↻; each change reloads the webview. */
  reloadToken: number;
  /** The shell's theme; pushed into the console so both switch together. */
  theme: Theme;
  /** A ticket to open in the console (title-bar bell); `seq` makes repeats distinct. */
  ticketRequest: { key: string; seq: number } | null;
}) {
  const [cfg, setCfg] = useState<Awaited<ReturnType<DesktopBridge['getConfig']>> | null>(null);
  const [auth, setAuth] = useState<AuthMode | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState('');
  const viewRef = useRef<HTMLElement | null>(null);
  // The console failed to load (dev server restarting, network gone): what
  // the pill over the webview says, or null while it is reachable.
  const [unreachable, setUnreachable] = useState<string | null>(null);

  useEffect(() => {
    void window.desktopBridge.getConfig().then(setCfg);
    void window.desktopBridge.authStatus().then((s) => setAuth(s.mode));
  }, []);

  // Where Projects last was (a board, a ticket) — the app routes by URL, so
  // switching sections and coming back lands there, and a restart reopens
  // it instead of the portfolio. Never a Workflows/Metrics/Settings URL.
  const projectsPath = useRef(CONSOLE_PATHS.projects);
  const sectionRef = useRef<ConsoleSection>('projects');
  useEffect(() => {
    const wv = viewRef.current;
    if (!wv || !cfg) return;
    const onNavigate = (e: Event) => {
      const url = (e as unknown as { url?: string }).url;
      if (typeof url !== 'string' || !url.startsWith(cfg.consoleUrl)) return;
      const next = sectionOfPath(new URL(url).pathname);
      sectionRef.current = next;
      onSectionChange(next);
      if (next !== 'projects') return;
      try {
        localStorage.setItem('console-last-url', url);
      } catch {
        // storage unavailable — restart lands on the portfolio, no harm
      }
    };
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    return () => {
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
    };
  }, [cfg, auth, onSectionChange]);

  // Sidebar → console section (DAT-284). The webview stays mounted, so this
  // routes inside the running SPA (pushState + popstate, which its router
  // listens to) instead of reloading it: Projects keeps its place while you
  // look at Workflows or Settings, and comes back exactly where it was.
  useEffect(() => {
    const wv = viewRef.current as WebviewEl | null;
    if (!wv || !cfg || auth === 'signed-out' || sectionRef.current === section) return;
    try {
      const current = wv.getURL ? new URL(wv.getURL()) : null;
      if (current && sectionOfPath(current.pathname) === 'projects') {
        projectsPath.current = current.pathname + current.search;
      }
      const to = section === 'projects' ? projectsPath.current : CONSOLE_PATHS[section];
      runInConsole(wv, `history.pushState({}, '', ${JSON.stringify(to)}); dispatchEvent(new PopStateEvent('popstate'));`);
      sectionRef.current = section;
    } catch {
      // The webview is not ready yet; the next sidebar click tries again.
    }
  }, [section, cfg, auth]);

  // Theme: the console reads `eec-theme` from its own localStorage at boot
  // and listens for storage events on that key, so writing it and firing
  // the event switches the running page at once; dom-ready re-applies it
  // after a reload or a fresh start.
  useEffect(() => {
    const wv = viewRef.current;
    if (!wv || !cfg) return;
    // Before the guest's dom-ready this is a no-op; the listener below re-runs it.
    const push = () =>
      runInConsole(
        wv,
        `localStorage.setItem('eec-theme', ${JSON.stringify(theme)}); dispatchEvent(new StorageEvent('storage', { key: 'eec-theme', newValue: ${JSON.stringify(theme)} }));`,
      );
    push();
    wv.addEventListener('dom-ready', push);
    return () => wv.removeEventListener('dom-ready', push);
  }, [theme, cfg, auth]);

  // Title-bar bell → the ticket's drawer, inside the running SPA.
  useEffect(() => {
    const wv = viewRef.current;
    if (!wv || !cfg || !ticketRequest || auth === 'signed-out') return;
    const to = `/tickets/${encodeURIComponent(ticketRequest.key)}`;
    runInConsole(wv, `history.pushState({}, '', ${JSON.stringify(to)}); dispatchEvent(new PopStateEvent('popstate'));`);
  }, [ticketRequest, cfg, auth]);

  const initialUrl = (() => {
    if (!cfg) return '';
    try {
      const saved = localStorage.getItem('console-last-url');
      return saved && saved.startsWith(cfg.consoleUrl) ? saved : cfg.consoleUrl;
    } catch {
      return cfg.consoleUrl;
    }
  })();

  // A failed load (ERR_CONNECTION_REFUSED while the dev server restarts, the
  // network dropping) would otherwise sit on Chromium's error page until
  // someone clicks ↻. Retry the URL that failed with backoff until a load
  // finishes, and say so over the webview meanwhile.
  const retry = useRef<{ attempt: number; since: number; timer: ReturnType<typeof setTimeout> | null }>({ attempt: 0, since: 0, timer: null });
  useEffect(() => {
    const wv = viewRef.current as WebviewEl | null;
    if (!wv || !cfg) return;
    const state = retry.current;
    const clear = () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    };
    const onFail = (e: Event) => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } = e as unknown as {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      };
      if (isMainFrame === false || (typeof errorCode === 'number' && IGNORED_LOAD_ERRORS.has(errorCode))) return;
      const now = Date.now();
      if (state.attempt === 0) state.since = now;
      clear();
      if (now - state.since > RETRY_CAP_MS) {
        setUnreachable('CONSOLE UNREACHABLE — PRESS ↻ TO RETRY');
        return;
      }
      setUnreachable(`CONSOLE UNREACHABLE${errorDescription ? ` (${errorDescription})` : ''} — RETRYING…`);
      const delay = RETRY_DELAYS_MS[state.attempt] ?? RETRY_STEADY_MS;
      state.attempt += 1;
      const url = validatedURL && validatedURL.startsWith(cfg.consoleUrl) ? validatedURL : initialUrl || cfg.consoleUrl;
      state.timer = setTimeout(() => {
        state.timer = null;
        try {
          void wv.loadURL?.(url).catch(() => undefined); // failure fires did-fail-load again
        } catch {
          /* not attached — the next did-fail-load reschedules */
        }
      }, delay);
    };
    const onLoaded = () => {
      // Chromium's own error page also finishes loading; that is not a success.
      let url = '';
      try {
        url = wv.getURL?.() ?? '';
      } catch {
        /* not attached */
      }
      if (url.startsWith('chrome-error://')) return;
      clear();
      state.attempt = 0;
      setUnreachable(null);
    };
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('did-finish-load', onLoaded);
    return () => {
      clear();
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('did-finish-load', onLoaded);
    };
  }, [cfg, auth, initialUrl]);

  // ↻ lives in the sidebar footer now that the console has no bar of its own.
  // It also starts a fresh retry cycle after the backoff gave up.
  useEffect(() => {
    if (reloadToken === 0) return;
    retry.current.attempt = 0;
    if (retry.current.timer) clearTimeout(retry.current.timer);
    retry.current.timer = null;
    try {
      (viewRef.current as WebviewEl | null)?.reload?.();
    } catch {
      /* not attached */
    }
  }, [reloadToken]);

  const signIn = async () => {
    setSigningIn(true);
    setSignInError('');
    const res = await window.desktopBridge.authLogin();
    setSigningIn(false);
    if (res.ok) setAuth(res.status.mode);
    else setSignInError(res.error);
  };

  if (!cfg || auth === null) return null;

  if (auth === 'signed-out') {
    return (
      <div style={{ padding: 28, display: 'grid', gap: 12, maxWidth: 480 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          {cfg.activeEnvironment ? `Sign in to ${cfg.activeEnvironment.label}` : 'Console'}
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)', lineHeight: 1.5 }}>
          The full console loads here once you&rsquo;re signed in to Databricks
          {cfg.activeEnvironment ? ` for the ${cfg.activeEnvironment.label} environment` : ''}.
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
    <div style={{ flex: 1, minHeight: 0, display: 'flex', position: 'relative' }}>
      <webview
        ref={(el: HTMLElement | null) => {
          viewRef.current = el;
        }}
        src={initialUrl}
        partition="persist:console"
        style={{ flex: 1, minHeight: 0 }}
      />
      {unreachable && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 4,
            background: 'var(--bg3)',
            border: '1px solid var(--line2)',
            color: 'var(--warn)',
            boxShadow: '0 8px 30px rgba(0,0,0,.4)',
            ...mono(500, 10),
            letterSpacing: '.08em',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--warn)', animation: 'eec-pulse 2.4s infinite' }} />
          {unreachable}
        </div>
      )}
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
/** Console harness ids, for the logo of each agent type. */
const KIND_HARNESS: Record<AgentKind, string> = { claude: 'claude-code', codex: 'codex' };

/**
 * One configured agent on this machine (DAT-280): logo, instances, model,
 * projects, tools. Click → the wizard, at the model step.
 */
function AgentCard({
  kind,
  config,
  instances,
  engagements,
  onConfigure,
  onStartAll,
  onStopAll,
}: {
  kind: AgentKind;
  config: AgentsState['kinds'][AgentKind];
  instances: InstanceSnapshot[];
  engagements: EngagementRow[];
  onConfigure: () => void;
  onStartAll: () => void;
  onStopAll: () => void;
}) {
  const brand = harnessBrand(KIND_HARNESS[kind]);
  const running = instances.filter((i) => i.state === 'running' || i.state === 'completing').length;
  const waiting = instances.filter((i) => i.state === 'waiting').length;
  const stopped = instances.filter((i) => i.state === 'stopped').length;
  const provider = providerBrand(kind === 'codex' ? 'openai' : 'anthropic');
  return (
    <div
      className="hv-lift"
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        padding: '16px 16px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ display: 'inline-flex', width: 46, height: 46, borderRadius: 11, background: 'var(--bg3)', border: '1px solid var(--line2)', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          {brand?.mark(28)}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{brand?.label ?? kind}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono(400, 9.5), color: 'var(--tx3)', letterSpacing: '.06em', marginTop: 2 }}>
            {running > 0 && <span style={{ color: 'var(--ok)' }}>● {running} RUNNING</span>}
            {waiting > 0 && <span style={{ color: 'var(--agent)' }}>● {waiting} WAITING</span>}
            {stopped > 0 && <span>● {stopped} STOPPED</span>}
            {instances.length === 0 && <span>NO INSTANCES</span>}
          </div>
        </div>
        {!config.installed && <span title="Not found on PATH" style={{ ...mono(500, 8.5), color: 'var(--warn)', border: '1px solid var(--warn)', borderRadius: 3, padding: '1px 6px', letterSpacing: '.08em' }}>NOT INSTALLED</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Chip>
          {provider && <span style={{ display: 'inline-flex', marginRight: 5 }}>{provider.mark(11)}</span>}
          {config.model ?? 'default model'}
        </Chip>
        {config.projects.length === 0 ? (
          <Chip>any project</Chip>
        ) : (
          config.projects.map((id) => <Chip key={id}>{engagements.find((e) => e.id === id)?.client ?? id}</Chip>)
        )}
        <Chip>{config.mcpServers.length + 1} MCP</Chip>
        <Chip>{config.skills.length} skill{config.skills.length === 1 ? '' : 's'}</Chip>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="no-drag" onClick={onConfigure} style={{ ...btnStyle('var(--tx2)'), padding: '6px 12px', fontSize: 12 }}>
          ⚙ Configure
        </button>
        <div style={{ flex: 1 }} />
        {stopped > 0 && (
          <button className="no-drag" onClick={onStartAll} style={{ ...btnStyle('var(--ok)'), padding: '6px 12px', fontSize: 12 }}>
            ▶ Start
          </button>
        )}
        {waiting > 0 && (
          <button className="no-drag" onClick={onStopAll} style={{ ...btnStyle('var(--warn)'), padding: '6px 12px', fontSize: 12 }}>
            ■ Stop
          </button>
        )}
      </div>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', ...mono(500, 9.5), letterSpacing: '.04em', color: 'var(--tx2)', background: 'var(--bg3)', border: '1px solid var(--line)', borderRadius: 4, padding: '3px 8px', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function AgentsView({ onActivity }: { onActivity: (active: boolean) => void }) {
  const [agents, setAgents] = useState<AgentsState | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [work, setWork] = useState<{ queued: AgentTaskRow[]; active: AgentTaskRow[] } | null>(null);
  const [runError, setRunError] = useState('');
  // The new-agent / configure wizard (DAT-280): null = closed, 'new' = pick an agent, kind = reconfigure it.
  const [wizard, setWizard] = useState<'new' | AgentKind | null>(null);
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  useEffect(() => {
    void window.desktopBridge.listEngagements().then((r) => {
      if (r.ok) setEngagements(r.engagements);
    });
  }, []);
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

  const configure = (kind: AgentKind, opts: Partial<AgentKindConfig>) =>
    void window.desktopBridge.agentsConfigure(kind, opts).then(apply);

  const act = (fn: (id: string) => Promise<AgentsState>, id: string) => () => void fn(id).then(apply);

  const selected = agents?.instances.find((i) => i.id === tab) ?? null;

  // The live feed follows the newest line — like a terminal — unless the
  // user has scrolled up to read something, in which case it stays put until
  // they return to the bottom (within a couple of lines).
  const feedRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const feedLength = selected?.feed.length ?? 0;
  useEffect(() => {
    const el = feedRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [feedLength, tab]);
  const onFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };
  const liveIds = new Set((agents?.instances ?? []).map((i) => i.current?.taskId).filter((x) => x != null));

  const lineColor: Record<RunnerEvent['kind'], string> = {
    status: 'var(--agent)',
    print: 'var(--tx2)',
    tool: 'var(--tx)',
    note: 'var(--tx3)',
    error: 'var(--bad)',
    usage: 'var(--ok)',
  };

  const stateColor = (s: RunnerState): string =>
    s === 'running' || s === 'completing' ? 'var(--ok)' : s === 'waiting' ? 'var(--agent)' : 'var(--tx3)';

  return (
    <div style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 14, height: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Agents</h2>
        <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>
          coding agents running on this machine — managed here; the web console mirrors what they report
        </span>
      </div>

      {/* Agents on this machine: one card per configured type, plus New agent. */}
      {agents && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
          {(Object.keys(agents.kinds) as AgentKind[])
            .filter((kind) => agents.kinds[kind].instances > 0)
            .map((kind) => (
              <AgentCard
                key={kind}
                kind={kind}
                config={agents.kinds[kind]}
                instances={agents.instances.filter((i) => i.kind === kind)}
                engagements={engagements}
                onConfigure={() => setWizard(kind)}
                onStartAll={() => {
                  for (const i of agents.instances) if (i.kind === kind && i.state === 'stopped') void window.desktopBridge.agentsStart(i.id).then(apply);
                }}
                onStopAll={() => {
                  for (const i of agents.instances) if (i.kind === kind && i.state === 'waiting') void window.desktopBridge.agentsStop(i.id).then(apply);
                }}
              />
            ))}
          <button
            className="no-drag hv-lift"
            onClick={() => setWizard('new')}
            style={{
              minHeight: 132,
              border: '1px dashed var(--line2)',
              borderRadius: 12,
              background: 'transparent',
              color: 'var(--tx2)',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              fontFamily: 'inherit',
            }}
          >
            <span style={{ fontSize: 26, lineHeight: 1, color: 'var(--agent)' }}>+</span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>New agent</span>
          </button>
        </div>
      )}

      {wizard && agents && (
        <AgentWizard
          kinds={agents.kinds}
          initialKind={wizard === 'new' ? undefined : wizard}
          onClose={() => setWizard(null)}
          onApply={async ({ kind, config }) => {
            const next = await window.desktopBridge.agentsConfigure(kind, config);
            apply(next);
          }}
        />
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
          No agents yet — click New agent above.
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
                ref={feedRef}
                onScroll={onFeedScroll}
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
                        : ev.kind === 'usage'
                          ? `  ≋ ${ev.final ? 'total' : '+'}${ev.input} in / ${ev.final ? '' : '+'}${ev.output} out tokens${ev.costUsd != null ? ` · $${ev.costUsd.toFixed(2)}` : ''}`
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


/* -------------------------------------------------------------------- app */

const VIEWS_STATIC: Partial<Record<NavId, ReactNode>> = {
  sync: (
    <Placeholder
      title="Sync"
      note="The managed file store: context, prompts, skills and standards synced through a git-backed allowlist manifest — nothing unlisted ever leaves this machine."
    />
  ),
};

/**
 * Sidebar footer (DAT-237): a quiet version label, and a real button the
 * moment a newer build is downloaded. The label's tooltip carries the
 * updater's state; clicking it checks the feed. The button restarts into
 * the new build — unless an agent is mid-run, in which case the main process
 * refuses and the reason shows in place of the button for a moment.
 */
function VersionBadge() {
  const [st, setSt] = useState<UpdateStatusView | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    void window.desktopBridge.updatesStatus().then(setSt);
    return window.desktopBridge.onUpdatesEvent(setSt);
  }, []);
  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => setRefused(null), 6000);
    return () => clearTimeout(t);
  }, [refused]);
  if (!st) return null;
  const s = st.state;
  const title =
    s.status === 'up-to-date'
      ? `Up to date (checked ${new Date(s.checkedAt).toLocaleTimeString()}). Click to check again.`
      : s.status === 'error'
        ? `Update check failed: ${s.message}\nClick to try again.`
        : s.status === 'disabled'
          ? `This install does not self-update: ${s.reason}.`
          : s.status === 'downloading'
            ? `Downloading v${s.version} (${s.percent}%).`
            : s.status === 'downloaded'
              ? `v${s.version} is ready; it installs when you quit, or now with the button.`
              : 'Checking GitHub Releases for a newer build.';
  const install = () => {
    void window.desktopBridge.updatesInstall().then((r) => {
      if (!r.ok) setRefused(r.error);
    });
  };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <button
        className="no-drag"
        title={title}
        onClick={() => {
          if (s.status !== 'disabled' && s.status !== 'downloading' && s.status !== 'downloaded') void window.desktopBridge.updatesCheck().then(setSt);
        }}
        style={{ ...mono(400, 9.5), border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: s.status === 'error' ? 'var(--bad)' : 'var(--tx3)', whiteSpace: 'nowrap' }}
      >
        v{st.version}
        {st.channel === 'staging' ? ' staging' : ''}
        {s.status === 'checking' ? ' ·' : s.status === 'downloading' ? ` · ${s.percent}%` : ''}
      </button>
      {s.status === 'downloaded' && !refused && (
        <button
          className="no-drag hv-lift"
          onClick={install}
          title={`Restart into v${s.version} now`}
          style={{ ...mono(600, 9.5), letterSpacing: '.04em', border: 'none', borderRadius: 3, background: 'var(--acc)', color: '#fff', padding: '3px 8px', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Update to v{s.version}
        </button>
      )}
      {refused && <span style={{ ...mono(400, 9.5), color: 'var(--warn)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }} title={refused}>{refused}</span>}
    </span>
  );
}

/**
 * First-launch environment picker: which console deployment this
 * desktop signs in to. Shown until a choice is persisted (or `APP_URL` pins
 * the console for a dev run). The staging build preselects Staging so a
 * tester's path is Continue → Sign in; Production is never silently chosen
 * on that channel. Choosing relaunches the app — see `env:select` in main.
 */
function EnvironmentPicker({ cfg }: { cfg: DesktopConfigView }) {
  const recommended = cfg.channel === 'staging' ? 'staging' : 'production';
  const [choice, setChoice] = useState<string>(() =>
    cfg.environments.some((e) => e.id === recommended) ? recommended : cfg.environments[0].id,
  );
  const [state, setState] = useState<'idle' | 'restarting' | 'error'>('idle');
  const [error, setError] = useState('');
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  const confirm = async () => {
    setState('restarting');
    const res = await window.desktopBridge.selectEnvironment(choice);
    if (!res.ok) {
      setError(res.error);
      setState('error');
    }
  };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', background: 'var(--bg)', overflowY: 'auto' }}>
      <div style={{ width: 520, maxWidth: '92%', display: 'grid', gap: 18, padding: '32px 0' }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Choose an environment</h2>
            {cfg.channel === 'staging' && (
              <span
                style={{
                  ...mono(600, 9.5),
                  letterSpacing: '.12em',
                  color: 'var(--warn)',
                  border: '1px solid var(--warn)',
                  borderRadius: 4,
                  padding: '2px 6px',
                }}
              >
                STAGING BUILD
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--tx2)', lineHeight: 1.5 }}>
            Where should Cometloop sign in? You can switch later from the Identity page.
          </p>
        </div>
        <div role="radiogroup" style={{ display: 'grid', gap: 8 }}>
          {cfg.environments.map((env) => {
            const selected = env.id === choice;
            return (
              <button
                key={env.id}
                role="radio"
                aria-checked={selected}
                className="no-drag hv-lift"
                onClick={() => setChoice(env.id)}
                disabled={state === 'restarting'}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '18px 1fr auto',
                  alignItems: 'center',
                  gap: 12,
                  textAlign: 'left',
                  background: selected ? 'var(--bg3)' : 'var(--bg2)',
                  border: `1px solid ${selected ? 'var(--acc)' : 'var(--line)'}`,
                  borderRadius: 8,
                  padding: '12px 14px',
                  cursor: state === 'restarting' ? 'wait' : 'pointer',
                  color: 'var(--tx)',
                  fontFamily: 'inherit',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    border: `2px solid ${selected ? 'var(--acc)' : 'var(--tx3)'}`,
                    background: selected ? 'var(--acc)' : 'transparent',
                    boxShadow: selected ? 'inset 0 0 0 3px var(--bg3)' : 'none',
                  }}
                />
                <span style={{ display: 'grid', gap: 3 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
                    {env.label}
                    {env.id === recommended && (
                      <span style={{ ...mono(500, 9.5), color: 'var(--acc)', letterSpacing: '.08em' }}>RECOMMENDED</span>
                    )}
                  </span>
                  {env.note && <span style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.45 }}>{env.note}</span>}
                </span>
                <span style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>{hostOf(env.consoleUrl)}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="no-drag hv-lift"
            onClick={() => void confirm()}
            disabled={state === 'restarting'}
            style={{
              background: 'var(--acc)',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '9px 18px',
              fontSize: 13,
              fontWeight: 600,
              cursor: state === 'restarting' ? 'wait' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {state === 'restarting' ? 'Restarting…' : 'Continue'}
          </button>
          <span style={{ fontSize: 12, color: 'var(--tx3)' }}>Next: sign in to the workspace that fronts it.</span>
        </div>
        {state === 'error' && <div style={{ fontSize: 12, color: 'var(--bad)' }}>{error}</div>}
      </div>
    </div>
  );
}

export function App() {
  const [nav, setNav] = useState<NavId>('projects');
  // Environment gate: nothing else mounts until a console is chosen.
  const [cfg, setCfg] = useState<DesktopConfigView | null>(null);
  // Sign-in gate: nothing of the shell mounts until the desktop holds a
  // sign-in for that console (SignInGate). The main process starts agents
  // and polling only after the same event.
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  useEffect(() => {
    void window.desktopBridge.getConfig().then(setCfg);
    void window.desktopBridge.authStatus().then(setAuthStatus);
  }, []);
  // The console section the webview shows — or last showed, while a native
  // view sits on top — so coming back to it finds it unchanged.
  const [consoleSection, setConsoleSection] = useState<ConsoleSection>('projects');
  const [reloadToken, setReloadToken] = useState(0);
  const [agentsActive, setAgentsActive] = useState(false);
  // Same key and values as the web console, so one choice covers both.
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('eec-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('eec-theme', theme);
    } catch {
      // storage unavailable — the choice lasts for this run
    }
  }, [theme]);
  const [ticketRequest, setTicketRequest] = useState<{ key: string; seq: number } | null>(null);
  const openTicket = useCallback((key: string) => {
    setNav('projects');
    setConsoleSection('projects');
    setTicketRequest((r) => ({ key, seq: (r?.seq ?? 0) + 1 }));
  }, []);
  const go = (id: NavId) => {
    setNav(id);
    if (isConsoleSection(id)) setConsoleSection(id);
  };
  // The console navigated on its own (palette, link, redirect): follow it.
  const onSectionChange = useCallback((s: ConsoleSection) => {
    setConsoleSection(s);
    setNav((n) => (isConsoleSection(n) ? s : n));
  }, []);
  // The embedded console stays mounted no matter which entry is active —
  // unmounting the webview would reset it to the portfolio, so leaving
  // Projects and coming back must find you exactly where you were. Hidden
  // via visibility (not display:none, which breaks Electron webviews).
  const overlay =
    nav === 'agents' ? (
      <AgentsView onActivity={setAgentsActive} />
    ) : nav === 'deploys' ? (
      <DeploysView />
    ) : nav === 'identity' ? (
      <IdentityView />
    ) : nav === 'tools' ? (
      <ToolsView />
    ) : isConsoleSection(nav) ? null : (
      VIEWS_STATIC[nav]
    );
  const navButton = (n: { id: NavId; label: string; icon: ReactNode }) => (
    <button
      key={n.id}
      className="no-drag"
      onClick={() => go(n.id)}
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
        justifyContent: 'flex-start',
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ color: nav === n.id ? 'var(--acc)' : 'var(--tx3)', width: 16, display: 'inline-flex', justifyContent: 'center' }}>
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
  );
  if (!cfg || !authStatus) return null;
  if (!cfg.envOverride && !cfg.activeEnvironment) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <TitleBar theme={theme} onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} onOpenTicket={openTicket} />
        <EnvironmentPicker cfg={cfg} />
      </div>
    );
  }
  if (authStatus.mode === 'signed-out') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <TitleBar theme={theme} onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} onOpenTicket={openTicket} />
        <SignInGate
          status={authStatus}
          environmentLabel={cfg.envOverride ? 'Local override' : (cfg.activeEnvironment?.label ?? 'Console')}
          onStatus={setAuthStatus}
          onSignedIn={setAuthStatus}
        />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TitleBar theme={theme} onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} onOpenTicket={openTicket} />
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
          {NAV.map(navButton)}
          <div style={{ flex: 1 }} />
          {NAV_FOOTER.map(navButton)}
          <div style={{ display: 'flex', alignItems: 'center', padding: '4px 10px 6px' }}>
            <VersionBadge />
            <div style={{ flex: 1 }} />
            <button
              className="no-drag"
              title="Reload the console"
              onClick={() => setReloadToken((n) => n + 1)}
              style={{ border: 'none', background: 'none', color: 'var(--tx3)', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}
            >
              ↻
            </button>
          </div>
        </nav>
        <main style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              visibility: isConsoleSection(nav) ? 'visible' : 'hidden',
            }}
          >
            <ConsoleView
              section={consoleSection}
              onSectionChange={onSectionChange}
              reloadToken={reloadToken}
              theme={theme}
              ticketRequest={ticketRequest}
            />
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
