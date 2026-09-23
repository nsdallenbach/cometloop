import { PROVIDER_KINDS, type ModelProvider, type ProviderKind } from '../provider';
import { anthropicProvider } from './anthropic';
import { bedrockProvider } from './bedrock';
import { databricksProvider } from './databricks';
import { openAiCompatibleProvider } from './openai-compatible';
import { vertexProvider } from './vertex';

/**
 * The provider registry: one adapter per `model_providers.kind`. The invoke
 * layer looks adapters up here and nowhere else, so a test can swap one in
 * with {@link setProviderForTests} without touching the network.
 */

const ADAPTERS: Record<ProviderKind, ModelProvider> = {
  anthropic: anthropicProvider,
  'openai-compatible': openAiCompatibleProvider,
  databricks: databricksProvider,
  bedrock: bedrockProvider,
  vertex: vertexProvider,
};

const overrides = new Map<ProviderKind, ModelProvider>();

export function isProviderKind(v: unknown): v is ProviderKind {
  return typeof v === 'string' && (PROVIDER_KINDS as readonly string[]).includes(v);
}

export function providerFor(kind: ProviderKind): ModelProvider {
  return overrides.get(kind) ?? ADAPTERS[kind];
}

/** Test seam: replace an adapter (null restores the real one). */
export function setProviderForTests(kind: ProviderKind, provider: ModelProvider | null): void {
  if (provider) overrides.set(kind, provider);
  else overrides.delete(kind);
}

/** Kinds whose adapter actually makes calls in this build. */
export const LIVE_PROVIDER_KINDS: readonly ProviderKind[] = ['anthropic', 'openai-compatible', 'databricks'];

export { anthropicProvider, bedrockProvider, databricksProvider, openAiCompatibleProvider, vertexProvider };
