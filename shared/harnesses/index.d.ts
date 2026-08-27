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

export interface Harness {
  name: string;
  mode?: 'service';
  bin: string;
  args: string[];
  promptVia: 'stdin' | 'arg';
  parseLine(line: string, emit: HarnessEmit): void;
  writeConfig(dir: string, mcpServerPath: string): void;
  config?: Record<string, unknown>;
}

export function getHarness(name?: string | null, env?: Record<string, string | undefined>): Harness;
export function normalizeState(raw: unknown): 'running' | 'succeeded' | 'failed' | 'cancelled' | null;
export function toolLabel(input: unknown): string;
