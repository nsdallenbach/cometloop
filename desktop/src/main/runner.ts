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
import { getHarness, missingAuthEnv, toolLabel, type AgentRunConfig, type Harness } from '../../../shared/harnesses';
import type { DesktopConfig } from './config';
import type { IdentityBroker } from './identity';

export type RunnerEvent =
  | { kind: 'status'; state: RunnerState; detail?: string; ts: string }
  | { kind: 'print'; text: string; ts: string }
  | { kind: 'tool'; name: string; label: string; ts: string }
  | { kind: 'note'; text: string; ts: string }
  | { kind: 'error'; text: string; ts: string }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheCreate: number; costUsd?: number; final?: boolean; ticketKey: string; ts: string };

/** Running token totals for an instance (DAT-266); reset per run start. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  costUsd: number | null;
}

const emptyUsage = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: null });

export type RunnerState = 'stopped' | 'waiting' | 'running' | 'completing';

export interface RunnerSnapshot {
  state: RunnerState;
  harness: string;
  current: { taskId: number; ticketKey: string; startedAt: string } | null;
  feed: RunnerEvent[];
  /** Tokens for the run in flight (zeroed at claim). */
  runUsage: UsageTotals;
  /** Tokens since this instance started (across runs). */
  sessionUsage: UsageTotals;
}

const FEED_LIMIT = 800;
const HEARTBEAT_MS = 120_000;

/** What a delivery needs and nothing more — branch/push/PR, install, validate,
 *  console API. One list feeds both the CLI grant and the workdir settings. */
const DELIVERY_ALLOW_RULES = [
  'Bash(git:*)',
  'Bash(gh:*)',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(databricks:*)',
  'Bash(curl:*)',
];

