import type { ReactNode } from 'react';

/**
 * Runner-software branding for assigned-runner avatars: resolves a runner id
 * (the agent name on a claimed task) to the logo shown in place of initials.
 */

export interface RunnerBrand {
  /** Runner software name, for tooltips ("Claude Code"). */
  label: string;
  mark: (size: number) => ReactNode;
}

/**
 * The Claude Code pixel mascot ("Clawd") in the brand terracotta — NOT the
 * Claude starburst, which brands the Claude product rather than Claude Code.
 * Drawn as one even-odd path on a 20×14 pixel grid: body with side arms, two
 * eye cutouts (transparent, so the avatar background shows through), four
 * legs. Scales crisply with the avatar.
 */
export const CLAUDE_CODE: RunnerBrand = {
  label: 'Claude Code',
  mark: (size) => (
    <svg width={size} height={size * 0.7} viewBox="0 0 20 14" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path
        fill="#D97757"
        fillRule="evenodd"
        d="M3,2 H17 V6 H20 V9 H17 V11 H3 V9 H0 V6 H3 Z
           M6,4 H8 V7 H6 Z
           M12,4 H14 V7 H12 Z
           M4,11 H5.5 V14 H4 Z
           M6.5,11 H8 V14 H6.5 Z
           M12,11 H13.5 V14 H12 Z
           M14.5,11 H16 V14 H14.5 Z"
      />
    </svg>
  ),
};

/** Runner ids with non-default branding — add entries as new runner types come online. */
const BRANDS: Record<string, RunnerBrand> = {};

/** Every runner in the fleet today is a Claude Code instance, so that's the default. */
export function runnerBrand(runner: string): RunnerBrand {
  return BRANDS[runner] ?? CLAUDE_CODE;
}
