import { newDb } from 'pg-mem';
import { tenancyTestSql } from '../db/tenancy';
import { MODEL_CONFIG_SCHEMA_SQL, MODEL_ROLES, resetTenantDefaults, type ModelRole } from './config';
import { setProviderForTests } from './providers';
import { setLlmQuery } from '../routes/llm-health';
import type { ChatRequest, ChatResponse, ModelProvider, ProviderCapabilities, ProviderKind, ResolvedModel } from './provider';

/**
 * Test scaffolding for the model layer: a pg-mem database with the provider
 * tables, a scripted fake adapter, and the two calls a test needs to point
 * `invokeModel` at them. Vitest-only; nothing in the server imports this.
 */

export type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

/** pg-mem with `app` plus the given support tables, the model tables and the tenancy test subset. */
export async function memDbWithModels(supportSql: readonly string[] = []): Promise<Query> {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  const q: Query = (text, params) => pool.query(text, params);
  await q('CREATE SCHEMA IF NOT EXISTS app');
  const all = [...supportSql.filter((s) => !s.trim().toUpperCase().startsWith('CREATE SCHEMA')), ...MODEL_CONFIG_SCHEMA_SQL];
  for (const sql of all) await q(sql);
  for (const sql of tenancyTestSql(all)) await q(sql);
  return q;
}

/** A provider row plus (optionally) every role mapped to it. Returns the id. */
export async function seedProvider(
  q: Query,
  p: { name?: string; kind?: ProviderKind; model?: string; credentialRef?: string; baseUrl?: string | null; extra?: Record<string, unknown>; roles?: ModelRole[] | 'all' },
): Promise<number> {
  const { rows } = await q(
    `INSERT INTO app.model_providers (name, kind, base_url, credential_ref, default_model, extra) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.name ?? 'Test', p.kind ?? 'anthropic', p.baseUrl ?? null, p.credentialRef ?? 'TEST_KEY', p.model ?? 'test-model', JSON.stringify(p.extra ?? {})],
  );
  const id = Number(rows[0].id);
  const roles = p.roles === 'all' ? [...MODEL_ROLES] : (p.roles ?? []);
  for (const role of roles) await q(`INSERT INTO app.model_roles (role, provider_id, model) VALUES ($1,$2,$3)`, [role, id, p.model ?? 'test-model']);
  return id;
}

export interface FakeCall {
  request: ChatRequest;
  model: ResolvedModel;
}

export type FakeReply = Partial<ChatResponse> | Error | ((request: ChatRequest) => Partial<ChatResponse> | Error);

/**
 * A scripted adapter: replies in order (a string is text; an Error is
 * thrown; a function decides per call) and records every request. Install
 * it under a kind with {@link installFakeProvider}.
 */
export function fakeProvider(kind: ProviderKind, script: (FakeReply | string)[], caps: Partial<ProviderCapabilities> = {}) {
  const calls: FakeCall[] = [];
  const queue = [...script];
  const capabilities: ProviderCapabilities = { json: true, tools: true, contextTokens: 200_000, ...caps };
  const provider: ModelProvider = {
    kind,
    capabilities,
    capabilitiesFor: () => capabilities,
    chat(request, model) {
      calls.push({ request, model });
      const next = queue.shift();
      if (next === undefined) return Promise.reject(new Error('script exhausted'));
      const reply = typeof next === 'function' ? next(request) : typeof next === 'string' ? { text: next } : next;
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({
        text: reply.text ?? '',
        toolCalls: reply.toolCalls ?? [],
        usage: reply.usage ?? { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 },
        model: reply.model ?? model.model,
        provider: kind,
      });
    },
  };
  return { provider, calls, capabilities };
}

/** Point the model layer at a pg-mem query and a fake adapter; call `resetLlm()` in afterEach. */
export function installFakeProvider(q: Query, kind: ProviderKind, script: (FakeReply | string)[], caps: Partial<ProviderCapabilities> = {}) {
  const fake = fakeProvider(kind, script, caps);
  setProviderForTests(kind, fake.provider);
  setLlmQuery(q);
  resetTenantDefaults();
  return fake;
}

export function resetLlm(): void {
  for (const kind of ['anthropic', 'openai-compatible', 'databricks', 'bedrock', 'vertex'] as const) setProviderForTests(kind, null);
  setLlmQuery(null);
  resetTenantDefaults();
}

/** A mocked global fetch that answers with one JSON body (or a status) and records the request. */
export function mockFetch(reply: { status?: number; body?: unknown; text?: string } | ((url: string, init: RequestInit) => { status?: number; body?: unknown; text?: string })) {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = (url: string, init: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    const status = r.status ?? 200;
    const text = r.text ?? JSON.stringify(r.body ?? {});
    return Promise.resolve(new Response(text, { status, headers: { 'content-type': 'application/json' } }));
  };
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return {
    requests,
    body: (i = 0): Record<string, unknown> => {
      const raw = requests[i]?.init.body;
      return JSON.parse(typeof raw === 'string' ? raw : '{}') as Record<string, unknown>;
    },
    headers: (i = 0): Record<string, string> => ({ ...((requests[i]?.init.headers ?? {}) as Record<string, string>) }),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * For tests with a hand-rolled query stub: answer the role-resolution reads
 * (and swallow the usage write) so `invokeModel` reaches the fake adapter,
 * and pass everything else through.
 */
export function withFakeRoles(q: Query, opts: { kind?: ProviderKind; model?: string } = {}): Query {
  const model = opts.model ?? 'test-model';
  return (text, params) => {
    if (text.includes('FROM app.model_roles r JOIN app.model_providers p')) {
      return Promise.resolve({
        rows: [{ id: 1, name: 'Fake', kind: opts.kind ?? 'anthropic', base_url: null, credential_ref: 'TEST_KEY', default_model: model, extra: {}, role_model: model }],
      });
    }
    if (text.includes('COUNT(*)::int AS n FROM app.model_providers')) return Promise.resolve({ rows: [{ n: 1 }] });
    if (text.includes('INSERT INTO app.run_token_usage')) return Promise.resolve({ rows: [] });
    return q(text, params);
  };
}
