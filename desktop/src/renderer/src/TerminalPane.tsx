import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// Interactive terminal pane (DAT-240): xterm.js over the main process's
// node-pty sessions — the VS Code integrated-terminal pattern, docked at the
// bottom of the Runs view. Sessions live in the main process; this component
// only renders the active one, re-attaching (bounded scrollback replay +
// seq-deduped live stream) whenever the pane remounts or the tab changes.

const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

/** xterm theme from the console's design tokens (plus a fixed ANSI ramp). */
function xtermTheme(): ITheme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--bg2', '#10151a'),
    foreground: v('--tx', '#e7ebef'),
    cursor: v('--acc', '#ff3621'),
    cursorAccent: v('--bg2', '#10151a'),
    selectionBackground: 'rgba(122, 143, 245, 0.30)',
    black: '#1c252c',
    red: v('--bad', '#ff4d33'),
    green: v('--ok', '#37b57a'),
    yellow: v('--warn', '#e8a13c'),
    blue: v('--agent', '#7a8ff5'),
    magenta: '#c792ea',
    cyan: '#6bc7d6',
    white: v('--tx', '#e7ebef'),
    brightBlack: v('--tx3', '#5e6e7b'),
    brightRed: '#ff6d57',
    brightGreen: '#54d695',
    brightYellow: '#ffbb58',
    brightBlue: '#93a5ff',
    brightMagenta: '#dcb0f2',
    brightCyan: '#8fdbe8',
    brightWhite: '#ffffff',
  };
}

const HEIGHT_KEY = 'terminal-pane-height';
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;

export interface TerminalOpenRequest {
  taskId: number;
  ticketKey: string;
  /** Changes per request so repeat clicks on the same task re-trigger. */
  nonce: number;
}

