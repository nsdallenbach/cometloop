import { beforeEach, describe, expect, it } from 'vitest';
import {
  FeedThrottle,
  ModelNotConfiguredError,
  categorizeFailure,
  invokeError,
  invokeModel,
  isTransientStatus,
  llmFlowStatuses,
  resetLlmHealthState,
} from './llm-health';

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
    expect(invokeError({ ok: false, status: 503, message: 'endpoint scaling' })).toEqual({
      message: 'endpoint scaling',
      status: 503,
    });
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

describe('invokeModel', () => {
  beforeEach(() => resetLlmHealthState());

  const okResponse = { ok: true, data: { choices: [{ message: { content: 'OK' } }] } };
  const servingOf = (impl: () => Promise<unknown>) => () => ({ invoke: impl });

  it('returns the raw response and records the success', async () => {
    const result = await invokeModel(servingOf(() => Promise.resolve(okResponse)), null, 'estimate', {}, {}, 0);
    expect(result).toBe(okResponse);
    const s = llmFlowStatuses().estimate;
    expect(s.calls).toBe(1);
    expect(s.failures).toBe(0);
    expect(s.lastSuccessAt).not.toBeNull();
  });

  it('retries once on a transient failure and succeeds', async () => {
    let attempts = 0;
    const serving = servingOf(() => {
      attempts++;
      return Promise.resolve(attempts === 1 ? { ok: false, status: 503, message: 'scaling' } : okResponse);
    });
    const result = await invokeModel(serving, null, 'ticket-refine', {}, {}, 0);
    expect(attempts).toBe(2);
    expect(result).toBe(okResponse);
    expect(llmFlowStatuses()['ticket-refine'].failures).toBe(0);
  });

  it('retries thrown (network) errors', async () => {
    let attempts = 0;
    const serving = servingOf(() => {
      attempts++;
      return attempts === 1 ? Promise.reject(new Error('socket hang up')) : Promise.resolve(okResponse);
    });
    await expect(invokeModel(serving, null, 'status-draft', {}, {}, 0)).resolves.toBe(okResponse);
    expect(attempts).toBe(2);
  });

  it('does not retry auth errors and throws a categorized error', async () => {
    let attempts = 0;
    const serving = servingOf(() => {
      attempts++;
      return Promise.resolve({ ok: false, status: 401, message: 'invalid token' });
    });
    await expect(invokeModel(serving, null, 'estimate', {}, {}, 0)).rejects.toThrow(/auth.*invalid token.*HTTP 401/);
    expect(attempts).toBe(1);
    const s = llmFlowStatuses().estimate;
    expect(s.failures).toBe(1);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.lastErrorCategory).toBe('auth');
  });

  it('gives up after the retry and surfaces a feed item on the engagement', async () => {
    const inserts: { text: string; params: unknown[] }[] = [];
    const q = (text: string, params?: unknown[]) => {
      inserts.push({ text, params: params ?? [] });
      return Promise.resolve({ rows: [] });
    };
    const serving = servingOf(() => Promise.resolve({ ok: false, status: 503, message: 'no capacity' }));
    await expect(
      invokeModel(serving, q, 'comment-rework', {}, { engagementId: 'exec', ticketKey: 'DAT-1' }, 0),
    ).rejects.toThrow(/server.*no capacity/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].text).toContain('feed_items');
    expect(inserts[0].params[0]).toBe('exec');
    expect(inserts[0].params[1]).toContain('DAT-1');
    expect(inserts[0].params[1]).toContain('server error');
  });

  it('throttles repeated failure feed items but keeps counting failures', async () => {
    let inserts = 0;
    const q = () => {
      inserts++;
      return Promise.resolve({ rows: [] });
    };
    const serving = servingOf(() => Promise.resolve({ ok: false, status: 500, message: 'boom' }));
    for (let i = 0; i < 3; i++) {
      await expect(invokeModel(serving, q, 'estimate', {}, { engagementId: 'exec' }, 0)).rejects.toThrow();
    }
    expect(inserts).toBe(1);
    const s = llmFlowStatuses().estimate;
    expect(s.failures).toBe(3);
    expect(s.consecutiveFailures).toBe(3);
  });

  it('a feed-write failure never masks the model failure', async () => {
    const q = () => Promise.reject(new Error('db down'));
    const serving = servingOf(() => Promise.resolve({ ok: false, status: 503, message: 'no capacity' }));
    await expect(invokeModel(serving, q, 'estimate', {}, { engagementId: 'exec' }, 0)).rejects.toThrow(/no capacity/);
  });

  it('success after failures resets the consecutive counter only', async () => {
    const bad = servingOf(() => Promise.resolve({ ok: false, status: 400, message: 'bad payload' }));
    await expect(invokeModel(bad, null, 'estimate', {}, {}, 0)).rejects.toThrow();
    await invokeModel(servingOf(() => Promise.resolve(okResponse)), null, 'estimate', {}, {}, 0);
    const s = llmFlowStatuses().estimate;
    expect(s.failures).toBe(1);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastSuccessAt).not.toBeNull();
  });

  it('an unconfigured model is not an outage: no retry, no feed item, no failure counted', async () => {
    let attempts = 0;
    let inserts = 0;
    const q = () => {
      inserts++;
      return Promise.resolve({ rows: [] });
    };
    const serving = servingOf(() => {
      attempts++;
      return Promise.reject(new ModelNotConfiguredError('no provider set'));
    });
    await expect(
      invokeModel(serving, q, 'ticket-refine', {}, { engagementId: 'exec', ticketKey: 'DAT-1' }, 0),
    ).rejects.toThrow(/skipped.*no model configured.*fallback applies/);
    expect(attempts).toBe(1);
    expect(inserts).toBe(0);
    expect(llmFlowStatuses()['ticket-refine']).toMatchObject({ calls: 0, failures: 0, consecutiveFailures: 0 });
  });
});
