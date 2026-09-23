/**
 * Model prices and estimated cost.
 *
 * A usage row carries a recorded `cost_usd` only when the harness computed
 * one (Claude Code's own figure on a final sample). Every other row — per-turn
 * samples, codex finals, every control-plane call — has tokens and no price,
 * so the console estimates: `input×in + output×out + cacheRead×cr +
 * cacheWrite×cw` at the row's model's rates, USD per 1M tokens.
 *
 * Rates come from {@link DEFAULT_MODEL_PRICES} — pulled from the providers'
 * own pricing pages, each row stamped with its source URL and the date it was
 * fetched — overridden per workspace by `app.model_prices` (tenant-scoped,
 * edited on the Admin page). {@link matchModel} maps the ids usage rows carry
 * (dated, vendor-prefixed, Databricks-endpoint-named) to a row by prefix.
 *
 * Everything but the two `load*` helpers is pure; `pricing.test.ts` covers it.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const MODEL_PRICES_SCHEMA_SQL = [
  // Primary key becomes (tenant_id, model) in server/db/tenancy.ts.
  `CREATE TABLE IF NOT EXISTS app.model_prices (
    model TEXT PRIMARY KEY,
    input_per_m DOUBLE PRECISION NOT NULL DEFAULT 0,
    output_per_m DOUBLE PRECISION NOT NULL DEFAULT 0,
    cache_read_per_m DOUBLE PRECISION NOT NULL DEFAULT 0,
    cache_write_per_m DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

/** USD per 1M tokens. */
export interface PriceRates {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

export interface ModelPrice extends PriceRates {
  /** The id as the provider names it (undated). */
  model: string;
  provider: 'anthropic' | 'openai' | 'google';
  /** Where the numbers came from. */
  sourceUrl: string;
  /** YYYY-MM-DD the page was read. */
  fetchedAt: string;
  /** Anything the page said that the four numbers cannot carry (tiers, storage fees). */
  note?: string;
}

const ANTHROPIC = { provider: 'anthropic' as const, sourceUrl: 'https://claude.com/pricing', fetchedAt: '2026-09-23' };
const OPENAI = { provider: 'openai' as const, sourceUrl: 'https://developers.openai.com/api/docs/pricing', fetchedAt: '2026-09-23' };
const GOOGLE = { provider: 'google' as const, sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing', fetchedAt: '2026-09-23' };

const price = (
  base: typeof ANTHROPIC | typeof OPENAI | typeof GOOGLE,
  model: string,
  inputPerM: number,
  outputPerM: number,
  cacheReadPerM: number,
  cacheWritePerM: number,
  note?: string,
): ModelPrice => ({ ...base, model, inputPerM, outputPerM, cacheReadPerM, cacheWritePerM, ...(note ? { note } : {}) });

/**
 * List prices as the providers publish them. Numbers are quoted from the
 * page named on each row on the date named; nothing here is inferred. Models
 * the registry offers that have no published per-token price (Databricks
 * Foundation Model APIs list DBU rates for open models only and none for
 * the Claude / GPT endpoints; Bedrock and Vertex resell at their own rates)
 * are deliberately absent — a Databricks-hosted `databricks-claude-sonnet-5`
 * still matches the Anthropic row by prefix, which is the vendor's list
 * price, not the DBU rate, and the PR / docs say so.
 */
export const DEFAULT_MODEL_PRICES: readonly ModelPrice[] = [
  // Anthropic — cache write is the 5-minute TTL price the page shows.
  price(ANTHROPIC, 'claude-fable-5-1', 10, 50, 0.25, 12.5),
  price(ANTHROPIC, 'claude-fable-5', 10, 50, 1, 12.5, 'legacy'),
  price(ANTHROPIC, 'claude-opus-5-5', 4, 20, 0.2, 5),
  price(ANTHROPIC, 'claude-opus-5', 5, 25, 0.5, 6.25, 'legacy'),
  price(ANTHROPIC, 'claude-opus-4-8', 5, 25, 0.5, 6.25, 'legacy'),
  price(ANTHROPIC, 'claude-opus-4-7', 5, 25, 0.5, 6.25, 'legacy'),
  price(ANTHROPIC, 'claude-opus-4-6', 5, 25, 0.5, 6.25, 'legacy'),
  price(ANTHROPIC, 'claude-opus-4-5', 5, 25, 0.5, 6.25, 'legacy'),
  price(ANTHROPIC, 'claude-sonnet-5', 2, 10, 0.2, 2.5),
  price(ANTHROPIC, 'claude-sonnet-4-6', 3, 15, 0.3, 3.75, 'legacy'),
  price(ANTHROPIC, 'claude-sonnet-4-5', 3, 15, 0.3, 3.75, 'legacy'),
  price(ANTHROPIC, 'claude-haiku-4-5', 1, 5, 0.1, 1.25),
  // OpenAI — "cached input" is the cache-read price; there is no charge to write the cache.
  price(OPENAI, 'gpt-6-astra', 10, 50, 1, 0),
  price(OPENAI, 'gpt-6-sol', 2, 10, 0.2, 0),
  price(OPENAI, 'gpt-6-luna', 0.1, 0.5, 0.01, 0),
  price(OPENAI, 'gpt-5.6-sol', 4, 20, 0.4, 0),
  price(OPENAI, 'gpt-5.6-terra', 2, 12, 0.2, 0),
  price(OPENAI, 'gpt-5.6-luna', 0.2, 1.2, 0.02, 0),
  price(OPENAI, 'gpt-5.5', 5, 30, 0.5, 0),
  price(OPENAI, 'gpt-5.4', 2.5, 15, 0.25, 0),
  price(OPENAI, 'gpt-5.4-mini', 0.75, 4.5, 0.075, 0),
  price(OPENAI, 'gpt-5.4-nano', 0.2, 1.25, 0.02, 0),
  price(OPENAI, 'gpt-5.3-codex', 1.75, 14, 0.175, 0),
  price(OPENAI, 'gpt-5.2', 1.75, 14, 0.175, 0),
  price(OPENAI, 'gpt-5.1', 1.25, 10, 0.125, 0),
  price(OPENAI, 'gpt-5', 1.25, 10, 0.125, 0),
  price(OPENAI, 'gpt-5-mini', 0.25, 2, 0.025, 0),
  price(OPENAI, 'gpt-5-nano', 0.05, 0.4, 0.005, 0),
  price(OPENAI, 'gpt-4.1', 2, 8, 0.5, 0),
  price(OPENAI, 'gpt-4.1-mini', 0.4, 1.6, 0.1, 0),
  price(OPENAI, 'gpt-4.1-nano', 0.1, 0.4, 0.025, 0),
  price(OPENAI, 'o3-pro', 20, 80, 0, 0, 'no cached-input price listed'),
  price(OPENAI, 'o3-mini', 1.1, 4.4, 0.55, 0),
  price(OPENAI, 'o3', 2, 8, 0.5, 0),
  price(OPENAI, 'o4-mini', 1.1, 4.4, 0.275, 0),
  // Google — the ≤200k-prompt tier; "context caching" is the cache-read price, cache storage is billed per hour, not per token.
  price(GOOGLE, 'gemini-2.5-pro', 1.25, 10, 0.125, 0, 'prompts ≤200k tokens; >200k is $2.50 in / $15 out / $0.25 cache read'),
  price(GOOGLE, 'gemini-2.5-flash', 0.3, 2.5, 0.03, 0, 'text / image / video input; audio input is $1.00'),
  price(GOOGLE, 'gemini-2.5-flash-lite', 0.1, 0.4, 0.01, 0, 'text / image / video input; audio input is $0.30'),
];

// ---------- id matching ----------

/** Vendor / host prefixes a usage row's model id may carry in front of the provider's own id. */
const HOST_PREFIXES = ['databricks-', 'system.ai.', 'us.anthropic.', 'eu.anthropic.', 'global.anthropic.', 'apac.anthropic.', 'anthropic.', 'openai.', 'google.', 'models/'];

/**
 * The comparable form of a model id: lower-cased, host prefix and the
 * dated / versioned / preview suffixes stripped, dots as dashes (so
 * `gpt-5.5` and Databricks' `gpt-5-5` are one key).
 */
export function normalizeModelId(id: string): string {
  let m = id.trim().toLowerCase();
  // Prefixes stack (`system.ai.databricks-claude-opus-5`): strip until none is left.
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const p of HOST_PREFIXES) {
      if (m.startsWith(p)) {
        m = m.slice(p.length);
        stripped = true;
      }
    }
  }
  m = m
    .replace(/-v\d+:\d+$/, '') // bedrock `-v1:0`
    .replace(/@\d{8}$/, '') // vertex `@20260401`
    .replace(/-(?:preview|latest)(?:-\d{2}-\d{2})?$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '') // openai `-2025-08-07`
    .replace(/-\d{8}$/, ''); // anthropic `-20260401`
  return m.replace(/\./g, '-');
}

