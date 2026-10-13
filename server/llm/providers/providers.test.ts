import { afterEach, describe, expect, it } from 'vitest';
import { anthropicProvider, toAnthropicMessages } from './anthropic';
import { openAiCompatibleProvider, openAiEndpoint, parseChoice } from './openai-compatible';
import { databricksProvider, extractServingText, resetDatabricksCaches } from './databricks';
import { vertexProvider } from './vertex';
import { gatewayHeaders, gatewayUrl } from '../gateway';
import { ProviderError, ProviderNotAvailableError, type ChatRequest, type ProviderConfig, type ResolvedModel } from '../provider';
import { mockFetch } from '../test-support';

/**
 * Adapters against a mocked fetch: the request each vendor sees, the usage
 * they report back, Cloudflare AI Gateway prefixing and error mapping.
 */

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 1,
  name: 'Test',
  kind: 'anthropic',
  baseUrl: null,
  credentialRef: 'KEY',
  defaultModel: 'm',
  extra: {},
  createdAt: null,
  updatedAt: null,
  ...over,
});

const resolved = (over: Partial<ResolvedModel> & { config?: Partial<ProviderConfig> } = {}): ResolvedModel => ({
  provider: config(over.config),
  model: over.model ?? 'claude-sonnet-5',
  credential: over.credential === undefined ? 'sk-secret' : over.credential,
  gatewayBaseUrl: over.gatewayBaseUrl ?? null,
  metadata: over.metadata ?? { tenant: 't_a', role: 'planning', flow: 'ticket-refine' },
});

const REQ: ChatRequest = { messages: [{ role: 'user', content: 'plan it' }], maxTokens: 100, json: true };

let fetchMock: ReturnType<typeof mockFetch> | null = null;
afterEach(() => {
  fetchMock?.restore();
  fetchMock = null;
  resetDatabricksCaches();
});

