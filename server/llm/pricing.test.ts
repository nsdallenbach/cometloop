import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICES, DEFAULT_RATES, addSliceCost, emptyRollup, estimateCost, matchModel, mergePrices, normalizeModelId, ratesOf, sliceCost } from './pricing';

/** Pure pricing: id matching, the cost formula, the shared slice rule and the default/override merge. */

describe('matchModel', () => {
  it('normalizes dated, hosted and versioned ids to the provider id', () => {
    expect(normalizeModelId('claude-sonnet-5-20260401')).toBe('claude-sonnet-5');
    expect(normalizeModelId('databricks-claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizeModelId('system.ai.databricks-claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeModelId('us.anthropic.claude-sonnet-5-20260401-v1:0')).toBe('claude-sonnet-5');
    expect(normalizeModelId('claude-sonnet-5@20260401')).toBe('claude-sonnet-5');
    expect(normalizeModelId('gpt-5-2025-08-07')).toBe('gpt-5');
    expect(normalizeModelId('GPT-5.5')).toBe('gpt-5-5');
    expect(normalizeModelId('databricks-gpt-5-5')).toBe('gpt-5-5');
    expect(normalizeModelId('gemini-2.5-flash-preview-05-20')).toBe('gemini-2-5-flash');
    expect(normalizeModelId('models/gemini-2.5-pro')).toBe('gemini-2-5-pro');
  });

  it('matches exactly, then by the longest dash-bounded prefix', () => {
    expect(matchModel('claude-sonnet-5')?.model).toBe('claude-sonnet-5');
    expect(matchModel('claude-sonnet-5-20260401')?.model).toBe('claude-sonnet-5');
    expect(matchModel('claude-haiku-4-5-20251001')?.model).toBe('claude-haiku-4-5');
    expect(matchModel('claude-fable-5-1')?.model).toBe('claude-fable-5-1');
    expect(matchModel('claude-fable-5-1-20260601')?.model).toBe('claude-fable-5-1');
    expect(matchModel('claude-opus-5-5')?.model).toBe('claude-opus-5-5');
    expect(matchModel('claude-opus-5-20260101')?.model).toBe('claude-opus-5');
    expect(matchModel('databricks-claude-sonnet-5')?.model).toBe('claude-sonnet-5');
    expect(matchModel('databricks-gpt-5-5')?.model).toBe('gpt-5.5');
    expect(matchModel('gpt-5-mini')?.model).toBe('gpt-5-mini');
    expect(matchModel('gpt-5-mini-2025-08-07')?.model).toBe('gpt-5-mini');
    expect(matchModel('o4-mini-2025-04-16')?.model).toBe('o4-mini');
    expect(matchModel('gemini-2.5-pro-preview-06-05')?.model).toBe('gemini-2.5-pro');
  });

  it('prices nothing it does not know', () => {
    expect(matchModel('')).toBeNull();
    expect(matchModel('llama-3.3-70b')).toBeNull();
    expect(matchModel('my-serving-endpoint')).toBeNull();
    // A prefix has to be dash-bounded: `gpt-5x` is not `gpt-5`.
    expect(matchModel('gpt-5x')).toBeNull();
  });

  it('every default row is its own best match and carries provenance', () => {
    for (const p of DEFAULT_MODEL_PRICES) {
      expect(matchModel(p.model)?.model).toBe(p.model);
      expect(p.sourceUrl).toMatch(/^https:\/\//);
      expect(p.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.inputPerM).toBeGreaterThan(0);
      expect(p.outputPerM).toBeGreaterThan(0);
    }
    expect(new Set(DEFAULT_MODEL_PRICES.map((p) => normalizeModelId(p.model))).size).toBe(DEFAULT_MODEL_PRICES.length);
  });
});

describe('estimateCost / sliceCost', () => {
  const sonnet = matchModel('claude-sonnet-5', DEFAULT_RATES);

  it('is input×in + output×out + cacheRead×cr + cacheWrite×cw per million', () => {
    // 1M in ($2) + 100k out ($1) + 6.8M cache read ($1.36) + 140k cache write ($0.35)
    expect(estimateCost({ input: 1_000_000, output: 100_000, cacheRead: 6_800_000, cacheCreate: 140_000 }, sonnet)).toBeCloseTo(4.71, 6);
    expect(estimateCost({ input: 1, output: 1, cacheRead: 0, cacheCreate: 0 }, null)).toBeNull();
  });

  it('keeps a recorded cost, estimates the unpriced remainder, flags a model with no rate', () => {
    const none = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    expect(sliceCost({ model: 'claude-sonnet-5', recordedUsd: 1.5, unpriced: none }, DEFAULT_RATES)).toEqual({ usd: 1.5, estimated: false, unpriced: false });
    expect(sliceCost({ model: 'claude-sonnet-5', recordedUsd: null, unpriced: { input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 } }, DEFAULT_RATES)).toEqual({ usd: 2, estimated: true, unpriced: false });
    // Recorded final rows plus an unfinished run's per-turn rows on the same model.
    expect(sliceCost({ model: 'claude-sonnet-5', recordedUsd: 1.5, unpriced: { input: 500_000, output: 0, cacheRead: 0, cacheCreate: 0 } }, DEFAULT_RATES)).toEqual({ usd: 2.5, estimated: true, unpriced: false });
    expect(sliceCost({ model: 'my-endpoint', recordedUsd: null, unpriced: { input: 10, output: 1, cacheRead: 0, cacheCreate: 0 } }, DEFAULT_RATES)).toEqual({ usd: null, estimated: false, unpriced: true });
    expect(sliceCost({ model: 'my-endpoint', recordedUsd: 0.4, unpriced: { input: 10, output: 1, cacheRead: 0, cacheCreate: 0 } }, DEFAULT_RATES)).toEqual({ usd: 0.4, estimated: false, unpriced: true });
  });

  it('rolls slices up null-aware and names each unpriced model once', () => {
    const r = emptyRollup();
    addSliceCost(r, 'a', { usd: null, estimated: false, unpriced: true });
    expect(r).toEqual({ usd: null, estimated: false, unpricedModels: ['a'] });
    addSliceCost(r, 'b', { usd: 1.25, estimated: true, unpriced: false });
    addSliceCost(r, 'a', { usd: null, estimated: false, unpriced: true });
    addSliceCost(r, '', { usd: null, estimated: false, unpriced: true });
    expect(r).toEqual({ usd: 1.25, estimated: true, unpricedModels: ['a', 'unknown model'] });
  });
});

describe('mergePrices', () => {
  it('lays overrides over the defaults by normalized id and keeps the default for reset', () => {
    const merged = mergePrices([
      { model: 'claude-sonnet-5-20260401', inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1, updatedBy: 'admin@x', updatedAt: '2026-09-23T00:00:00.000Z' },
      { model: 'my-endpoint', inputPerM: 3, outputPerM: 9, cacheReadPerM: 0, cacheWritePerM: 0, updatedBy: 'admin@x', updatedAt: null },
    ]);
    expect(merged.length).toBe(DEFAULT_MODEL_PRICES.length + 1);
    const sonnet = merged.find((p) => p.model === 'claude-sonnet-5');
    expect(sonnet).toMatchObject({ source: 'override', inputPerM: 1, outputPerM: 5, provider: 'anthropic', updatedBy: 'admin@x' });
    expect(sonnet?.default).toMatchObject({ inputPerM: 2, outputPerM: 10, sourceUrl: 'https://claude.com/pricing' });
    const custom = merged.find((p) => p.model === 'my-endpoint');
    expect(custom).toMatchObject({ source: 'override', provider: null, default: null, inputPerM: 3 });
    expect(merged.filter((p) => p.source === 'default').length).toBe(DEFAULT_MODEL_PRICES.length - 1);
    // Providers group together, vendor order first.
    expect(merged[0].provider).toBe('anthropic');
    expect(merged[merged.length - 1].model).toBe('my-endpoint');

    // The effective rate table prices by the override and knows the custom endpoint.
    const rates = ratesOf(merged);
    expect(estimateCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheCreate: 0 }, matchModel('claude-sonnet-5', rates))).toBe(1);
    expect(matchModel('my-endpoint', rates)?.inputPerM).toBe(3);
  });
});
