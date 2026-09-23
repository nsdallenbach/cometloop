import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type express from 'express';
import type { Caller } from './roles';
import { setupModelSettingsRoutes } from './model-settings';
import { installFakeProvider, memDbWithModels, resetLlm, type Query } from '../llm/test-support';
import { DEFAULT_MODEL_PRICES } from '../llm/pricing';

/**
 * The workspace model-settings API against pg-mem: admin gate, provider CRUD
 * with the credential kept as a name, the capability contract on the role
 * map, the test button through a fake adapter, and the model price table
 * (published defaults, per-workspace overrides, reset).
 */

type Handler = (req: express.Request, res: express.Response) => Promise<void> | void;

function captureRoutes(q: Query, requireAdmin: (req: express.Request, res: express.Response) => Promise<Caller | null>) {
  const routes = new Map<string, Handler>();
  const app = {
    get: (path: string, h: Handler) => routes.set(`GET ${path}`, h),
    post: (path: string, h: Handler) => routes.set(`POST ${path}`, h),
    put: (path: string, h: Handler) => routes.set(`PUT ${path}`, h),
    delete: (path: string, h: Handler) => routes.set(`DELETE ${path}`, h),
  } as unknown as express.Application;
  setupModelSettingsRoutes(app, q, requireAdmin);
  return routes;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const call = async (routes: Map<string, Handler>, method: string, path: string, params: Record<string, string> = {}, body?: unknown) => {
  const res = fakeRes();
  await routes.get(`${method} ${path}`)?.({ params, body, query: {} } as unknown as express.Request, res as unknown as express.Response);
  return res as { statusCode: number; body: Record<string, unknown> & { providers?: Record<string, unknown>[]; roles?: Record<string, unknown>[] } };
};

const admin = (): Promise<Caller | null> => Promise.resolve({ email: 'admin@example.com', role: 'admin' });
const developer = (_req: express.Request, res: express.Response): Promise<Caller | null> => {
  res.status(403).json({ error: 'Admin access required' });
  return Promise.resolve(null);
};

const ANTHROPIC = { name: 'Anthropic', kind: 'anthropic', credentialRef: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-5' };

let q: Query;
let routes: Map<string, Handler>;

beforeEach(async () => {
  q = await memDbWithModels();
  routes = captureRoutes(q, admin);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetLlm();
});

describe('providers', () => {
  it('is admin-only', async () => {
    const devRoutes = captureRoutes(q, developer);
    expect((await call(devRoutes, 'GET', '/api/settings/providers')).statusCode).toBe(403);
    expect((await call(devRoutes, 'POST', '/api/settings/providers', {}, ANTHROPIC)).statusCode).toBe(403);
    expect((await call(devRoutes, 'PUT', '/api/settings/model-roles', {}, { roles: [] })).statusCode).toBe(403);
  });

  it('creates, lists, updates and deletes a provider, reporting the credential by name and status only', async () => {
    const created = await call(routes, 'POST', '/api/settings/providers', {}, { ...ANTHROPIC, extra: { preset: 'anthropic', apiKey: 'sk-should-not-land' } });
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ name: 'Anthropic', kind: 'anthropic', live: true, credentialRef: 'ANTHROPIC_API_KEY', credential: 'env', roles: [] });
    expect(JSON.stringify(created.body)).not.toContain('sk-');
    expect(created.body.extra).toEqual({ preset: 'anthropic' });
    const id = String(created.body.id);

    const list = await call(routes, 'GET', '/api/settings/providers');
    expect(list.body.providers).toHaveLength(1);
    expect(list.body.kinds).toContainEqual({ kind: 'bedrock', live: false });

    const updated = await call(routes, 'PUT', '/api/settings/providers/:id', { id }, { ...ANTHROPIC, name: 'Anthropic (prod)', credentialRef: 'MISSING_REF' });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).toMatchObject({ name: 'Anthropic (prod)', credential: 'missing' });

    const gone = await call(routes, 'DELETE', '/api/settings/providers/:id', { id });
    expect(gone.body).toEqual({ ok: true, remaining: 0 });
    expect((await call(routes, 'DELETE', '/api/settings/providers/:id', { id })).statusCode).toBe(404);
  });

  it('rejects a credential value pasted where the name goes, and a non-URL base', async () => {
    const bad = await call(routes, 'POST', '/api/settings/providers', {}, { ...ANTHROPIC, credentialRef: 'sk-ant-api03 secret value' });
    expect(bad.statusCode).toBe(400);
    expect(String(bad.body.error)).toContain('NAME of the secret');
    const badUrl = await call(routes, 'POST', '/api/settings/providers', {}, { ...ANTHROPIC, kind: 'openai-compatible', baseUrl: 'not a url' });
    expect(badUrl.statusCode).toBe(400);
  });

  it('tests an unsaved provider without writing it', async () => {
    installFakeProvider(q, 'anthropic', [{ text: 'OK', model: 'claude-sonnet-5' }]);
    const res = await call(routes, 'POST', '/api/settings/providers/test', {}, ANTHROPIC);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, model: 'claude-sonnet-5', provider: 'anthropic' });
    expect((await q('SELECT * FROM app.model_providers')).rows).toHaveLength(0);
  });

  it('tests a provider with one tiny call and reports latency and the answering model', async () => {
    const fake = installFakeProvider(q, 'anthropic', [{ text: 'OK', model: 'claude-sonnet-5-20260101' }, new Error('nope')]);
    const id = String((await call(routes, 'POST', '/api/settings/providers', {}, ANTHROPIC)).body.id);
    const ok = await call(routes, 'POST', '/api/settings/providers/:id/test', { id }, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, model: 'claude-sonnet-5-20260101', provider: 'anthropic', requestedModel: 'claude-sonnet-5', error: null });
    expect(typeof ok.body.latencyMs).toBe('number');
    expect(fake.calls[0].request.maxTokens).toBeLessThanOrEqual(16);
    expect(fake.calls[0].model.credential).toBe('sk-test');
    const failed = await call(routes, 'POST', '/api/settings/providers/:id/test', { id }, { model: 'claude-haiku-4-5' });
    expect(failed.statusCode).toBe(502);
    expect(failed.body).toMatchObject({ ok: false, requestedModel: 'claude-haiku-4-5' });
    expect(String(failed.body.error)).toContain('nope');
  });
});

