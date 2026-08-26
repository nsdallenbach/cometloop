// Local deployment queue (DAT-236): merged tickets assigned to this dev queue
// here and deploy from THIS machine with the dev's identity — the console only
// ever receives events (queued/started/succeeded/failed/removed) and renders a
// read-only mirror from them. Nothing in the web app can reach this process.
//
// Lifecycle per item: the poll discovers a merged, unsettled ticket of the
// signed-in dev → it queues locally (and announces 'queued' home) → one click
// runs the deploy — repo checkout at origin/<default branch>, then the deploy
// command(s) with DATABRICKS_HOST/TOKEN minted from the dev's own session —
// with every output line streamed to the Deploys tab → the outcome event
// settles the ticket on the board (Done-on-green / ⚠ feed warning).
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConsoleClient } from '../../../shared/api-client';
import type { DesktopConfig } from './config';

export type DeployState = 'queued' | 'deploying' | 'succeeded' | 'failed';

export interface DeployItem {
  ticketKey: string;
  title: string;
  engagementId: string;
  prNumber: number | null;
  branch: string;
  repoName: string;
  repoUrl: string;
  defaultBranch: string;
  state: DeployState;
  log: string[];
  error: string;
  queuedAt: string;
  finishedAt: string | null;
}

export type DeploysEvent =
  | { kind: 'items' }
  | { kind: 'log'; ticketKey: string; line: string; ts: string };

export interface DeploysSnapshot {
  items: DeployItem[];
  deploying: string | null;
  polledAt: string | null;
  pollError: string;
}

const LOG_LIMIT = 2000;
const POLL_MS = 30_000;
const MAX_DEPLOY_MS = 30 * 60_000;

