import { describe, expect, it } from 'vitest';
import { HARNESS_MODELS, STATIC_SERVING_ENDPOINTS, providerForModel } from './agent-models';
import { HARNESS_PROVIDER } from './agents';

describe('providerForModel', () => {
  it('brands the model families the console has logos for', () => {
    expect(providerForModel('databricks-claude-opus-5')).toBe('anthropic');
    expect(providerForModel('system.ai.databricks-gpt-6-astra')).toBe('openai');
    expect(providerForModel('databricks-gpt-5-3-codex')).toBe('openai');
    expect(providerForModel('databricks-gemini-3-8-flash')).toBe('google');
  });

  it('falls back to the workspace as provider for anything it does not recognize', () => {
    expect(providerForModel('databricks-inkling')).toBe('databricks');
    expect(providerForModel('mas-bbeee8b5-endpoint')).toBe('databricks');
    expect(providerForModel(null)).toBeNull();
  });
});

describe('static catalog', () => {
  it('offers harness models only for harnesses the console knows, each with one default', () => {
    for (const [harness, models] of Object.entries(HARNESS_MODELS)) {
      expect(Object.keys(HARNESS_PROVIDER), harness).toContain(harness);
      expect(
        models.filter((m) => m.default),
        harness
      ).toHaveLength(1);
      for (const m of models) expect(m.provider).toBe(HARNESS_PROVIDER[harness]);
    }
  });

  it('ships a provider for every static endpoint so the picker can show a logo', () => {
    for (const ep of STATIC_SERVING_ENDPOINTS) {
      expect(ep.provider, ep.name).not.toBeNull();
      expect(ep.task).toBe('llm/v1/chat');
    }
  });
});
