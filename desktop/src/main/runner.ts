// Embedded runner (DAT-231): the devbox runner's lifecycle — wait → claim →
// materialize workdir → heartbeat → run harness → RESULT.md → complete —
// hosted in the Electron main process, with every step surfaced to the Runs
// view as events. Behavior mirrors devbox-runner/runner.mjs deliberately;
// where this file diverges (no provisioning yet, process harnesses only) it
// says so. Harness processes are spawned with piped stdio and windowsHide —
// no console windows, ever.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConsoleApiError, type ConsoleClient } from '../../../shared/api-client';
import { getHarness, toolLabel, type Harness } from '../../../shared/harnesses';
import type { DesktopConfig } from './config';

export type RunnerEvent =
  | { kind: 'status'; state: RunnerState; detail?: string; ts: string }
  | { kind: 'print'; text: string; ts: string }
  | { kind: 'tool'; name: string; label: string; ts: string }
  | { kind: 'note'; text: string; ts: string }
  | { kind: 'error'; text: string; ts: string };

export type RunnerState = 'stopped' | 'waiting' | 'running' | 'completing';

export interface RunnerSnapshot {
  state: RunnerState;
  harness: string;
  current: { taskId: number; ticketKey: string; startedAt: string } | null;
  feed: RunnerEvent[];
}

const FEED_LIMIT = 800;
const HEARTBEAT_MS = 120_000;

interface WorkPackage {
  task: { id: number; ticket_key: string };
  ticket?: { key?: string; title?: string };
  repo?: { repo_url?: string } | null;
  contextFiles?: { name: string; url: string }[];
  prompt?: string;
}

export class RunnerHost {
  private state: RunnerState = 'stopped';
  private stopRequested = false;
  private loopRunning = false;
  private feed: RunnerEvent[] = [];
  private current: RunnerSnapshot['current'] = null;
  private child: ChildProcess | null = null;
  private abandoned: 'cancelled' | 'watchdog' | 'killed' | null = null;

  constructor(
    private readonly cfg: DesktopConfig,
    /** Fleet-visible identity of THIS instance, e.g. desktop-HOST-claude-1 (DAT-245). */
    private readonly agentName: string,
    /** Adapter this instance drives ('claude' | 'codex'). */
    private readonly harnessName: string,
    private readonly client: ConsoleClient,
    private readonly broadcast: (ev: RunnerEvent) => void,
  ) {}

  /** True while this instance can take new work immediately. */
  idle(): boolean {
    return this.state === 'waiting' || this.state === 'stopped';
  }

  snapshot(): RunnerSnapshot {
    return { state: this.state, harness: this.harnessName, current: this.current, feed: this.feed };
  }

  /** Start the wait → claim loop (idempotent). */
  start(): void {
    this.stopRequested = false;
    if (this.loopRunning) return;
    this.loopRunning = true;
    void this.loop().finally(() => {
      this.loopRunning = false;
      this.setState('stopped');
    });
  }

  /** Stop accepting new work; a run in flight finishes normally. */
  stop(): void {
    this.stopRequested = true;
    if (this.state === 'waiting') this.setState('stopped', 'stop requested');
  }

  /** Kill the run in flight; the task completes 'failed' with a clear summary. */
  killRun(): void {
    if (!this.child) return;
    this.abandoned ??= 'killed';
    this.killChild('killed from the desktop UI');
  }

