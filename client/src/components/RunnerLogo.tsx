import { CLAUDE_CODE, harnessBrand, type AgentBrand } from './AgentLogos';

/**
 * Runner-software branding for assigned-runner avatars: resolves a runner id
 * (the agent name on a claimed task) to the logo shown in place of initials.
 *
 * The marks themselves live in AgentLogos.tsx — this module only maps a runner
 * id onto one, so the dependency runs one way (RunnerLogo → AgentLogos).
 */

export type RunnerBrand = AgentBrand;
export { CLAUDE_CODE };

/**
 * A runner names its own harness (`codex-1`, `gemini-2`, …). This mirrors
 * `inferHarness` in server/routes/agents.ts, which brands the same fleet on
 * the /agents map — keep the two in step when a harness is added.
 */
export function inferHarness(runner: string): string {
  const n = runner.toLowerCase();
  if (n.includes('codex')) return 'codex';
  if (n.includes('gemini')) return 'gemini';
  if (n.includes('copilot')) return 'copilot';
  if (n.includes('cursor')) return 'cursor';
  return 'claude-code';
}

/** Claude Code is the default: an unnamed harness is the fleet's original one. */
export function runnerBrand(runner: string): RunnerBrand {
  return harnessBrand(inferHarness(runner)) ?? CLAUDE_CODE;
}