const now = (): string => new Date().toISOString();
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class DeployManager {
  private items: DeployItem[] = [];
  private deployingKey: string | null = null;
  private child: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polledAt: string | null = null;
  private pollError = '';

  constructor(
    private readonly cfg: DesktopConfig,
    private readonly client: ConsoleClient,
    /** Workspace token for the deploy env — the dev's identity, auto-refreshed. */
    private readonly getToken: () => Promise<string>,
    private readonly broadcast: (ev: DeploysEvent) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): DeploysSnapshot {
    return { items: this.items, deploying: this.deployingKey, polledAt: this.polledAt, pollError: this.pollError };
  }

  /**
   * Refresh the local queue from the console: merged tickets of the signed-in
   * dev whose deploy has not settled. New arrivals are announced home as
   * 'queued' (the server deduplicates re-announcements); queued items that
   * left the server view (settled elsewhere, ticket closed) drop out locally.
   */
  async poll(): Promise<void> {
    let rows: Record<string, unknown>[];
    try {
      const res = await this.client.request<{ items: Record<string, unknown>[] }>('/api/deploys/queue');
      rows = Array.isArray(res?.items) ? res.items : [];
      this.pollError = '';
    } catch (e) {
      this.pollError = msg(e);
      this.broadcast({ kind: 'items' });
      return;
    }
    this.polledAt = now();
    const seen = new Set<string>();
    for (const r of rows) {
      const key = str(r.ticket_key);
      if (!key) continue;
      seen.add(key);
      if (this.items.some((i) => i.ticketKey === key && (i.state === 'queued' || i.state === 'deploying'))) continue;
      // Re-merged after a finished cycle (or first sight): queue a fresh item.
      this.items = this.items.filter((i) => i.ticketKey !== key);
      this.items.push({
        ticketKey: key,
        title: str(r.title),
        engagementId: str(r.engagement_id),
        prNumber: r.pr_number == null ? null : Number(r.pr_number),
        branch: str(r.branch),
        repoName: str(r.repo_name),
        repoUrl: str(r.repo_url),
        defaultBranch: str(r.default_branch) || 'main',
        state: 'queued',
        log: [],
        error: '',
        queuedAt: now(),
        finishedAt: null,
      });
      void this.postEvent(key, 'queued', r.pr_number == null ? null : Number(r.pr_number));
    }
    // A queued item the server no longer lists was settled without us.
    this.items = this.items.filter((i) => i.state !== 'queued' || seen.has(i.ticketKey) || i.ticketKey === this.deployingKey);
    this.broadcast({ kind: 'items' });
  }

  /** One-click deploy: runs in the background, one at a time per machine. */
  deploy(ticketKey: string): { ok: boolean; error?: string } {
    if (this.deployingKey) return { ok: false, error: `A deploy is already running (${this.deployingKey}).` };
    const item = this.items.find((i) => i.ticketKey === ticketKey);
    if (!item) return { ok: false, error: 'That ticket is not in the local queue.' };
    if (item.state === 'deploying' || item.state === 'succeeded') return { ok: false, error: `Already ${item.state}.` };
    void this.runDeploy(item).catch((e) => this.log(item, `deploy crashed: ${msg(e)}`));
    return { ok: true };
  }

  /** Drop a queued/failed item locally and tell the mirror it left the queue. */
  dismiss(ticketKey: string): { ok: boolean; error?: string } {
    const item = this.items.find((i) => i.ticketKey === ticketKey);
    if (!item) return { ok: false, error: 'That ticket is not in the local queue.' };
    if (item.state === 'deploying') return { ok: false, error: 'A deploy is running for this ticket.' };
    this.items = this.items.filter((i) => i !== item);
    if (item.state === 'queued' || item.state === 'failed') void this.postEvent(ticketKey, 'removed', item.prNumber);
    this.broadcast({ kind: 'items' });
    return { ok: true };
  }

  killRun(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // best effort — the close handler settles the outcome either way
    }
  }

  // ---- one deploy ----

  private async runDeploy(item: DeployItem): Promise<void> {
    this.deployingKey = item.ticketKey;
    item.state = 'deploying';
    item.log = [];
    item.error = '';
    item.finishedAt = null;
    this.broadcast({ kind: 'items' });
    await this.postEvent(item.ticketKey, 'started', item.prNumber);

    const dir = path.join(this.cfg.workRoot, 'deploys', item.engagementId);
    mkdirSync(dir, { recursive: true });
    const watchdog = setTimeout(() => {
      this.log(item, `⚠ deploy exceeded ${MAX_DEPLOY_MS / 60_000} minutes — killing`);
      this.killRun();
    }, MAX_DEPLOY_MS);

    try {
      // Checkout with the dev's own git credentials — local identity, like
      // everything else on this tab.
      const git: string[][] = existsSync(path.join(dir, '.git'))
        ? [
            ['fetch', 'origin'],
            ['checkout', item.defaultBranch],
            ['reset', '--hard', `origin/${item.defaultBranch}`],
          ]
        : [['clone', item.repoUrl, '.']];
      for (const args of git) {
        this.log(item, `> git ${args.join(' ')}`);
        const code = await this.stream('git', args, dir, {}, item);
        if (code !== 0) throw new Error(`git ${args[0]} exited with code ${String(code)}`);
      }

      const commands = this.deployCommands(dir);
      if (!commands) {
        throw new Error('No deploy command detected — set "deployCommand" in config.json for this machine.');
      }
      // The deploy runs as the dev: their workspace token, their machine.
      const env = { DATABRICKS_HOST: this.cfg.databricksHost, DATABRICKS_TOKEN: await this.getToken() };
      for (const cmd of commands) {
        this.log(item, `> ${cmd}`);
        const code = await this.stream(cmd, null, dir, env, item);
        if (code !== 0) throw new Error(`"${cmd}" exited with code ${String(code)}`);
      }

      item.state = 'succeeded';
      item.finishedAt = now();
      this.log(item, `✓ deploy succeeded for ${item.ticketKey}`);
      await this.postEvent(item.ticketKey, 'succeeded', item.prNumber);
    } catch (e) {
      item.state = 'failed';
      item.error = msg(e);
      item.finishedAt = now();
      this.log(item, `✕ ${item.error}`);
      await this.postEvent(item.ticketKey, 'failed', item.prNumber, [item.error, ...item.log.slice(-20)].join('\n').slice(0, 3900));
    } finally {
      clearTimeout(watchdog);
      this.child = null;
      this.deployingKey = null;
      this.broadcast({ kind: 'items' });
    }
  }

  /**
   * Resolve what "deploy" means here: an explicit per-machine override, else
   * a Databricks bundle (deploy + start the app on the new source, exactly
   * what CI does), else the repo's own deploy script.
   */
  private deployCommands(dir: string): string[] | null {
    if (this.cfg.deployCommand) return [this.cfg.deployCommand];
    if (existsSync(path.join(dir, 'databricks.yml')) || existsSync(path.join(dir, 'databricks.yaml'))) {
      return ['databricks bundle deploy', 'databricks bundle run app'];
    }
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.deploy) return ['npm run deploy'];
    } catch {
      // no package.json — fall through
    }
    return null;
  }

  /** Spawn one step (args → execFile-style, null args → shell command) and stream its output. */
  private stream(
    cmd: string,
    args: string[] | null,
    cwd: string,
    extraEnv: Record<string, string>,
    item: DeployItem,
  ): Promise<number> {
    return new Promise((resolve) => {
      const child = args
        ? spawn(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        : spawn(cmd, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true });
      this.child = child;
      const onChunk = (buf: { rest: string }) => (chunk: string) => {
        buf.rest += chunk;
        const lines = buf.rest.split(/\r?\n/);
        buf.rest = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) this.log(item, l);
      };
      const out = { rest: '' };
      const err = { rest: '' };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', onChunk(out));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', onChunk(err));
      child.on('close', (code) => {
        for (const b of [out, err]) if (b.rest.trim()) this.log(item, b.rest);
        resolve(code ?? 1);
      });
      child.on('error', (e) => {
        this.log(item, `spawn failed: ${e.message}`);
        resolve(1);
      });
    });
  }

  private log(item: DeployItem, line: string): void {
    item.log.push(line);
    if (item.log.length > LOG_LIMIT) item.log.splice(0, item.log.length - LOG_LIMIT);
    this.broadcast({ kind: 'log', ticketKey: item.ticketKey, line, ts: now() });
  }

  /** Report one ticket-keyed event home; the mirror renders only from these. */
  private async postEvent(
    ticket: string,
    event: 'queued' | 'started' | 'succeeded' | 'failed' | 'removed',
    prNumber: number | null,
    detail?: string,
  ): Promise<void> {
    try {
      await this.client.request('/api/agent/deploys/events', {
        method: 'POST',
        body: JSON.stringify({ agent: this.cfg.agentName, ticket, event, ...(prNumber === null ? {} : { prNumber }), ...(detail ? { detail } : {}) }),
      });
    } catch (e) {
      const item = this.items.find((i) => i.ticketKey === ticket);
      if (item) this.log(item, `event '${event}' failed to reach the console: ${msg(e)}`);
    }
  }
}