export type RateRow = PriceRates & { model: string };
/** The effective rate table: normalized id → rates (+ provenance). */
export type RateTable = ReadonlyMap<string, RateRow>;

const withKeys = <T extends { model: string }>(rows: readonly T[]): Map<string, T> => new Map(rows.map((r) => [normalizeModelId(r.model), r]));

export const DEFAULT_RATES: RateTable = withKeys(DEFAULT_MODEL_PRICES);

/**
 * The price row for a model id, or null when nothing prices it. Exact on
 * the normalized id first, then the longest row that is a `-`-bounded
 * prefix of it (`claude-sonnet-5-20260401` → `claude-sonnet-5`,
 * `databricks-claude-opus-5` → `claude-opus-5`, `gpt-5-mini` never matches
 * `gpt-5` because it has its own row).
 */
export function matchModel(id: string, table: RateTable = DEFAULT_RATES): RateRow | null {
  const key = normalizeModelId(id);
  if (!key) return null;
  const exact = table.get(key);
  if (exact) return exact;
  let best: RateRow | null = null;
  let bestLen = 0;
  for (const [k, row] of table) {
    if (k.length > bestLen && key.startsWith(`${k}-`)) {
      best = row;
      bestLen = k.length;
    }
  }
  return best;
}

// ---------- cost ----------