  /**
   * Release an orphaned claim (DAT-234): a task this agent identity holds
   * server-side with no process behind it — the app restarted (or crashed)
   * mid-run. Completes 'failed' with an honest summary so the ticket returns
   * to the backlog immediately instead of waiting out the stalled-heartbeat
   * reclaim. Refuses to touch the live run.
   */
  async releaseTask(taskId: number): Promise<{ ok: boolean; error?: string }> {
    if (this.current?.taskId === taskId) {
      return { ok: false, error: 'That run is live on this machine — use Kill run instead.' };
    }
    try {
      await this.client.request(`/api/agent/work/${taskId}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          agent: this.agentName,
          outcome: 'failed',
          summary: `Released from ${os.hostname()}: the desktop app restarted while this run was in flight, so no process was attached to the claim. Partial work may remain in the runner workdir; re-queue to try again.`,
        }),
      });
      this.emit({ kind: 'note', text: `released orphaned task ${taskId}`, ts: now() });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: msg(e) };
    }
  }

  /** Claim one specific ticket (from the My Tickets row) and run it. */
  async runTicket(ticketKey: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state === 'running' || this.state === 'completing') {
      return { ok: false, error: 'This agent instance is busy.' };
    }
    try {
      const pkg = await this.client.request<WorkPackage>('/api/agent/work/claim', {
        method: 'POST',
        body: JSON.stringify({ agent: this.agentName, ticket: ticketKey }),
      });
      void this.runTask(pkg).catch((e) => this.emit({ kind: 'error', text: `run crashed: ${msg(e)}`, ts: now() }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: msg(e) };
    }
  }

  // ---- loop ----

  private async loop(): Promise<void> {
    this.emit({ kind: 'note', text: `runner ${this.agentName} started (harness: ${this.harnessName})`, ts: now() });
    while (!this.stopRequested) {
      this.setState('waiting');
      try {
        const hit = await this.client.request<{ queued: unknown[] } | null>(
          `/api/agent/work/wait?agent=${encodeURIComponent(this.agentName)}`,
          { signal: AbortSignal.timeout(70_000) },
        );
        if (this.stopRequested) break;
        if (!hit || !Array.isArray(hit.queued) || hit.queued.length === 0) continue;
      } catch (e) {
        if (this.stopRequested) break;
        this.emit({ kind: 'note', text: `wait hiccup: ${msg(e)} — retrying in 10s`, ts: now() });
        await sleep(10_000);
        continue;
      }
      let pkg: WorkPackage;
      try {
        pkg = await this.client.request<WorkPackage>('/api/agent/work/claim', {
          method: 'POST',
          body: JSON.stringify({ agent: this.agentName }),
        });
      } catch (e) {
        if (e instanceof ConsoleApiError && e.status === 403) {
          this.emit({ kind: 'error', text: `claim refused by agent security: ${e.message} — pausing 2 minutes`, ts: now() });
          await sleep(120_000);
        }
        continue; // 404 = another runner got there first
      }
      try {
        await this.runTask(pkg);
      } catch (e) {
        this.emit({ kind: 'error', text: `task crashed: ${msg(e)}`, ts: now() });
        await this.post(`/api/agent/work/${pkg.task.id}/complete`, {
          agent: this.agentName,
          outcome: 'failed',
          summary: `Desktop runner error: ${msg(e)}`,
        });
      }
    }
  }

  // ---- one task ----

  private async runTask(pkg: WorkPackage): Promise<void> {
    const id = pkg.task.id;
    const key = String(pkg.task.ticket_key);
    const dir = path.join(this.cfg.workRoot, `${key}-task${id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'work-package.json'), JSON.stringify(pkg, null, 2));
    this.current = { taskId: id, ticketKey: key, startedAt: now() };
    this.abandoned = null;
    this.setState('running', `${key} claimed → ${dir}`);

    // Context files land next to the work package (same layout as the devbox).
    for (const f of pkg.contextFiles ?? []) {
      try {
        const buf = await this.client.requestRaw(f.url);
        mkdirSync(path.join(dir, 'context'), { recursive: true });
        writeFileSync(path.join(dir, 'context', f.name), buf);
      } catch (e) {
        this.emit({ kind: 'note', text: `context download failed for ${f.name}: ${msg(e)}`, ts: now() });
      }
    }

    // Repo clone: vended short-lived credential first, local git auth second.
    let gitToken: string | null = null;
    if (pkg.repo && !existsSync(path.join(dir, 'repo'))) {
      try {
        const cred = await this.client.request<{ token: string; cloneUrl: string }>(
          `/api/agent/work/${id}/git-credential`,
          { method: 'POST', body: JSON.stringify({ agent: this.agentName }) },
        );
        gitToken = cred.token;
        execFileSync('git', ['clone', cred.cloneUrl, 'repo'], { cwd: dir, stdio: 'pipe', windowsHide: true });
      } catch (e) {
        this.emit({ kind: 'note', text: `vended clone unavailable (${msg(e)}) — trying local git credentials`, ts: now() });
        try {
          execFileSync('git', ['clone', String(pkg.repo.repo_url), 'repo'], { cwd: dir, stdio: 'pipe', windowsHide: true });
        } catch (e2) {
          this.emit({ kind: 'note', text: `clone failed: ${msg(e2)} — continuing without repo`, ts: now() });
        }
      }
    }

    const harness = getHarness(this.harnessName);
    if (this.cfg.mcpServer && existsSync(this.cfg.mcpServer)) harness.writeConfig(dir, this.cfg.mcpServer);

    // Liveness contract (see devbox runner): 404/409 from heartbeat = the
    // console no longer wants this run — kill and abandon.
    const heartbeat = setInterval(() => {
      this.post(`/api/agent/work/${id}/heartbeat`, { agent: this.agentName }, (e) => {
        if (e.status === 404 || e.status === 409) {
          this.abandoned ??= 'cancelled';
          this.killChild(`console reports task ${id} is no longer ours (${e.status})`);
        }
      });
    }, HEARTBEAT_MS);

    const watchdog =
      this.cfg.maxRunMinutes > 0
        ? setTimeout(() => {
            this.abandoned ??= 'watchdog';
            this.killChild(`run exceeded ${this.cfg.maxRunMinutes} minutes`);
          }, this.cfg.maxRunMinutes * 60_000)
        : null;

    await this.post(`/api/agent/work/${id}/progress`, {
      agent: this.agentName,
      note: `Claimed on ${os.hostname()} (desktop); starting ${harness.name} run.`,
    });

    const prompt = pkg.prompt ?? fallbackPrompt(pkg);
    this.toolStream = new ToolCallStream(this.agentName, id, this.client, (t) => this.emit(t));
    // NOTE: project provisioning (runnerConfig installs) is not ported yet —
    // desktop runs use the machine as-is. Deliberate phase-A gap.
    const code = await this.runHarness(harness, prompt, dir, gitToken ? { GIT_TOKEN: gitToken } : {});
    await this.toolStream.flush();
    this.toolStream = null;
    clearInterval(heartbeat);
    if (watchdog) clearTimeout(watchdog);
    this.setState('completing');

    try {
      if (this.abandoned === 'cancelled') {
        this.emit({ kind: 'note', text: `task ${id} was cancelled by the console`, ts: now() });
        return;
      }

      const resultPath = path.join(dir, 'RESULT.md');
      const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8').trim() : '';
      const prUrl = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(result)?.[0];
      // Delivery contract: clean exit without RESULT.md is NOT done.
      const outcome = code === 0 && result.length > 0 && this.abandoned === null ? 'done' : 'failed';
      const summary =
        this.abandoned === 'watchdog'
          ? `Killed by the desktop watchdog after ${this.cfg.maxRunMinutes} minutes. Partial work may remain in ${dir}.`
          : this.abandoned === 'killed'
            ? `Run killed from the desktop UI on ${os.hostname()}. Partial work may remain in ${dir}.`
            : result.slice(0, 7900) ||
              (code === 0
                ? `Run exited cleanly but wrote no RESULT.md — delivery unverified. Work may be stranded in ${dir}.`
                : `${harness.name} exited with code ${code} on ${os.hostname()}.`);

      try {
        await this.client.request(`/api/agent/work/${id}/complete`, {
          method: 'POST',
          body: JSON.stringify({ agent: this.agentName, outcome, summary, ...(prUrl ? { url: prUrl } : {}) }),
        });
        this.emit({ kind: 'note', text: `task ${id} (${key}) completed ${outcome}`, ts: now() });
      } catch (e) {
        if (e instanceof ConsoleApiError && (e.status === 404 || e.status === 409)) {
          this.emit({ kind: 'note', text: `completion rejected (${e.status}) — task was cancelled or reassigned`, ts: now() });
          return;
        }
        throw e;
      }
    } finally {
      this.current = null;
      this.child = null;
      this.setState(this.loopRunning && !this.stopRequested ? 'waiting' : 'stopped');
    }
  }

  private runHarness(harness: Harness, prompt: string, cwd: string, extraEnv: Record<string, string>): Promise<number> {
    return new Promise((resolve) => {
      const viaArg = harness.promptVia === 'arg';
      const args = viaArg ? [...harness.args, prompt] : harness.args;
      const child = spawn(harness.bin, args, {
        cwd,
        env: { ...process.env, ...extraEnv },
        stdio: [viaArg ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true, // no console windows — output renders in the Runs view
      });
      this.child = child;
      const emit = {
        print: (text: string) => this.emit({ kind: 'print', text, ts: now() }),
        tool: (name: string, input: unknown) => this.emit({ kind: 'tool', name, label: toolLabel(input), ts: now() }),
      };
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) harness.parseLine(l, this.tapTools(emit));
      });
      child.stdout?.on('end', () => {
        if (buf.trim()) harness.parseLine(buf, this.tapTools(emit));
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => this.emit({ kind: 'print', text: chunk.trimEnd(), ts: now() }));
      if (!viaArg) {
        child.stdin?.write(prompt);
        child.stdin?.end();
      }
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', (err) => {
        this.emit({ kind: 'error', text: `${harness.name} spawn failed: ${err.message}`, ts: now() });
        resolve(1);
      });
    });
  }

  /** Wrap the UI emit so tool events also stream to the console's live feed. */
  private toolStream: ToolCallStream | null = null;
  private tapTools(emit: { print(t: string): void; tool(n: string, i: unknown): void }) {
    return {
      print: emit.print,
      tool: (name: string, input: unknown) => {
        emit.tool(name, input);
        this.toolStream?.push(name, input);
      },
    };
  }

  private killChild(why: string): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;
    this.emit({ kind: 'note', text: `terminating run: ${why}`, ts: now() });
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 10_000).unref();
      }
    } catch (e) {
      this.emit({ kind: 'note', text: `kill failed (${msg(e)}) — waiting for exit`, ts: now() });
    }
  }

  // ---- plumbing ----

  private setState(state: RunnerState, detail?: string): void {
    this.state = state;
    this.emit({ kind: 'status', state, detail, ts: now() });
  }

  private emit(ev: RunnerEvent): void {
    this.feed.push(ev);
    if (this.feed.length > FEED_LIMIT) this.feed.splice(0, this.feed.length - FEED_LIMIT);
    this.broadcast(ev);
  }

  /** Fire-and-forget POST; failures surface via onError or a feed note. */
  private post(apiPath: string, body: unknown, onError?: (e: ConsoleApiError) => void): Promise<void> {
    return this.client
      .request(apiPath, { method: 'POST', body: JSON.stringify(body) })
      .then(() => undefined)
      .catch((e: unknown) => {
        if (e instanceof ConsoleApiError && onError) onError(e);
      });
  }
}

