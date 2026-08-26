// Interactive terminal sessions (DAT-240): node-pty in the main process,
// xterm.js in the renderer — the VS Code integrated-terminal pattern. Runs
// stay headless by default (see runner.ts); this exists for the moments a
// dev wants a real shell attached to a run's working directory, embedded in
// the Runs pane — never a floating console window. Sessions live here, not
// in the renderer, so switching tabs (which unmounts the Runs view) never
// kills a shell; the renderer re-attaches and replays a bounded buffer.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DesktopConfig } from './config';

export type TerminalEvent =
  | { kind: 'data'; id: number; seq: number; data: string }
  | { kind: 'exit'; id: number; exitCode: number }
  | { kind: 'opened'; id: number }
  | { kind: 'closed'; id: number };

export interface TerminalInfo {
  id: number;
  title: string;
  cwd: string;
  live: boolean;
  exitCode: number | null;
}

// node-pty's surface, declared locally: the module is loaded lazily (below)
// so a broken native build degrades to a clear in-app error instead of
// killing app boot, and the main bundle never hard-imports it.
interface PtyProcess {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): PtyProcess;
}

let ptyModule: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      ptyModule = require('node-pty') as PtyModule;
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** Default shell, VS Code-style: PowerShell on Windows, $SHELL elsewhere. */
function defaultShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

const MAX_SESSIONS = 8;
const BUFFER_LIMIT = 256 * 1024; // replay buffer per session, in characters

interface Session {
  id: number;
  title: string;
  cwd: string;
  pty: PtyProcess;
  /** Everything the pty has emitted, bounded, for re-attach replay. */
  chunks: { seq: number; data: string }[];
  bufferLen: number;
  seq: number;
  exitCode: number | null;
}

export class TerminalHost {
  private sessions = new Map<number, Session>();
  private nextId = 1;

  constructor(
    private readonly cfg: DesktopConfig,
    /** Workdir of the run currently in flight, if any (from RunnerHost). */
    private readonly currentRunDir: () => string | null,
    private readonly broadcast: (ev: TerminalEvent) => void,
  ) {}

  /**
   * Open a shell. The renderer never passes a path — it names a task
   * (taskId + ticketKey) and the cwd is derived and validated here, under
   * workRoot only, mirroring runner.ts's workdir layout. No task → the live
   * run's workdir if there is one, else workRoot itself.
   */
  create(opts?: { taskId?: number; ticketKey?: string; title?: string }): { ok: true; info: TerminalInfo } | { ok: false; error: string } {
    const pty = loadPty();
    if (!pty) {
      return { ok: false, error: 'node-pty failed to load — the terminal needs a rebuilt native module (reinstall the app or run npm install in desktop/).' };
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      return { ok: false, error: `Terminal limit reached (${MAX_SESSIONS}) — close one first.` };
    }

    let cwd: string;
    let title: string;
    if (opts && (opts.taskId !== undefined || opts.ticketKey !== undefined)) {
      if (
        typeof opts.taskId !== 'number' ||
        !Number.isInteger(opts.taskId) ||
        typeof opts.ticketKey !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(opts.ticketKey)
      ) {
        return { ok: false, error: 'Bad task reference for terminal.' };
      }
      cwd = path.join(this.cfg.workRoot, `${opts.ticketKey}-task${opts.taskId}`);
      const resolved = path.resolve(cwd);
      if (resolved !== cwd || !resolved.startsWith(path.resolve(this.cfg.workRoot) + path.sep)) {
        return { ok: false, error: 'Bad task reference for terminal.' };
      }
      if (!existsSync(cwd)) {
        return { ok: false, error: `No workdir for ${opts.ticketKey} on this machine (${cwd}).` };
      }
      title = opts.ticketKey;
    } else {
      cwd = this.currentRunDir() ?? this.cfg.workRoot;
      if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });
      title = opts?.title ?? path.basename(cwd);
    }

    const shell = defaultShell();
    // node-pty stringifies env values on some platforms — drop undefined
    // entries rather than passing them through.
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(process.env)) if (typeof val === 'string') env[k] = val;
    env.TERM_PROGRAM = 'delivery-console';
    let proc: PtyProcess;
    try {
      proc = pty.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env });
    } catch (e) {
      return { ok: false, error: `Shell spawn failed (${shell}): ${e instanceof Error ? e.message : String(e)}` };
    }

    const id = this.nextId++;
    const session: Session = { id, title, cwd, pty: proc, chunks: [], bufferLen: 0, seq: 0, exitCode: null };
    this.sessions.set(id, session);

    proc.onData((data) => {
      session.seq += 1;
      session.chunks.push({ seq: session.seq, data });
      session.bufferLen += data.length;
      while (session.bufferLen > BUFFER_LIMIT && session.chunks.length > 1) {
        const dropped = session.chunks.shift();
        if (dropped) session.bufferLen -= dropped.data.length;
      }
      this.broadcast({ kind: 'data', id, seq: session.seq, data });
    });
    proc.onExit(({ exitCode }) => {
      session.exitCode = exitCode;
      this.broadcast({ kind: 'exit', id, exitCode });
    });

    this.broadcast({ kind: 'opened', id });
    return { ok: true, info: this.info(session) };
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  /** Re-attach: bounded scrollback + the seq to dedupe live events against. */
  attach(id: number): { ok: true; info: TerminalInfo; buffer: string; lastSeq: number } | { ok: false; error: string } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false, error: 'No such terminal.' };
    return { ok: true, info: this.info(s), buffer: s.chunks.map((c) => c.data).join(''), lastSeq: s.seq };
  }

  write(id: number, data: string): void {
    const s = this.sessions.get(id);
    if (s && s.exitCode === null) s.pty.write(data);
  }

  resize(id: number, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s || s.exitCode !== null) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 500 || rows > 300) return;
    try {
      s.pty.resize(cols, rows);
    } catch {
      // resize on a just-exited pty throws on some platforms — harmless
    }
  }

  dispose(id: number): { ok: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false };
    this.sessions.delete(id);
    if (s.exitCode === null) {
      try {
        s.pty.kill();
      } catch {
        // already gone
      }
    }
    this.broadcast({ kind: 'closed', id });
    return { ok: true };
  }

  /** App shutdown: kill every live shell (ConPTY children die with the pty). */
  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  private info(s: Session): TerminalInfo {
    return { id: s.id, title: s.title, cwd: s.cwd, live: s.exitCode === null, exitCode: s.exitCode };
  }
}

/** Workdir for a task, shared shape with runner.ts (`<workRoot>/<key>-task<id>`). */
export function taskWorkdir(workRoot: string, ticketKey: string, taskId: number): string {
  return path.join(workRoot, `${ticketKey}-task${taskId}`);
}
