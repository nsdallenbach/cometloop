// Types for the harness adapters (shared/harnesses/index.mjs re-exporting
// devbox-runner/harnesses.mjs). Process-mode fields are always present on
// claude/codex/generic; the service-mode surface exists only on hosted
// adapters (omnigent) and is unused by the desktop runner for now.
/** One token-usage sample (DAT-266): per model turn, or final run totals. */
export interface UsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Only on final samples from harnesses that report cost. */
  costUsd?: number;
  /** True = authoritative run totals; replace any accumulated sum. */
  final?: boolean;
}

export interface HarnessEmit {
  print(text: string): void;
  tool(name: string, input: unknown): void;
  /** Optional sink — adapters call it with ?. so older runners keep working. */
  usage?(sample: UsageSample): void;
}

/** A registry MCP server as it arrives in the work package (DAT-238 / DAT-279). */
export interface AgentMcpServer {
  slug: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  requiresAuth: boolean;
  /** Env var the runner must provide when requiresAuth (MCP_AUTH_<SLUG>). */
  authEnv: string | null;
}

/** A registry skill as it arrives in the work package. */
export interface AgentSkill {
  slug: string;
  name: string;
  description: string;
  content: string;
  harnesses: string[];
}

/** `workPackage.agentConfig` — the model and attachments the console resolved for the claiming agent. */
export interface AgentRunConfig {
  model: string | null;
  mcpServers: AgentMcpServer[];
  skills: AgentSkill[];
}

export interface Harness {
  name: string;
  mode?: 'service';
  bin: string;
  args: string[];
  promptVia: 'stdin' | 'arg';
  parseLine(line: string, emit: HarnessEmit): void;
  /**
   * Materialize what the harness can consume in the task workdir: the
   * console's MCP server (when a path is given) plus the agent's attachments.
   * `agentConfig` is optional so older callers keep working.
   */
  writeConfig(dir: string, mcpServerPath: string | null | undefined, agentConfig?: AgentRunConfig | null): void;
  /** CLI arguments that select a model; empty when the harness has no switch or no model is set. */
  modelArgs(model: string | null | undefined): string[];
  config?: Record<string, unknown>;
}

export function getHarness(name?: string | null, env?: Record<string, string | undefined>): Harness;
export function mcpServersConfig(mcpServerPath: string | null | undefined, agentConfig?: AgentRunConfig | null): { mcpServers: Record<string, unknown> };
export function writeClaudeSkills(dir: string, agentConfig?: AgentRunConfig | null): string[];
export function appendSkillsTo(dir: string, file: string, agentConfig?: AgentRunConfig | null): string[];
export function missingAuthEnv(agentConfig?: AgentRunConfig | null, env?: Record<string, string | undefined>): { slug: string; authEnv: string }[];
export function normalizeState(raw: unknown): 'running' | 'succeeded' | 'failed' | 'cancelled' | null;
export function toolLabel(input: unknown): string;