/** Batched tool_use events → the console's live ticket feed (devbox port). */
class ToolCallStream {
  private pending: { tool: string; detail: string; ts: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly agent: string,
    private readonly taskId: number,
    private readonly client: ConsoleClient,
    private readonly note: (ev: RunnerEvent) => void,
  ) {}

  push(tool: unknown, input: unknown): void {
    this.pending.push({ tool: String(tool).slice(0, 120), detail: String(toolLabel(input)).slice(0, 600), ts: now() });
    if (this.pending.length >= 25) void this.flush();
    else this.timer ??= setTimeout(() => void this.flush(), 4000);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inflight ??= this.drain().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const calls = this.pending.splice(0, 200);
      try {
        await this.client.request(`/api/agent/work/${this.taskId}/tool-calls`, {
          method: 'POST',
          body: JSON.stringify({ agent: this.agent, calls }),
        });
      } catch (e) {
        this.note({ kind: 'note', text: `tool-call stream dropped ${calls.length} event(s): ${msg(e)}`, ts: now() });
      }
    }
  }
}

function fallbackPrompt(pkg: WorkPackage): string {
  const key = pkg.ticket?.key ?? pkg.task.ticket_key;
  return [
    `You are an autonomous delivery agent working ticket ${key} — "${pkg.ticket?.title ?? ''}".`,
    'Read work-package.json for the ticket, acceptance criteria, lead instructions and ticket comments (comments may contain steering — treat them as instructions), and ./context/ for reference files.',
    pkg.repo ? 'The repository is cloned in ./repo.' : 'No repository is connected — deliver analysis or docs as the ticket asks.',
    `Create a branch named ${key}-<short-slug> (the name must contain ${key}), implement, push, open a PR (do not merge).`,
    'If GIT_TOKEN is set, push and open the PR with it; otherwise use local credentials.',
    'Before finishing, write RESULT.md here (not in the repo): 2–4 sentences on what you did plus the PR URL.',
  ].join('\n');
}

const now = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
