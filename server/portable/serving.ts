import { ModelNotConfiguredError } from '../routes/llm-health';

/**
 * Model-serving stand-in for the portable runtime (platform-architecture
 * phase 0). There is no provider yet outside Databricks — phase 3 brings the
 * provider registry — so every invoke fails fast with
 * {@link ModelNotConfiguredError}. `invokeModel` recognises that error, skips
 * its retry and the ⚠ feed item, and rethrows, so each caller's deterministic
 * fallback applies exactly as it does during a model outage: the app stays
 * usable, ticket refinement and estimates just come from the fallbacks.
 */
export type Serving = (alias: string) => { invoke(body: unknown): Promise<unknown> };

export function unconfiguredServing(reason: string): Serving {
  return () => ({
    invoke: () => Promise.reject(new ModelNotConfiguredError(reason)),
  });
}
