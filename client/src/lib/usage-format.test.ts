import { describe, expect, it } from 'vitest';
import { cacheLine, fmtCost, fmtCostLabel, fmtTokens, usageCacheTokens, usageTokens } from './usage-format';

/** Token consumption is input + output; cache is a secondary line; estimated cost is labelled. */

const usage = { input: 168, output: 551, cacheRead: 6_800_000, cacheCreate: 140_000, costUsd: null };

describe('usageTokens', () => {
  it('sums input and output only', () => {
    expect(usageTokens(usage)).toBe(719);
    expect(usageCacheTokens(usage)).toBe(6_940_000);
  });

  it('formats the cache as its own line', () => {
    expect(cacheLine(usage)).toBe('cache 6.8M read · 140.0K written');
    expect(fmtTokens(719)).toBe('719');
    expect(fmtTokens(12_400)).toBe('12.4K');
    expect(fmtTokens(3_260_000)).toBe('3.3M');
  });
});

describe('cost labels', () => {
  it('prints recorded bare, estimated with "est.", and names what has no rate', () => {
    expect(fmtCost(null)).toBe('');
    expect(fmtCost(0.004)).toBe('<$0.01');
    expect(fmtCostLabel({ usd: 1.5, estimated: false, unpriced: [] })).toBe('$1.50');
    expect(fmtCostLabel({ usd: 1.5, estimated: true, unpriced: [] })).toBe('est. $1.50');
    expect(fmtCostLabel({ usd: null, estimated: false, unpriced: ['my-endpoint'] })).toBe('est. — no rate for my-endpoint');
    expect(fmtCostLabel({ usd: 2, estimated: true, unpriced: ['a', 'b'] })).toBe('est. $2.00 · no rate for a, b');
    expect(fmtCostLabel({ usd: null, estimated: false, unpriced: true })).toBe('est. — no rate for this model');
    expect(fmtCostLabel({ usd: null, estimated: false, unpriced: [] })).toBe('');
  });
});