export interface UsageBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** USD for the buckets at the rates; null without rates. */
export function estimateCost(u: UsageBuckets, rates: PriceRates | null): number | null {
  if (!rates) return null;
  return (u.input * rates.inputPerM + u.output * rates.outputPerM + u.cacheRead * rates.cacheReadPerM + u.cacheCreate * rates.cacheWritePerM) / 1_000_000;
}

/**
 * One aggregated slice of usage: the recorded cost the rows carried (sum of
 * non-null `cost_usd`) and the tokens of the rows that carried none — the
 * part that has to be estimated.
 */
export interface CostSlice {
  model: string;
  recordedUsd: number | null;
  unpriced: UsageBuckets;
}

export interface SliceCost {
  usd: number | null;
  /** Some of the figure came from rates rather than a recorded cost. */
  estimated: boolean;
  /** Tokens went uncosted because nothing prices the model. */
  unpriced: boolean;
}

const hasTokens = (u: UsageBuckets): boolean => u.input + u.output + u.cacheRead + u.cacheCreate > 0;

/**
 * The shared cost rule (drawer, Metrics page, top tickets): recorded cost
 * stays as recorded; rows without one are estimated at the model's rates;
 * a model nothing prices contributes nothing and is flagged rather than
 * shown as $0.
 */
export function sliceCost(slice: CostSlice, rates: RateTable): SliceCost {
  if (!hasTokens(slice.unpriced)) return { usd: slice.recordedUsd, estimated: false, unpriced: false };
  const est = estimateCost(slice.unpriced, matchModel(slice.model, rates));
  if (est === null) return { usd: slice.recordedUsd, estimated: false, unpriced: true };
  return { usd: (slice.recordedUsd ?? 0) + est, estimated: true, unpriced: false };
}

