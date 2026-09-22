import type { UsageTotals } from '../types';

/** Display helpers for token usage (DAT-260). */

export const usageTokens = (t: UsageTotals): number => t.input + t.output + t.cacheRead + t.cacheCreate;

/** 950 → "950", 12 400 → "12.4K", 3 150 000 → "3.2M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtCost(usd: number | null): string {
  if (usd == null) return '';
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}
