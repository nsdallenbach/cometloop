import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FeedThrottle,
  categorizeFailure,
  invokeError,
  invokeModel,
  isTransientStatus,
  llmFlowStatuses,
  resetLlmHealthState,
  rolesHealth,
} from './llm-health';
import { ProviderError, ProviderNotAvailableError } from '../llm/provider';
import { installFakeProvider, memDbWithModels, resetLlm, seedProvider, type Query } from '../llm/test-support';

/**
 * The reliability layer over the provider registry: retry-once on
 * transients, categorized failures with per-flow counters, the throttled ⚠
 * feed item, and — since phase 3 — role resolution, the capability contract
 * and the control-plane usage row. The adapter is a scripted fake; the
 * configuration lives in pg-mem exactly as it does in production.
 */

describe('isTransientStatus', () => {
  it('treats network errors (no status) and 408/429/5xx as transient', () => {
    expect(isTransientStatus(undefined)).toBe(true);
    expect(isTransientStatus(408)).toBe(true);
    expect(isTransientStatus(429)).toBe(true);
    expect(isTransientStatus(500)).toBe(true);
    expect(isTransientStatus(503)).toBe(true);
  });

  it('never retries auth or payload errors', () => {
    expect(isTransientStatus(400)).toBe(false);
    expect(isTransientStatus(401)).toBe(false);
    expect(isTransientStatus(403)).toBe(false);
    expect(isTransientStatus(422)).toBe(false);
  });
});

describe('categorizeFailure', () => {
  it('buckets the failure classes the incident review asks about', () => {
    expect(categorizeFailure(undefined)).toBe('network');
    expect(categorizeFailure(401)).toBe('auth');
    expect(categorizeFailure(403)).toBe('auth');
    expect(categorizeFailure(429)).toBe('rate-limit');
    expect(categorizeFailure(500)).toBe('server');
    expect(categorizeFailure(408)).toBe('server');
    expect(categorizeFailure(400)).toBe('payload');
  });
});

describe('invokeError', () => {
  it('returns null for success wrappers and non-wrapper payloads', () => {
    expect(invokeError({ ok: true, data: {} })).toBeNull();
    expect(invokeError({ choices: [] })).toBeNull();
    expect(invokeError(null)).toBeNull();
    expect(invokeError('text')).toBeNull();
  });

  it('extracts message and status from a failed ExecutionResult', () => {
    expect(invokeError({ ok: false, status: 503, message: 'endpoint scaling' })).toEqual({ message: 'endpoint scaling', status: 503 });
    expect(invokeError({ ok: false })).toEqual({ message: 'model invocation failed', status: undefined });
  });
});

describe('FeedThrottle', () => {
  it('posts at most once per flow per window', () => {
    const t = new FeedThrottle(10_000);
    expect(t.shouldPost('estimate', 0)).toBe(true);
    expect(t.shouldPost('estimate', 5_000)).toBe(false);
    expect(t.shouldPost('estimate', 10_000)).toBe(true);
  });

  it('throttles flows independently', () => {
    const t = new FeedThrottle(10_000);
    expect(t.shouldPost('estimate', 0)).toBe(true);
    expect(t.shouldPost('ticket-refine', 1)).toBe(true);
  });
});