/** Fold slice costs into a running total: null-aware sum, OR on the flags, the unpriced models by name. */
export interface CostRollup {
  usd: number | null;
  estimated: boolean;
  unpricedModels: string[];
}

export const emptyRollup = (): CostRollup => ({ usd: null, estimated: false, unpricedModels: [] });

export function addSliceCost(into: CostRollup, model: string, c: SliceCost): void {
  if (c.usd != null) into.usd = (into.usd ?? 0) + c.usd;
  if (c.estimated) into.estimated = true;
  if (c.unpriced) {
    const label = model || 'unknown model';
    if (!into.unpricedModels.includes(label)) into.unpricedModels.push(label);
  }
}

// ---------- workspace overrides ----------

export interface PriceOverride extends PriceRates {
  model: string;
  updatedBy: string;
  updatedAt: string | null;
}

/** One row of the effective table the settings page shows. */
export interface EffectivePrice extends PriceRates {
  model: string;
  provider: ModelPrice['provider'] | null;
  source: 'default' | 'override';
  /** The default row this overrides (or is), so "Reset" can preview it. */
  default: (PriceRates & { sourceUrl: string; fetchedAt: string; note?: string }) | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? v : null);

export async function loadPriceOverrides(q: Query): Promise<PriceOverride[]> {
  const { rows } = await q('SELECT model, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, updated_by, updated_at FROM app.model_prices ORDER BY model');
  return rows.map((r) => ({
    model: str(r.model),
    inputPerM: num(r.input_per_m),
    outputPerM: num(r.output_per_m),
    cacheReadPerM: num(r.cache_read_per_m),
    cacheWritePerM: num(r.cache_write_per_m),
    updatedBy: str(r.updated_by),
    updatedAt: iso(r.updated_at),
  }));
}

/** Defaults with the overrides laid on top (by normalized id), sorted by provider then model. */
export function mergePrices(overrides: readonly PriceOverride[], defaults: readonly ModelPrice[] = DEFAULT_MODEL_PRICES): EffectivePrice[] {
  const byKey = new Map<string, EffectivePrice>();
  for (const d of defaults) {
    byKey.set(normalizeModelId(d.model), {
      model: d.model,
      provider: d.provider,
      source: 'default',
      inputPerM: d.inputPerM,
      outputPerM: d.outputPerM,
      cacheReadPerM: d.cacheReadPerM,
      cacheWritePerM: d.cacheWritePerM,
      default: { inputPerM: d.inputPerM, outputPerM: d.outputPerM, cacheReadPerM: d.cacheReadPerM, cacheWritePerM: d.cacheWritePerM, sourceUrl: d.sourceUrl, fetchedAt: d.fetchedAt, ...(d.note ? { note: d.note } : {}) },
      updatedBy: null,
      updatedAt: null,
    });
  }
  for (const o of overrides) {
    const key = normalizeModelId(o.model);
    const base = byKey.get(key);
    byKey.set(key, {
      model: base?.model ?? o.model,
      provider: base?.provider ?? null,
      source: 'override',
      inputPerM: o.inputPerM,
      outputPerM: o.outputPerM,
      cacheReadPerM: o.cacheReadPerM,
      cacheWritePerM: o.cacheWritePerM,
      default: base?.default ?? null,
      updatedBy: o.updatedBy,
      updatedAt: o.updatedAt,
    });
  }
  const order: Record<string, number> = { anthropic: 0, openai: 1, google: 2 };
  return [...byKey.values()].sort((a, b) => (order[a.provider ?? ''] ?? 9) - (order[b.provider ?? ''] ?? 9) || a.model.localeCompare(b.model));
}

export const ratesOf = (prices: readonly EffectivePrice[]): RateTable => withKeys(prices);

/** The workspace's effective rate table — one query. */
export async function loadEffectiveRates(q: Query): Promise<RateTable> {
  return ratesOf(mergePrices(await loadPriceOverrides(q)));
}
