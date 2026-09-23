import type { UsageTotals } from '../types';

/** Display helpers for token usage (DAT-260). */

/** The number people quote: input + output. Cache traffic is not consumption — show it, do not count it. */
export const usageTokens = (t: Pick<UsageTotals, 'input' | 'output'>): number => t.input + t.output;

/** Cache traffic, kept visible as a secondary line. */
export const usageCacheTokens = (t: Pick<UsageTotals, 'cacheRead' | 'cacheCreate'>): number => t.cacheRead + t.cacheCreate;

/** "cache 6.8M read · 140.0K written" — the secondary mono line under a token figure. */
export const cacheLine = (t: Pick<UsageTotals, 'cacheRead' | 'cacheCreate'>): string => `cache ${fmtTokens(t.cacheRead)} read · ${fmtTokens(t.cacheCreate)} written`;

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

/**
 * A cost with its provenance: recorded figures print bare, ones estimated
 * from the workspace's model rates carry "est.", and a slice nothing prices
 * says so rather than reading as $0.
 */
export function fmtCostLabel(c: { usd: number | null; estimated: boolean; unpriced: string[] | boolean }): string {
  const unpriced = Array.isArray(c.unpriced) ? c.unpriced : c.unpriced ? ['this model'] : [];
  if (c.usd == null) return unpriced.length ? `est. — no rate for ${unpriced.join(', ')}` : '';
  const figure = `${c.estimated ? 'est. ' : ''}${fmtCost(c.usd)}`;
  return unpriced.length ? `${figure} · no rate for ${unpriced.join(', ')}` : figure;
}
