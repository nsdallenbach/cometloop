// Agent pool (DAT-245): N concurrent harness instances per agent type, each a
// RunnerHost with its own fleet identity (`<agentName>-<harness>-<n>`), own
// claim loop and own feed. The pool owns config application (grow/shrink),
// harness binary detection, auto-start, and routing "run this ticket" to an
// idle instance.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConsoleClient } from '../../../shared/api-client';
import { getHarness } from '../../../shared/harnesses';
import { saveAgentsConfig, type DesktopConfig } from './config';
import type { IdentityBroker } from './identity';
import { RunnerHost, type RunnerEvent, type RunnerSnapshot } from './runner';

const execFileP = promisify(execFile);

export type AgentKind = 'claude' | 'codex';
export const AGENT_KINDS: AgentKind[] = ['claude', 'codex'];

export interface InstanceSnapshot extends RunnerSnapshot {
  id: string;
  kind: AgentKind;
  label: string;
  agentName: string;
}

export interface AgentsState {
  kinds: Record<
    AgentKind,
    { installed: boolean; version: string | null; instances: number; autoStart: boolean }
  >;
  instances: InstanceSnapshot[];
}

interface Instance {
  id: string;
  kind: AgentKind;
  label: string;
  agentName: string;
  host: RunnerHost;
}

export class AgentPool {
  private instances: Instance[] = [];
  private detected: Record<AgentKind, { installed: boolean; version: string | null }> = {
    claude: { installed: false, version: null },
    codex: { installed: false, version: null },
  };

  constructor(
    private readonly cfg: DesktopConfig,
    private readonly client: ConsoleClient,
    private readonly broadcast: (instanceId: string, ev: RunnerEvent) => void,
    /** Dev identities (DAT-235), shared across all runner instances. */
    private readonly identity: IdentityBroker | null = null,
  ) {}

  /** Detect binaries, build instances to match config, start auto-start kinds. */
  async init(): Promise<void> {
    await this.detect();
    this.applyCounts();
    for (const kind of AGENT_KINDS) {
      if (this.cfg.agents[kind].autoStart) {
        for (const inst of this.instances.filter((i) => i.kind === kind)) inst.host.start();
      }
    }
  }

  private async detect(): Promise<void> {
    await Promise.all(
      AGENT_KINDS.map(async (kind) => {
        const bin = getHarness(kind).bin;
        try {
          const { stdout } = await execFileP(bin, ['--version'], {
            timeout: 15_000,
            windowsHide: true,
            shell: process.platform === 'win32', // claude/codex are .cmd shims on Windows
          });
          this.detected[kind] = { installed: true, version: stdout.trim().split('\n')[0].slice(0, 60) || null };
        } catch {
          this.detected[kind] = { installed: false, version: null };
        }
      }),
    );
  }

  /** Grow/shrink the instance list to match cfg.agents counts. */
  private applyCounts(): void {
    for (const kind of AGENT_KINDS) {
      const want = this.cfg.agents[kind].instances;
      const have = this.instances.filter((i) => i.kind === kind);
      for (let n = have.length + 1; n <= want; n++) this.instances.push(this.spawnInstance(kind, n));
      if (have.length > want) {
        // Shrink from the tail; busy instances finish their run, then stop.
        for (const inst of have.slice(want)) {
          inst.host.stop();
          this.instances = this.instances.filter((i) => i !== inst);
        }
      }
    }
  }

  private spawnInstance(kind: AgentKind, n: number): Instance {
    const id = `${kind}-${n}`;
    const inst: Instance = {
      id,
      kind,
      label: `${kind} ${n}`,
      agentName: `${this.cfg.agentName}-${id}`,
      host: new RunnerHost(
        this.cfg,
        `${this.cfg.agentName}-${id}`,
        kind,
        this.client,
        (ev) => this.broadcast(id, ev),
        this.identity,
      ),
    };
    return inst;
  }

  state(): AgentsState {
    return {
      kinds: {
        claude: { ...this.detected.claude, ...this.cfg.agents.claude },
        codex: { ...this.detected.codex, ...this.cfg.agents.codex },
      },
      instances: this.instances.map((i) => ({
        id: i.id,
        kind: i.kind,
        label: i.label,
        agentName: i.agentName,
        ...i.host.snapshot(),
      })),
    };
  }

  /** UI config change: persist, resize the pool, start newly added instances. */
  configure(kind: AgentKind, opts: { instances?: number; autoStart?: boolean }): AgentsState {
    const block = this.cfg.agents[kind];
    if (opts.instances !== undefined) block.instances = Math.max(0, Math.min(4, Math.trunc(opts.instances)));
    if (opts.autoStart !== undefined) block.autoStart = opts.autoStart;
    saveAgentsConfig(this.cfg);
    const before = new Set(this.instances.map((i) => i.id));
    this.applyCounts();
    // Instances added by this change start immediately — the user asked for
    // more capacity now, not after a manual start click.
    for (const inst of this.instances) {
      if (inst.kind === kind && !before.has(inst.id)) inst.host.start();
    }
    return this.state();
  }

  instance(id: string): Instance | undefined {
    return this.instances.find((i) => i.id === id);
  }

  /** Route a specific ticket to an idle instance (any kind, claude first). */
  async runTicket(ticketKey: string): Promise<{ ok: boolean; error?: string }> {
    const idle = this.instances.find((i) => i.host.idle());
    if (!idle) {
      return {
        ok: false,
        error: 'Every agent instance is busy — add an instance on the Agents page or wait for a run to finish.',
      };
    }
    return idle.host.runTicket(ticketKey);
  }

  /** Release an orphaned claim through any instance (they share identity auth). */
  releaseTask(taskId: number): Promise<{ ok: boolean; error?: string }> {
    const anyInst = this.instances[0];
    if (!anyInst) return Promise.resolve({ ok: false, error: 'No agent instances configured.' });
    return anyInst.host.releaseTask(taskId);
  }

  /** The task ids currently executing in live processes (orphan detection). */
  liveTaskIds(): number[] {
    return this.instances
      .map((i) => i.host.snapshot().current?.taskId)
      .filter((id): id is number => typeof id === 'number');
  }

  stopAll(): void {
    for (const inst of this.instances) inst.host.stop();
  }
}