describe('anthropic adapter', () => {
  it('posts a Messages request with x-api-key, a JSON system instruction and parses text + usage', async () => {
    fetchMock = mockFetch({
      body: {
        model: 'claude-sonnet-5-20260101',
        content: [{ type: 'text', text: '{"title":"x"}' }],
        usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 },
      },
    });
    const out = await anthropicProvider.chat({ ...REQ, system: 'be brief' }, resolved());
    expect(fetchMock.requests[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(fetchMock.headers()).toMatchObject({ 'x-api-key': 'sk-secret', 'anthropic-version': '2023-06-01' });
    expect(fetchMock.headers()['cf-aig-metadata']).toBeUndefined();
    const body = fetchMock.body();
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.max_tokens).toBe(100);
    expect(String(body.system)).toContain('be brief');
    expect(String(body.system)).toContain('single JSON object');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'plan it' }] }]);
    expect(out).toEqual({
      text: '{"title":"x"}',
      toolCalls: [],
      usage: { input: 120, output: 30, cacheRead: 80, cacheCreate: 5 },
      model: 'claude-sonnet-5-20260101',
      provider: 'anthropic',
    });
  });

  it('maps tools to tool_use blocks and folds tool results into one user turn', async () => {
    fetchMock = mockFetch({
      body: { content: [{ type: 'tool_use', id: 'tu_1', name: 'search_tickets', input: { query: 'dark' } }], usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const req: ChatRequest = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'get_ticket', arguments: { key: 'DAT-1' } }] },
        { role: 'tool', toolCallId: 'a', content: '{"ok":true}' },
        { role: 'tool', toolCallId: 'b', content: '{"ok":false}' },
      ],
      maxTokens: 10,
      tools: [{ name: 'search_tickets', description: 'search', parameters: { type: 'object' } }],
    };
    const out = await anthropicProvider.chat(req, resolved());
    const body = fetchMock.body();
    expect(body.tools).toEqual([{ name: 'search_tickets', description: 'search', input_schema: { type: 'object' } }]);
    expect(toAnthropicMessages(req.messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'get_ticket', input: { key: 'DAT-1' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: '{"ok":true}' },
          { type: 'tool_result', tool_use_id: 'b', content: '{"ok":false}' },
        ],
      },
    ]);
    expect(out.toolCalls).toEqual([{ id: 'tu_1', name: 'search_tickets', arguments: { query: 'dark' } }]);
  });

  it('routes through Cloudflare AI Gateway with cf-aig metadata when one is configured, unless the row opts out', async () => {
    fetchMock = mockFetch({ body: { content: [], usage: {} } });
    const m = resolved({ gatewayBaseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw', metadata: { tenant: 't_a', role: 'review' } });
    await anthropicProvider.chat(REQ, m);
    expect(fetchMock.requests[0].url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages');
    expect(fetchMock.headers()['cf-aig-metadata']).toBe('{"tenant":"t_a","role":"review"}');
    expect(fetchMock.headers()['x-api-key']).toBe('sk-secret');

    const direct = resolved({ gatewayBaseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw', config: { extra: { bypassGateway: true } } });
    await anthropicProvider.chat(REQ, direct);
    expect(fetchMock.requests[1].url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('maps HTTP failures to ProviderError with the status and the vendor message', async () => {
    fetchMock = mockFetch({ status: 429, body: { error: { type: 'rate_limit_error', message: 'slow down' } } });
    await expect(anthropicProvider.chat(REQ, resolved())).rejects.toMatchObject({ name: 'ProviderError', status: 429, message: 'anthropic: slow down' });
  });

  it('fails as auth (401) when the credential resolved to nothing, without calling out', async () => {
    fetchMock = mockFetch({ body: {} });
    await expect(anthropicProvider.chat(REQ, resolved({ credential: null }))).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.requests).toHaveLength(0);
  });

  it('knows the context window by model family and honours an extra.contextTokens override', () => {
    expect(anthropicProvider.capabilitiesFor(resolved({ model: 'claude-sonnet-5' })).contextTokens).toBe(1_000_000);
    expect(anthropicProvider.capabilitiesFor(resolved({ model: 'claude-haiku-4-5-20251001' })).contextTokens).toBe(200_000);
    expect(anthropicProvider.capabilitiesFor(resolved({ model: 'claude-haiku-4-5', config: { extra: { contextTokens: 32_000 } } })).contextTokens).toBe(32_000);
  });
});

describe('openai-compatible adapter', () => {
  it('posts chat completions with a bearer key, json_object mode, and parses usage with cached tokens split out', async () => {
    fetchMock = mockFetch({
      body: {
        model: 'gpt-5',
        choices: [{ message: { role: 'assistant', content: '{"hours":1}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
      },
    });
    const out = await openAiCompatibleProvider.chat({ ...REQ, system: 'sys' }, resolved({ model: 'gpt-5', config: { kind: 'openai-compatible' } }));
    expect(fetchMock.requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetchMock.headers().Authorization).toBe('Bearer sk-secret');
    const body = fetchMock.body();
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'plan it' },
    ]);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(out.usage).toEqual({ input: 60, output: 20, cacheRead: 40, cacheCreate: 0 });
    expect(out.model).toBe('gpt-5');
    expect(out.text).toBe('{"hours":1}');
  });

  it('retries once without json_object when the server rejects response_format', async () => {
    let n = 0;
    fetchMock = mockFetch(() => {
      n++;
      return n === 1
        ? { status: 400, body: { error: { message: "'response_format' is not supported" } } }
        : { body: { choices: [{ message: { content: 'ok' } }], usage: {} } };
    });
    const out = await openAiCompatibleProvider.chat(REQ, resolved({ config: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' } }));
    expect(out.text).toBe('ok');
    expect(fetchMock.requests).toHaveLength(2);
    expect(fetchMock.body(1).response_format).toBeUndefined();
    expect(fetchMock.requests[1].url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('speaks Azure OpenAI when extra.apiVersion is set: deployment URL, api-key header, gateway azure route', () => {
    const azure = resolved({
      model: 'gpt-5-deploy',
      config: { kind: 'openai-compatible', baseUrl: 'https://acme.openai.azure.com', extra: { apiVersion: '2025-04-01-preview' } },
    });
    expect(openAiEndpoint(azure)).toEqual({
      url: 'https://acme.openai.azure.com/openai/deployments/gpt-5-deploy/chat/completions?api-version=2025-04-01-preview',
      headers: { 'api-key': 'sk-secret' },
    });
    const viaGateway = { ...azure, gatewayBaseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw' };
    expect(openAiEndpoint(viaGateway).url).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/azure-openai/acme/gpt-5-deploy/chat/completions?api-version=2025-04-01-preview');
  });

  it('parses OpenAI-style tool calls with JSON arguments', () => {
    const { text, toolCalls } = parseChoice({
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'link_tickets', arguments: '{"other_key":"DAT-2"}' } }] } }],
    });
    expect(text).toBe('');
    expect(toolCalls).toEqual([{ id: 'c1', name: 'link_tickets', arguments: { other_key: 'DAT-2' } }]);
  });

  it('maps a thrown fetch (network) error to a status-less ProviderError', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    try {
      const err = await openAiCompatibleProvider.chat(REQ, resolved({ config: { kind: 'openai-compatible' } })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBeUndefined();
      expect((err as Error).message).toContain('ECONNREFUSED');
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('gateway helpers', () => {
  it('rewrites only hosts the gateway has a native route for', () => {
    const m = resolved({ gatewayBaseUrl: 'https://gateway.ai.cloudflare.com/v1/acct/gw' });
    expect(gatewayUrl(m, 'https://api.openai.com/v1/chat/completions')).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/openai/chat/completions');
    expect(gatewayUrl(m, 'https://api.groq.com/openai/v1/chat/completions')).toBe('https://gateway.ai.cloudflare.com/v1/acct/gw/groq/openai/v1/chat/completions');
    expect(gatewayUrl(m, 'https://vllm.internal/v1/chat/completions')).toBe('https://vllm.internal/v1/chat/completions');
    expect(gatewayUrl(resolved(), 'https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('adds cache headers from extra.gateway only on gateway URLs', () => {
    const m = resolved({ config: { extra: { gateway: { cacheTtl: 300, skipCache: false } } } });
    expect(gatewayHeaders(m, 'https://gateway.ai.cloudflare.com/v1/a/b/openai/chat/completions')).toEqual({
      'cf-aig-metadata': JSON.stringify(m.metadata),
      'cf-aig-cache-ttl': '300',
    });
    expect(gatewayHeaders(m, 'https://api.openai.com/v1/chat/completions')).toEqual({});
  });
});

describe('databricks adapter', () => {
  const dbx = () =>
    resolved({
      model: 'ka-pr-reviewer',
      credential: 'sp-secret',
      config: { kind: 'databricks', baseUrl: 'https://adb-123.azuredatabricks.net', extra: { clientId: 'sp-id' } },
    });

  it('fetches an SP token, invokes the endpoint by name with the chat body, and parses the reply', async () => {
    fetchMock = mockFetch((url) =>
      url.endsWith('/oidc/v1/token')
        ? { body: { access_token: 'tok' } }
        : { body: { choices: [{ message: { content: '{"verdict":"approve"}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } } },
    );
    const out = await databricksProvider.chat(REQ, dbx());
    expect(fetchMock.requests[0].url).toBe('https://adb-123.azuredatabricks.net/oidc/v1/token');
    expect(fetchMock.headers(0).Authorization).toBe(`Basic ${Buffer.from('sp-id:sp-secret').toString('base64')}`);
    expect(fetchMock.requests[1].url).toBe('https://adb-123.azuredatabricks.net/serving-endpoints/ka-pr-reviewer/invocations');
    expect(fetchMock.headers(1).Authorization).toBe('Bearer tok');
    expect(fetchMock.body(1)).toMatchObject({ messages: [{ role: 'user', content: 'plan it' }], max_tokens: 100 });
    expect(out.text).toBe('{"verdict":"approve"}');
    expect(out.usage).toEqual({ input: 10, output: 2, cacheRead: 0, cacheCreate: 0 });
    expect(out.provider).toBe('databricks');
  });

  it('retries a schema rejection with the responses-style input body (Agent Bricks) and reads output[].content[].text', async () => {
    fetchMock = mockFetch((url, init) => {
      if (url.endsWith('/oidc/v1/token')) return { body: { access_token: 'tok' } };
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      return body.messages ? { status: 422, body: { message: 'unknown field messages' } } : { body: { output: [{ content: [{ text: 'agent says hi' }] }] } };
    });
    const out = await databricksProvider.chat(REQ, dbx());
    expect(fetchMock.requests).toHaveLength(3);
    expect(fetchMock.body(2)).toEqual({ input: [{ role: 'user', content: 'plan it' }] });
    expect(out.text).toBe('agent says hi');
  });

  it('does not retry a non-schema failure and maps the status', async () => {
    fetchMock = mockFetch((url) => (url.endsWith('/oidc/v1/token') ? { body: { access_token: 'tok' } } : { status: 403, body: { message: 'no CAN_QUERY' } }));
    await expect(databricksProvider.chat(REQ, dbx())).rejects.toMatchObject({ status: 403, message: 'databricks: endpoint returned 403: no CAN_QUERY' });
    expect(fetchMock.requests).toHaveLength(2);
  });

  it('refuses to call out without the SP pair', async () => {
    fetchMock = mockFetch({ body: {} });
    await expect(databricksProvider.chat(REQ, resolved({ credential: null, config: { kind: 'databricks', baseUrl: 'https://x' } }))).rejects.toMatchObject({ status: 401 });
    expect(fetchMock.requests).toHaveLength(0);
  });

  it('extracts text from every shape serving endpoints return', () => {
    expect(extractServingText({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
    expect(extractServingText({ output: [{ content: [{ text: 'part one' }, { text: 'part two' }] }] })).toBe('part one\npart two');
    expect(extractServingText({ predictions: ['a', { text: 'b' }] })).toBe('a\nb');
    expect(extractServingText({ content: 'bare' })).toBe('bare');
    expect(extractServingText({ weird: true })).toBe('');
    expect(extractServingText(null)).toBe('');
  });
});

describe('stub adapters', () => {
  it('vertex declares its shape and refuses with a clear error', async () => {
    for (const p of [vertexProvider]) {
      expect(p.capabilities.json).toBe(true);
      const err = await p.chat(REQ, resolved({ config: { kind: p.kind } })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderNotAvailableError);
      expect((err as Error).message).toContain('not configured in this build');
    }
  });
});