describe('model roles', () => {
  it('lists every role with its contract even before anything is mapped', async () => {
    const res = await call(routes, 'GET', '/api/settings/model-roles');
    expect(res.body.roles?.map((r) => r.role)).toEqual(['planning', 'estimate', 'review', 'draft']);
    expect(res.body.roles?.[0]).toMatchObject({ label: 'Planning', contract: { json: true, tools: true, contextTokens: 100_000 }, providerId: null, model: '', gap: null });
  });

  it('maps roles to a provider and model, falling back to the provider default model', async () => {
    const id = Number((await call(routes, 'POST', '/api/settings/providers', {}, ANTHROPIC)).body.id);
    const res = await call(routes, 'PUT', '/api/settings/model-roles', {}, {
      roles: [
        { role: 'planning', providerId: id, model: '' },
        { role: 'estimate', providerId: id, model: 'claude-haiku-4-5-20251001' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const byRole: Record<string, Record<string, unknown>> = Object.fromEntries((res.body.roles ?? []).map((r) => [String(r.role), r]));
    expect(byRole.planning).toMatchObject({ providerId: id, model: 'claude-sonnet-5', gap: null });
    expect(byRole.estimate).toMatchObject({ providerId: id, model: 'claude-haiku-4-5-20251001' });
    expect(byRole.review).toMatchObject({ providerId: null });
    // Re-mapping upserts; unmapping deletes.
    await call(routes, 'PUT', '/api/settings/model-roles', {}, { roles: [{ role: 'planning', providerId: id, model: 'claude-opus-5' }, { role: 'estimate', providerId: null }] });
    const rows = (await q('SELECT role, model FROM app.model_roles ORDER BY role')).rows;
    expect(rows).toEqual([{ role: 'planning', model: 'claude-opus-5' }]);
    // The provider list shows which roles it serves.
    const list = await call(routes, 'GET', '/api/settings/providers');
    expect(list.body.providers?.[0].roles).toEqual([{ role: 'planning', model: 'claude-opus-5' }]);
  });

  it('refuses a mapping the role contract cannot be met by, naming the gap, and writes nothing', async () => {
    // A self-hosted model the admin declared as 32k context: fine for estimates, not for reviews.
    const id = Number(
      (await call(routes, 'POST', '/api/settings/providers', {}, { name: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3', extra: { contextTokens: 32_000 } })).body.id,
    );
    const res = await call(routes, 'PUT', '/api/settings/model-roles', {}, { roles: [{ role: 'estimate', providerId: id }, { role: 'review', providerId: id }] });
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ role: 'review' });
    expect(String(res.body.error)).toMatch(/Ollama \/ llama3 cannot serve the review role: it lacks a 100k context window \(has 32k\)/);
    expect((await q('SELECT * FROM app.model_roles')).rows).toHaveLength(0);
    // Unknown provider → 404, nothing written.
    expect((await call(routes, 'PUT', '/api/settings/model-roles', {}, { roles: [{ role: 'draft', providerId: 999 }] })).statusCode).toBe(404);
  });

  it('deleting a provider drops the roles that pointed at it', async () => {
    const id = Number((await call(routes, 'POST', '/api/settings/providers', {}, ANTHROPIC)).body.id);
    await call(routes, 'PUT', '/api/settings/model-roles', {}, { roles: [{ role: 'draft', providerId: id }] });
    await call(routes, 'DELETE', '/api/settings/providers/:id', { id: String(id) });
    expect((await q('SELECT * FROM app.model_roles')).rows).toHaveLength(0);
  });
});

describe('model prices', () => {
  const put = (model: string, body: unknown) => call(routes, 'PUT', '/api/settings/model-prices/:model', { model }, body);
  const reset = (model: string) => call(routes, 'DELETE', '/api/settings/model-prices/:model', { model });
  const list = async () => (await call(routes, 'GET', '/api/settings/model-prices')).body.prices as Record<string, unknown>[];

  it('is admin-only', async () => {
    const devRoutes = captureRoutes(q, developer);
    expect((await call(devRoutes, 'GET', '/api/settings/model-prices')).statusCode).toBe(403);
    expect((await call(devRoutes, 'PUT', '/api/settings/model-prices/:model', { model: 'claude-sonnet-5' }, { inputPerM: 1, outputPerM: 2 })).statusCode).toBe(403);
    expect((await call(devRoutes, 'DELETE', '/api/settings/model-prices/:model', { model: 'claude-sonnet-5' })).statusCode).toBe(403);
  });

  it('lists the published defaults with their fetched-at date, overrides one model, and resets it', async () => {
    const prices = await list();
    expect(prices.length).toBe(DEFAULT_MODEL_PRICES.length);
    expect(prices.every((p) => p.source === 'default')).toBe(true);
    const sonnet = prices.find((p) => p.model === 'claude-sonnet-5');
    expect(sonnet).toMatchObject({ provider: 'anthropic', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5, updatedBy: null });
    expect(sonnet?.default).toMatchObject({ inputPerM: 2, sourceUrl: 'https://claude.com/pricing', fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string });

    // An override sent under a dated alias lands on the default's own id.
    const saved = await put('claude-sonnet-5-20260401', { inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15 });
    expect(saved.statusCode).toBe(200);
    expect(saved.body.price).toMatchObject({ model: 'claude-sonnet-5', source: 'override', inputPerM: 1.5, outputPerM: 7.5, cacheReadPerM: 0.15, cacheWritePerM: 0, updatedBy: 'admin@example.com' });
    expect((saved.body.price as Record<string, unknown>).default).toMatchObject({ inputPerM: 2, outputPerM: 10 });
    expect((await q('SELECT model, input_per_m, updated_by FROM app.model_prices')).rows).toEqual([{ model: 'claude-sonnet-5', input_per_m: 1.5, updated_by: 'admin@example.com' }]);

    // Saving again updates in place — still one row, still one entry in the table.
    await put('claude-sonnet-5', { inputPerM: 1, outputPerM: 5 });
    expect((await q('SELECT COUNT(*)::int AS n FROM app.model_prices')).rows[0].n).toBe(1);
    const after = await list();
    expect(after.length).toBe(DEFAULT_MODEL_PRICES.length);
    expect(after.filter((p) => p.source === 'override').map((p) => [p.model, p.inputPerM])).toEqual([['claude-sonnet-5', 1]]);

    // Reset: the published default is back.
    const back = await reset('claude-sonnet-5');
    expect(back.statusCode).toBe(200);
    expect(back.body.removed).toBe(1);
    expect(back.body.price).toMatchObject({ model: 'claude-sonnet-5', source: 'default', inputPerM: 2, updatedBy: null });
    expect((await q('SELECT COUNT(*)::int AS n FROM app.model_prices')).rows[0].n).toBe(0);
  });

  it('prices a model with no default, removes it on reset, and refuses bad input', async () => {
    const saved = await put('my-endpoint', { inputPerM: 3, outputPerM: 9 });
    expect(saved.body.price).toMatchObject({ model: 'my-endpoint', source: 'override', provider: null, default: null, cacheReadPerM: 0, cacheWritePerM: 0 });
    expect((await list()).length).toBe(DEFAULT_MODEL_PRICES.length + 1);
    expect((await reset('my-endpoint')).body).toEqual({ price: null, removed: 1 });
    expect((await list()).length).toBe(DEFAULT_MODEL_PRICES.length);

    expect((await put('my-endpoint', { inputPerM: -1, outputPerM: 9 })).statusCode).toBe(400);
    expect((await put('my-endpoint', { outputPerM: 9 })).statusCode).toBe(400);
    expect((await put('bad model!', { inputPerM: 1, outputPerM: 9 })).statusCode).toBe(400);
    expect((await q('SELECT COUNT(*)::int AS n FROM app.model_prices')).rows[0].n).toBe(0);
  });
});