interface WorkPackage {
  task: { id: number; ticket_key: string; engagement_id?: string };
  ticket?: { key?: string; title?: string };
  repo?: { repo_url?: string } | null;
  contextFiles?: { name: string; url: string }[];
  prompt?: string;
  /** The model and registry attachments the console resolved for this agent (DAT-279). */
  agentConfig?: AgentRunConfig | null;
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
    /** Dev identities (DAT-235): client-owned repos clone/push as the dev. */
    private readonly identity: IdentityBroker | null = null,
  ) {}

  /** True while this instance can take new work immediately. */
  idle(): boolean {
    return this.state === 'waiting' || this.state === 'stopped';
  }

  private runUsage: UsageTotals = emptyUsage();
  private sessionUsage: UsageTotals = emptyUsage();
  private usageStream: UsageStream | null = null;

  snapshot(): RunnerSnapshot {
    return {
      state: this.state,
      harness: this.harnessName,
      current: this.current,
      feed: this.feed,
      runUsage: { ...this.runUsage },
      sessionUsage: { ...this.sessionUsage },
    };
  }

  /** Fold one harness usage sample into run/session totals (DAT-266). A final
   *  sample REPLACES the run totals — the harness counted the whole run — and
   *  the session total absorbs only the difference. */
  private recordUsage(s: { input: number; output: number; cacheRead: number; cacheCreate: number; costUsd?: number; final?: boolean }): void {
    const prev = { ...this.runUsage };
    if (s.final) {
      this.runUsage = { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheCreate: s.cacheCreate, costUsd: s.costUsd ?? this.runUsage.costUsd };
    } else {
      this.runUsage.input += s.input;
      this.runUsage.output += s.output;
      this.runUsage.cacheRead += s.cacheRead;
      this.runUsage.cacheCreate += s.cacheCreate;
    }
    this.sessionUsage.input += this.runUsage.input - prev.input;
    this.sessionUsage.output += this.runUsage.output - prev.output;
    this.sessionUsage.cacheRead += this.runUsage.cacheRead - prev.cacheRead;
    this.sessionUsage.cacheCreate += this.runUsage.cacheCreate - prev.cacheCreate;
    if (this.runUsage.costUsd != null) {
      this.sessionUsage.costUsd = (this.sessionUsage.costUsd ?? 0) + (this.runUsage.costUsd - (prev.costUsd ?? 0));
    }
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

  /** This instance's local configuration (DAT-280): scope, model, attachments — managed on the Agents page. */
  private localConfig() {
    const kinds = this.cfg.agents as Record<string, { projects: string[]; model: string | null; mcpServers: string[]; skills: string[] } | undefined>;
    return kinds[this.harnessName] ?? { projects: [], model: null, mcpServers: [], skills: [] };
  }

  private async loop(): Promise<void> {
    const scope = this.localConfig().projects;
    this.emit({
      kind: 'note',
      text: `runner ${this.agentName} started (harness: ${this.harnessName}${scope.length ? `, projects: ${scope.join(', ')}` : ', any project'})`,
      ts: now(),
    });
    while (!this.stopRequested) {
      this.setState('waiting');
      try {
        const scoped = this.localConfig().projects;
        const params = new URLSearchParams({ agent: this.agentName });
        if (scoped.length) params.set('engagements', scoped.join(','));
        const hit = await this.client.request<{ queued: unknown[] } | null>(`/api/agent/work/wait?${params.toString()}`, {
          signal: AbortSignal.timeout(70_000),
        });
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
        const scoped = this.localConfig().projects;
        pkg = await this.client.request<WorkPackage>('/api/agent/work/claim', {
          method: 'POST',
          body: JSON.stringify({ agent: this.agentName, ...(scoped.length ? { engagements: scoped } : {}) }),
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

    // Repo credentials (DAT-235): work repos keep using the console-vended
    // GitHub App token; client-owned repos (ADO, or GitHub the App can't vend
    // for) run as the dev via the identity broker; local git auth is the last
    // resort either way. `gitEnv` carries the dev credential to every git
    // invocation of the run through env-only git config — never a file.
    let gitToken: string | null = null;
    let gitEnv: Record<string, string> = {};
    if (pkg.repo) {
      const repoUrl = String(pkg.repo.repo_url ?? '');
      const adoHost = adoHostOf(repoUrl);
      const needsClone = !existsSync(path.join(dir, 'repo'));
      if (adoHost) {
        // Client-owned ADO repo — the console never vends for these, the
        // whole point (DAT-235) is that this work happens as the dev.
        const token = await this.devToken('ado');
        if (token) {
          gitEnv = bearerGitEnv(adoHost, token);
          this.emit({ kind: 'note', text: `client-owned repo on ${adoHost} — git runs as you (Azure DevOps identity)`, ts: now() });
        } else {
          this.emit({ kind: 'note', text: 'not signed in to Azure DevOps (Identity tab) — trying local git credentials', ts: now() });
        }
        if (needsClone) this.clone(repoUrl, dir, gitEnv);
      } else if (needsClone) {
        try {
          const cred = await this.client.request<{ token: string; cloneUrl: string }>(
            `/api/agent/work/${id}/git-credential`,
            { method: 'POST', body: JSON.stringify({ agent: this.agentName }) },
          );
          gitToken = cred.token;
          execFileSync('git', ['clone', cred.cloneUrl, 'repo'], { cwd: dir, stdio: 'pipe', windowsHide: true });
        } catch (e) {
          const token = await this.devToken('github');
          if (token) {
            // Client-owned GitHub repo (vending refused/failed): as the dev.
            gitToken = token;
            gitEnv = basicGitEnv('github.com', 'x-access-token', token);
            this.emit({ kind: 'note', text: `vended credential unavailable (${msg(e)}) — git runs as you (GitHub identity)`, ts: now() });
          } else {
            this.emit({ kind: 'note', text: `vended clone unavailable (${msg(e)}) — trying local git credentials`, ts: now() });
          }
          this.clone(repoUrl, dir, gitEnv);
        }
      }
    }

    const harness = getHarness(this.harnessName);
    // The console's MCP server plus whatever the lead attached to this agent
    // on the Agents page (DAT-279): registry MCP servers and skills land in
    // the workdir; a server's credential comes from the identity broker's
    // MCP_AUTH_<SLUG> env at spawn time, never from a file.
    const mcpServerPath = this.cfg.mcpServer && existsSync(this.cfg.mcpServer) ? this.cfg.mcpServer : null;
    // Local configuration wins (DAT-280): what the developer set on the Agents
    // page, resolved against the project's registry now. The console's
    // agentConfig (its mirror of the same report) is the fallback.
    const agentConfig = await this.resolveLocalConfig(pkg);
    harness.writeConfig(dir, mcpServerPath, agentConfig);
    const mcpEnv = this.identity?.mcpEnv() ?? {};
    const missingAuth = missingAuthEnv(agentConfig, { ...process.env, ...mcpEnv });
    for (const m of missingAuth) {
      this.emit({
        kind: 'note',
        text: `MCP server ${m.slug} needs ${m.authEnv} — add it under Identity → MCP server auth, or the server will fail to authenticate`,
        ts: now(),
      });
    }
    this.writeDeliveryPermissions(harness.name, dir);

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

    const configNote = [
      agentConfig?.model ? `model ${agentConfig.model}` : null,
      agentConfig?.mcpServers.length ? `${agentConfig.mcpServers.length} MCP server${agentConfig.mcpServers.length === 1 ? '' : 's'}` : null,
      agentConfig?.skills.length ? `${agentConfig.skills.length} skill${agentConfig.skills.length === 1 ? '' : 's'}` : null,
    ].filter((s): s is string => Boolean(s));
    await this.post(`/api/agent/work/${id}/progress`, {
      agent: this.agentName,
      note: [
        `Claimed on ${os.hostname()} (desktop); starting ${harness.name} run${configNote.length ? ` (${configNote.join(', ')})` : ''}.`,
        ...missingAuth.map((m) => `⚠ ${m.slug} needs ${m.authEnv}, not set on this machine.`),
      ].join(' '),
    });

    const prompt = pkg.prompt ?? fallbackPrompt(pkg);
    this.toolStream = new ToolCallStream(this.agentName, id, this.client, (t) => this.emit(t));
    this.runUsage = emptyUsage();
    this.usageStream = new UsageStream(this.agentName, id, this.client, (t) => this.emit(t));
    // NOTE: project provisioning (runnerConfig installs) is not ported yet —
    // desktop runs use the machine as-is. Deliberate phase-A gap.
    // Env carries: the vended token (work repos), the dev's git credential via
    // env-only git config (client repos), and per-MCP-server secrets — DAT-235.
    const code = await this.runHarness(
      harness,
      prompt,
      dir,
      {
        ...(gitToken ? { GIT_TOKEN: gitToken } : {}),
        ...gitEnv,
        ...mcpEnv,
      },
      agentConfig?.model ?? null,
    );
    await this.toolStream.flush();
    this.toolStream = null;
    await this.usageStream?.flush();
    this.usageStream = null;
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

  /**
   * Delivery-scoped sandbox allowlist (DAT-248). The claude harness runs with
   * --permission-mode acceptEdits, which permits file edits but denies the
   * git/npm/network commands the work package REQUIRES (push the branch, open
   * the PR, post progress) — DAT-107 task 164 and DAT-240 task 166 both
   * finished implementation and stranded the delivery on exactly this.
   * Writing a per-workdir .claude/settings.json allows the delivery loop and
   * nothing else — no blanket permission bypass, and the file lives only in
   * the disposable task workdir.
   */
  private writeDeliveryPermissions(harnessName: string, dir: string): void {
    if (harnessName !== 'claude') return; // codex sandboxing reviewed separately (DAT-248)
    try {
      const settingsDir = path.join(dir, '.claude');
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({ permissions: { allow: DELIVERY_ALLOW_RULES } }, null, 2),
      );
    } catch (e) {
      // A run without the allowlist still implements — it just can't deliver;
      // say so loudly instead of failing the claim.
      this.emit({ kind: 'note', text: `could not write delivery allowlist: ${msg(e)} — the run may be unable to push/PR`, ts: now() });
    }
  }

  private runHarness(
    harness: Harness,
    prompt: string,
    cwd: string,
    extraEnv: Record<string, string>,
    model: string | null = null,
  ): Promise<number> {
    return new Promise((resolve) => {
      const viaArg = harness.promptVia === 'arg';
      // The lead's model choice for this agent (DAT-279), as the harness's own switch.
      const modelArgs = harness.modelArgs(model);
      // Delivery allowlist, caller-granted (DAT-264): headless Claude Code
      // rightly ignores permission ALLOW rules from a project settings file in
      // a fresh untrusted directory (any cloned repo could self-grant), which
      // is why the DAT-248 workdir settings.json alone stranded deliveries.
      // The grant must come from the CALLER — these flags. Same scope as the
      // settings file, which stays as documentation/backstop.
      const deliveryArgs =
        harness.name === 'claude' ? ['--allowedTools', DELIVERY_ALLOW_RULES.join(',')] : [];
      const args = viaArg
        ? [...harness.args, ...modelArgs, ...deliveryArgs, prompt]
        : [...harness.args, ...modelArgs, ...deliveryArgs];
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

  /** Wrap the UI emit so tool and usage events also stream to the console. */
  private toolStream: ToolCallStream | null = null;
  private tapTools(emit: { print(t: string): void; tool(n: string, i: unknown): void }) {
    return {
      print: emit.print,
      tool: (name: string, input: unknown) => {
        emit.tool(name, input);
        this.toolStream?.push(name, input);
      },
      // Token usage (DAT-266): fold into totals, surface in the live feed,
      // batch home. Adapters call this optionally (emit.usage?.).
      usage: (sample: { input: number; output: number; cacheRead: number; cacheCreate: number; costUsd?: number; final?: boolean }) => {
        this.recordUsage(sample);
        this.emit({ kind: 'usage', ...sample, ticketKey: this.current?.ticketKey ?? '', ts: now() });
        this.usageStream?.push(sample);
      },
    };
  }

  /**
   * The run configuration from this machine's settings (DAT-280): the local
   * model, plus registry entries picked by slug and resolved against the
   * task's project (shared + that project's own, published). Nothing local
   * set → the console's mirror as delivered in the work package.
   */
  private async resolveLocalConfig(pkg: WorkPackage): Promise<AgentRunConfig | null> {
    const local = this.localConfig();
    const fromServer = pkg.agentConfig ?? null;
    if (!local.model && !local.mcpServers.length && !local.skills.length) return fromServer;
    const project = pkg.task.engagement_id ?? null;
    try {
      const reg = await this.client.registry(project);
      const pick = <T extends { slug: string; status: string; engagementId: string | null }>(entries: T[], slugs: string[]) =>
        slugs
          .map((slug) => entries.find((e) => e.slug === slug && e.status === 'published' && e.engagementId === project) ?? entries.find((e) => e.slug === slug && e.status === 'published'))
          .filter((e): e is T => Boolean(e));
      const mcpServers = pick(reg.mcpServers, local.mcpServers);
      const skills = pick(reg.skills, local.skills);
      const missing = [...local.mcpServers.filter((s) => !mcpServers.some((m) => m.slug === s)), ...local.skills.filter((s) => !skills.some((k) => k.slug === s))];
      if (missing.length) {
        this.emit({ kind: 'note', text: `registry entries not available to this project, skipped: ${missing.join(', ')}`, ts: now() });
      }
      return { model: local.model ?? fromServer?.model ?? null, mcpServers, skills };
    } catch (e) {
      this.emit({ kind: 'note', text: `registry lookup failed (${msg(e)}) — using the console's copy of this agent's config`, ts: now() });
      return fromServer ? { ...fromServer, model: local.model ?? fromServer.model } : { model: local.model, mcpServers: [], skills: [] };
    }
  }

  /** Dev token from the identity broker; failures degrade to null (fallbacks run). */
  private async devToken(provider: 'github' | 'ado'): Promise<string | null> {
    if (!this.identity) return null;
    try {
      return await this.identity.getAccessToken(provider);
    } catch (e) {
      this.emit({ kind: 'note', text: `${provider} identity unavailable: ${msg(e)}`, ts: now() });
      return null;
    }
  }

  /** Clone with the given git env (dev credential or none); never throws. */
  private clone(repoUrl: string, dir: string, gitEnv: Record<string, string>): void {
    try {
      execFileSync('git', ['clone', repoUrl, 'repo'], {
        cwd: dir,
        env: { ...process.env, ...gitEnv },
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (e) {
      this.emit({ kind: 'note', text: `clone failed: ${msg(e)} — continuing without repo`, ts: now() });
    }
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

/** Batched usage samples → POST /api/agent/work/:id/usage (DAT-266). Same
 *  discipline as ToolCallStream: telemetry, dropped batches logged never
 *  retried; a final sample flushes immediately (it replaces server rollups). */
class UsageStream {
  private pending: { input: number; output: number; cacheRead: number; cacheCreate: number; costUsd?: number; final?: boolean }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly agent: string,
    private readonly taskId: number,
    private readonly client: ConsoleClient,
    private readonly note: (ev: RunnerEvent) => void,
  ) {}

  push(sample: { input: number; output: number; cacheRead: number; cacheCreate: number; costUsd?: number; final?: boolean }): void {
    this.pending.push(sample);
    if (sample.final || this.pending.length >= 50) void this.flush();
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
      const samples = this.pending.splice(0, 200);
      try {
        await this.client.request(`/api/agent/work/${this.taskId}/usage`, {
          method: 'POST',
          body: JSON.stringify({ agent: this.agent, samples }),
        });
      } catch (e) {
        this.note({ kind: 'note', text: `usage stream dropped ${samples.length} sample(s): ${msg(e)}`, ts: now() });
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

/** ADO host of a client-owned repo URL, or null for anything else. */
function adoHostOf(repoUrl: string): string | null {
  try {
    const host = new URL(repoUrl).host;
    return host === 'dev.azure.com' || host.endsWith('.visualstudio.com') ? host : null;
  } catch {
    return null;
  }
}

/**
 * Git config via env only (git ≥2.31): the credential reaches every git
 * invocation of the run — clone and whatever the agent does after — without
 * ever landing in a file. ADO accepts AAD access tokens as a bearer header.
 */
function bearerGitEnv(host: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
}

/**
 * Same env-only pattern for basic-auth hosts (GitHub): an inline credential
 * helper answers `get`, after an empty entry resets any system helper (GCM)
 * so ours is authoritative. Tokens are URL-safe — no quoting hazards.
 */
function basicGitEnv(host: string, username: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `credential.https://${host}.helper`,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: `credential.https://${host}.helper`,
    GIT_CONFIG_VALUE_1: `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' '${username}' '${token}'; }; f`,
  };
}

const now = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
