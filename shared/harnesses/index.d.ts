// Types for the harness adapters (shared/harnesses/index.mjs re-exporting
// devbox-runner/harnesses.mjs). Process-mode fields are always present on
// claude/codex/generic; the service-mode surface exists only on hosted
// adapters (omnigent) and is unused by the desktop runner for now.
export interface HarnessEmit {
  print(text: string): void;
  tool(name: string, input: unknown): void;
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