export function TerminalPane({
  current,
  openRequest,
  open,
  onToggle,
}: {
  /** The run in flight on this machine, if any — the default cwd for + new. */
  current: { taskId: number; ticketKey: string } | null;
  /** A task row asked for a shell in its workdir (⌨ on active tasks). */
  openRequest: TerminalOpenRequest | null;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [height, setHeight] = useState(() => {
    const saved = Number(localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(saved) && saved >= MIN_HEIGHT && saved <= MAX_HEIGHT ? saved : 260;
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handledNonce = useRef<number>(-1);

  // Sessions survive view unmounts in the main process — pick them back up.
  useEffect(() => {
    void window.desktopBridge.terminalList().then(setSessions);
    return window.desktopBridge.onTerminalEvent((ev) => {
      if (ev.kind === 'exit') {
        setSessions((s) => s.map((t) => (t.id === ev.id ? { ...t, live: false, exitCode: ev.exitCode } : t)));
      } else if (ev.kind === 'closed') {
        setSessions((s) => s.filter((t) => t.id !== ev.id));
        setActiveId((cur) => (cur === ev.id ? null : cur));
      }
    });
  }, []);

  // No active tab but sessions exist (initial pickup, or the active one was
  // closed) → focus the most recent.
  useEffect(() => {
    if (activeId == null && sessions.length > 0) setActiveId(sessions[sessions.length - 1].id);
  }, [activeId, sessions]);

  const openTerminal = useCallback(
    async (task: { taskId: number; ticketKey: string } | null) => {
      setError('');
      const res = await window.desktopBridge.terminalCreate(task ?? undefined);
      if (!res.ok) {
        setError(res.error);
        onToggle(true);
        return;
      }
      setSessions((s) => [...s, res.info]);
      setActiveId(res.info.id);
      onToggle(true);
    },
    [onToggle],
  );

  // ⌨ on a task row: open (or reveal) a shell in that task's workdir.
  useEffect(() => {
    if (!openRequest || openRequest.nonce === handledNonce.current) return;
    handledNonce.current = openRequest.nonce;
    void openTerminal({ taskId: openRequest.taskId, ticketKey: openRequest.ticketKey });
  }, [openRequest, openTerminal]);

  // One xterm instance, showing the active session. Attach protocol: replay
  // the main-process buffer, then only live events with seq > lastSeq — the
  // seq handshake closes the subscribe/attach race without double-painting.
  useEffect(() => {
    const el = containerRef.current;
    if (!open || activeId == null || !el) return;
    const id = activeId;
    const term = new Terminal({
      fontFamily: "'DM Mono', monospace",
      fontSize: 12.5,
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 5000,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit(); // size the grid before any content lands

    let attached = false;
    let lastSeq = Number.MAX_SAFE_INTEGER; // drop everything until attach resolves
    const queued: { seq: number; data: string }[] = [];
    const offEvents = window.desktopBridge.onTerminalEvent((ev) => {
      if (ev.id !== id) return;
      if (ev.kind === 'data') {
        if (attached) {
          if (ev.seq > lastSeq) {
            lastSeq = ev.seq;
            term.write(ev.data);
          }
        } else {
          queued.push({ seq: ev.seq, data: ev.data });
        }
      } else if (ev.kind === 'exit') {
        term.write(`\r\n\x1b[2m[process exited with code ${ev.exitCode}]\x1b[0m\r\n`);
      }
    });
    void window.desktopBridge.terminalAttach(id).then((res) => {
      if (!res.ok) {
        setError(res.error);
        return;
      }
      term.write(res.buffer);
      lastSeq = res.lastSeq;
      for (const q of queued) {
        if (q.seq > lastSeq) {
          lastSeq = q.seq;
          term.write(q.data);
        }
      }
      queued.length = 0;
      attached = true;
      fit.fit();
      window.desktopBridge.terminalResize(id, term.cols, term.rows);
      term.focus();
    });
    const onData = term.onData((d) => window.desktopBridge.terminalInput(id, d));
    const ro = new ResizeObserver(() => {
      fit.fit();
      window.desktopBridge.terminalResize(id, term.cols, term.rows);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      offEvents();
      onData.dispose();
      term.dispose();
    };
  }, [open, activeId]);

  // VS Code-style drag-to-resize on the pane's top edge.
  const startDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => {
      const h = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY)));
      setHeight(h);
      localStorage.setItem(HEIGHT_KEY, String(h));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const closeSession = (id: number) => {
    void window.desktopBridge.terminalDispose(id);
    // list + active update arrive via the 'closed' event
  };

  if (!open) return null;

  return (
    <div
      style={{
        flex: 'none',
        height,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg2)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        onMouseDown={startDrag}
        title="Drag to resize"
        style={{ height: 4, cursor: 'ns-resize', flex: 'none', background: 'transparent' }}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '2px 10px 6px',
          borderBottom: '1px solid var(--line)',
          flex: 'none',
        }}
      >
        <span style={{ ...mono(500, 9.5), color: 'var(--tx3)', letterSpacing: '.08em' }}>⌨ TERMINAL</span>
        {sessions.map((s) => (
          <span
            key={s.id}
            onClick={() => setActiveId(s.id)}
            style={{
              ...mono(500, 10),
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '2px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              color: s.id === activeId ? 'var(--tx)' : s.live ? 'var(--tx2)' : 'var(--tx3)',
              background: s.id === activeId ? 'var(--bg3)' : 'transparent',
              border: `1px solid ${s.id === activeId ? 'var(--line2)' : 'transparent'}`,
              textDecoration: s.live ? 'none' : 'line-through',
            }}
            title={s.cwd + (s.live ? '' : ` — exited (${s.exitCode})`)}
          >
            {s.title}
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeSession(s.id);
              }}
              title="Close terminal"
              style={{ color: 'var(--tx3)', cursor: 'pointer', fontSize: 11 }}
            >
              ×
            </span>
          </span>
        ))}
        <button
          className="no-drag"
          onClick={() => void openTerminal(current)}
          title={current ? `New terminal in ${current.ticketKey}'s workdir` : 'New terminal in the work root'}
          style={{
            border: 'none',
            background: 'none',
            color: 'var(--tx2)',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 4px',
            fontFamily: 'inherit',
          }}
        >
          +
        </button>
        <div style={{ flex: 1 }} />
        {error && <span style={{ fontSize: 11, color: 'var(--bad)' }}>{error}</span>}
        <button
          className="no-drag"
          onClick={() => onToggle(false)}
          title="Hide the terminal pane (sessions keep running)"
          style={{
            border: 'none',
            background: 'none',
            color: 'var(--tx3)',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          ▾
        </button>
      </div>
      {activeId == null ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--tx3)', fontSize: 12 }}>
          No terminals — press + for a shell{current ? ` in ${current.ticketKey}'s workdir` : ' in the work root'}.
        </div>
      ) : (
        <div ref={containerRef} style={{ flex: 1, minHeight: 0, padding: '6px 2px 2px 10px' }} />
      )}
    </div>
  );
}