const SUPPORT_SQL = [
  `CREATE TABLE app.feed_items (id SERIAL PRIMARY KEY, engagement_id TEXT, actor TEXT, text TEXT, time_label TEXT, reversible BOOLEAN)`,
  `CREATE TABLE app.run_token_usage (id SERIAL PRIMARY KEY, task_id INT NOT NULL, ticket_key TEXT NOT NULL DEFAULT '', engagement_id TEXT NOT NULL DEFAULT '',
     agent TEXT NOT NULL DEFAULT '', input_tokens BIGINT NOT NULL DEFAULT 0, output_tokens BIGINT NOT NULL DEFAULT 0, cache_read_tokens BIGINT NOT NULL DEFAULT 0,
     cache_create_tokens BIGINT NOT NULL DEFAULT 0, cost_usd DOUBLE PRECISION, final BOOLEAN NOT NULL DEFAULT false, model TEXT NOT NULL DEFAULT '',
     source TEXT NOT NULL DEFAULT 'harness', provider TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
];

const REQ = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 10 };
const feedItems = async (q: Query) => (await q('SELECT engagement_id, text FROM app.feed_items ORDER BY id')).rows;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('invokeModel', () => {
  let q: Query;
  beforeEach(async () => {
    resetLlmHealthState();
    q = await memDbWithModels(SUPPORT_SQL);
    await seedProvider(q, { name: 'Anthropic', kind: 'anthropic', model: 'claude-sonnet-5', roles: 'all' });
  });
  afterEach(resetLlm);

  it('resolves the role to the tenant provider, returns the reply and records the success and the usage', async () => {
    const fake = installFakeProvider(q, 'anthropic', [{ text: 'OK', usage: { input: 12, output: 3, cacheRead: 7, cacheCreate: 0 } }]);
    const result = await invokeModel('estimate', REQ, { engagementId: 'exec', ticketKey: 'DAT-1' }, 0);
    expect(result.text).toBe('OK');
    expect(result.provider).toBe('anthropic');
    expect(fake.calls[0].model.model).toBe('claude-sonnet-5');
    expect(fake.calls[0].model.provider.name).toBe('Anthropic');
    expect(fake.calls[0].model.metadata).toMatchObject({ role: 'estimate', flow: 'estimate', ticket: 'DAT-1', project: 'exec' });
    const s = llmFlowStatuses().estimate;
    expect(s.calls).toBe(1);
    expect(s.failures).toBe(0);
    expect(s.lastSuccessAt).not.toBeNull();
    await flush();
    const rows = (await q('SELECT * FROM app.run_token_usage')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'control-plane', provider: 'anthropic', model: 'claude-sonnet-5', role: 'estimate', ticket_key: 'DAT-1', engagement_id: 'exec', agent: 'control-plane' });
    expect(Number(rows[0].input_tokens)).toBe(12);
    expect(Number(rows[0].cache_read_tokens)).toBe(7);
  });

  it('honours a per-role model and a caller model override', async () => {
    const fake = installFakeProvider(q, 'anthropic', ['a', 'b']);
    await q(`UPDATE app.model_roles SET model = 'claude-haiku-4-5-20251001' WHERE role = 'estimate'`);
    await invokeModel('estimate', REQ, {}, 0);
    await invokeModel('review', REQ, { modelOverride: 'ka-pr-reviewer' }, 0);
    expect(fake.calls.map((c) => c.model.model)).toEqual(['claude-haiku-4-5-20251001', 'ka-pr-reviewer']);
  });

  it('retries once on a transient failure and succeeds', async () => {
    const fake = installFakeProvider(q, 'anthropic', [new ProviderError('scaling', 503), 'OK']);
    const result = await invokeModel('planning', REQ, { flow: 'ticket-refine' }, 0);
    expect(fake.calls).toHaveLength(2);
    expect(result.text).toBe('OK');
    expect(llmFlowStatuses()['ticket-refine'].failures).toBe(0);
  });

  it('retries thrown (network) errors', async () => {
    const fake = installFakeProvider(q, 'anthropic', [new Error('socket hang up'), 'OK']);
    await expect(invokeModel('draft', REQ, { flow: 'status-draft' }, 0)).resolves.toMatchObject({ text: 'OK' });
    expect(fake.calls).toHaveLength(2);
  });

  it('does not retry auth errors and throws a categorized error', async () => {
    const fake = installFakeProvider(q, 'anthropic', [new ProviderError('invalid token', 401), 'never']);
    await expect(invokeModel('estimate', REQ, {}, 0)).rejects.toThrow(/auth.*invalid token.*HTTP 401/);
    expect(fake.calls).toHaveLength(1);
    const s = llmFlowStatuses().estimate;
    expect(s.failures).toBe(1);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastErrorCategory).toBe('auth');
  });

  it('gives up after the retry and surfaces a feed item on the engagement', async () => {
    installFakeProvider(q, 'anthropic', [new ProviderError('no capacity', 503), new ProviderError('no capacity', 503)]);
    await expect(invokeModel('planning', REQ, { flow: 'comment-rework', engagementId: 'exec', ticketKey: 'DAT-1' }, 0)).rejects.toThrow(/server.*no capacity/);
    const items = await feedItems(q);
    expect(items).toHaveLength(1);
    expect(items[0].engagement_id).toBe('exec');
    expect(String(items[0].text)).toContain('DAT-1');
    expect(String(items[0].text)).toContain('server error');
  });

  it('throttles repeated failure feed items but keeps counting failures', async () => {
    installFakeProvider(q, 'anthropic', Array.from({ length: 6 }, () => new ProviderError('boom', 500)));
    for (let i = 0; i < 3; i++) {
      await expect(invokeModel('estimate', REQ, { engagementId: 'exec' }, 0)).rejects.toThrow();
    }
    expect(await feedItems(q)).toHaveLength(1);
    const s = llmFlowStatuses().estimate;
    expect(s.failures).toBe(3);
    expect(s.consecutiveFailures).toBe(3);
  });

  it('a feed-write failure never masks the model failure', async () => {
    installFakeProvider(q, 'anthropic', [new ProviderError('no capacity', 503), new ProviderError('no capacity', 503)]);
    await q('DROP TABLE app.feed_items');
    await expect(invokeModel('estimate', REQ, { engagementId: 'exec' }, 0)).rejects.toThrow(/no capacity/);
  });

  it('success after failures resets the consecutive counter only', async () => {
    installFakeProvider(q, 'anthropic', [new ProviderError('bad payload', 400), 'OK']);
    await expect(invokeModel('estimate', REQ, {}, 0)).rejects.toThrow();
    await invokeModel('estimate', REQ, {}, 0);
    const s = llmFlowStatuses().estimate;
    expect(s.failures).toBe(1);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastSuccessAt).not.toBeNull();
  });

  it('an unmapped role is not an outage: no call, no feed item, no failure counted', async () => {
    const fake = installFakeProvider(q, 'anthropic', ['never']);
    await q(`DELETE FROM app.model_roles WHERE role = 'planning'`);
    await expect(invokeModel('planning', REQ, { flow: 'ticket-refine', engagementId: 'exec', ticketKey: 'DAT-1' }, 0)).rejects.toThrow(
      /skipped.*no model configured.*planning role.*fallback applies/,
    );
    expect(fake.calls).toHaveLength(0);
    expect(await feedItems(q)).toHaveLength(0);
    expect(llmFlowStatuses()['ticket-refine']).toBeUndefined();
  });

  it('a stub adapter (bedrock, vertex) is skipped the same way', async () => {
    installFakeProvider(q, 'anthropic', [new ProviderNotAvailableError('bedrock', 'not wired')]);
    await expect(invokeModel('estimate', REQ, {}, 0)).rejects.toThrow(/skipped.*not configured in this build/);
    expect(llmFlowStatuses().estimate).toMatchObject({ calls: 0, failures: 0 });
  });

  it('refuses a model that cannot meet the role contract, naming the gap, without calling it', async () => {
    const fake = installFakeProvider(q, 'anthropic', ['never'], { json: false, contextTokens: 8_000 });
    await expect(invokeModel('planning', { ...REQ, json: true }, { flow: 'sow-parse', engagementId: 'exec' }, 0)).rejects.toThrow(
      /refused.*Anthropic \/ claude-sonnet-5 cannot serve the planning role: it lacks JSON output, a 100k context window \(has 8k\)/,
    );
    expect(fake.calls).toHaveLength(0);
    expect(llmFlowStatuses()['sow-parse']).toMatchObject({ failures: 1, lastErrorCategory: 'payload' });
    expect(await feedItems(q)).toHaveLength(1);
  });

  it('only demands tools of a model when the request carries tools', async () => {
    const fake = installFakeProvider(q, 'anthropic', ['OK', 'never'], { tools: false });
    await expect(invokeModel('planning', { ...REQ, json: true }, {}, 0)).resolves.toMatchObject({ text: 'OK' });
    await expect(invokeModel('planning', { ...REQ, tools: [{ name: 't', description: 'd', parameters: {} }] }, {}, 0)).rejects.toThrow(/lacks tool use/);
    expect(fake.calls).toHaveLength(1);
  });

  it('auto-registers an Anthropic provider from ANTHROPIC_API_KEY for a workspace with none', async () => {
    const fresh = await memDbWithModels(SUPPORT_SQL);
    const fake = installFakeProvider(fresh, 'anthropic', ['OK']);
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      await expect(invokeModel('estimate', REQ, {}, 0)).resolves.toMatchObject({ text: 'OK' });
      const providers = (await fresh('SELECT name, kind, credential_ref, default_model FROM app.model_providers')).rows;
      expect(providers).toEqual([{ name: 'Anthropic', kind: 'anthropic', credential_ref: 'ANTHROPIC_API_KEY', default_model: 'claude-sonnet-5' }]);
      const roles = (await fresh('SELECT role, model FROM app.model_roles ORDER BY role')).rows;
      expect(roles).toEqual([
        { role: 'draft', model: 'claude-haiku-4-5-20251001' },
        { role: 'estimate', model: 'claude-haiku-4-5-20251001' },
        { role: 'planning', model: 'claude-sonnet-5' },
        { role: 'review', model: 'claude-sonnet-5' },
      ]);
      // The key itself was resolved by name for the call, never stored.
      expect(fake.calls[0].model.credential).toBe('sk-test');
      expect(JSON.stringify(providers)).not.toContain('sk-test');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('rolesHealth', () => {
  let q: Query;
  beforeEach(async () => {
    resetLlmHealthState();
    q = await memDbWithModels(SUPPORT_SQL);
  });
  afterEach(resetLlm);

  it('reports every role, probing the configured ones and naming the unconfigured', async () => {
    await seedProvider(q, { name: 'Anthropic', kind: 'anthropic', model: 'claude-sonnet-5', roles: ['planning', 'review'] });
    installFakeProvider(q, 'anthropic', ['OK', new ProviderError('down', 503), new ProviderError('down', 503)]);
    const health = await rolesHealth(q, 't');
    expect(health.planning).toMatchObject({ configured: true, provider: { name: 'Anthropic', kind: 'anthropic' }, model: 'claude-sonnet-5', probe: { ok: true, cached: false } });
    expect(health.review).toMatchObject({ configured: true, probe: { ok: false } });
    expect(health.review.probe?.error).toMatch(/down/);
    expect(health.estimate).toMatchObject({ configured: false, provider: null, probe: null });
    expect(health.draft.contract).toEqual({ json: false, tools: false, contextTokens: 16_000 });
    // Probes are cached per role for a while.
    expect((await rolesHealth(q, 't')).planning.probe?.cached).toBe(true);
    // A probe is not a flow: it never counts as a call against the role's main flow.
    expect(llmFlowStatuses()['pr-review']).toBeUndefined();
  });
});
