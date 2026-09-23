import { gatewayAzureUrl, gatewayHeaders, gatewayUrl, trimSlash } from '../gateway';
import {
  ProviderError,
  errorBody,
  jsonBody,
  providerFetch,
  usageFromOpenAi,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderCapabilities,
  type ResolvedModel,
  type ToolCall,
} from '../provider';

/**
 * Chat Completions (`POST <base>/chat/completions`) — the wire format
 * OpenAI, Azure OpenAI, Neon AI Gateway, Groq, Together, vLLM and Ollama all
 * speak. One adapter, three URL shapes:
 *
 *  - plain: `${baseUrl}/chat/completions`, `Authorization: Bearer <key>`
 *    (`baseUrl` defaults to `https://api.openai.com/v1`).
 *  - Azure OpenAI (`extra.apiVersion` set): `baseUrl` is the resource
 *    (`https://<resource>.openai.azure.com`), the model is the deployment,
 *    the key goes in `api-key`, and the URL is
 *    `${baseUrl}/openai/deployments/<deployment>/chat/completions?api-version=…`.
 *  - through Cloudflare AI Gateway when the host has a native route (see
 *    gateway.ts); a self-hosted endpoint stays direct.
 *
 * JSON output uses `response_format: { type: 'json_object' }`; a server that
 * rejects it (older vLLM, some proxies) is retried once without, since the
 * prompt already asks for JSON.
 */

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const TIMEOUT_MS = 120_000;

const CONTEXT: [RegExp, number][] = [
  [/^gpt-5|^o[1-9]/, 400_000],
  [/^gpt-4\.1/, 1_000_000],
  [/^gpt-4o/, 128_000],
  [/llama-?3|llama-?4|mixtral|qwen/i, 128_000],
];

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAiMessages(request: ChatRequest): WireMessage[] {
  const out: WireMessage[] = [];
  if (request.system) out.push({ role: 'system', content: request.system });
  for (const m of request.messages) out.push(toWire(m));
  return out;
}

function toWire(m: ChatMessage): WireMessage {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
  if (m.role === 'assistant') {
    const calls = (m.toolCalls ?? []).map<WireToolCall>((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }));
    return { role: 'assistant', content: m.content || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) };
  }
  return { role: 'user', content: m.content };
}

/** `choices[0].message` → text + tool calls, tolerant of typed-part content arrays. */
export function parseChoice(data: Record<string, unknown>): { text: string; toolCalls: ToolCall[] } {
  const choices = data.choices;
  const first = Array.isArray(choices) ? (choices[0] as { message?: unknown } | undefined) : undefined;
  const message = first?.message && typeof first.message === 'object' ? (first.message as Record<string, unknown>) : null;
  let text = '';
  const content = message?.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((c: unknown) => {
        const part = c as { type?: unknown; text?: unknown };
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  const toolCalls: ToolCall[] = [];
  const raw = message?.tool_calls;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const tc = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = typeof tc.function?.name === 'string' ? tc.function.name : '';
      if (!name) continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(typeof tc.function?.arguments === 'string' && tc.function.arguments ? tc.function.arguments : '{}');
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch {
        /* malformed arguments — the tool gets none and reports it */
      }
      toolCalls.push({ id: typeof tc.id === 'string' ? tc.id : '', name, arguments: args });
    }
  }
  return { text, toolCalls };
}

/** URL + auth header for the row: Azure when `extra.apiVersion` is set, plain otherwise. */
export function openAiEndpoint(m: ResolvedModel): { url: string; headers: Record<string, string> } {
  const apiVersion = m.provider.extra.apiVersion;
  const key = m.credential ?? '';
  if (typeof apiVersion === 'string' && apiVersion) {
    const base = trimSlash(m.provider.baseUrl ?? '');
    const resource = /^https?:\/\/([^.]+)\.openai\.azure\.com/i.exec(base)?.[1] ?? '';
    const viaGateway = resource ? gatewayAzureUrl(m, resource, m.model, apiVersion) : null;
    return {
      url: viaGateway ?? `${base}/openai/deployments/${encodeURIComponent(m.model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`,
      headers: { 'api-key': key },
    };
  }
  return {
    url: gatewayUrl(m, `${trimSlash(m.provider.baseUrl || OPENAI_BASE_URL)}/chat/completions`),
    headers: { Authorization: `Bearer ${key}` },
  };
}

export const openAiCompatibleProvider: ModelProvider = {
  kind: 'openai-compatible',
  capabilities: { json: true, tools: true, contextTokens: 128_000 },

  capabilitiesFor(m: ResolvedModel): ProviderCapabilities {
    const override = m.provider.extra.contextTokens;
    const known = CONTEXT.find(([re]) => re.test(m.model))?.[1];
    return { ...this.capabilities, contextTokens: typeof override === 'number' && override > 0 ? override : (known ?? this.capabilities.contextTokens) };
  },

  async chat(request: ChatRequest, m: ResolvedModel, signal?: AbortSignal): Promise<ChatResponse> {
    // Local servers (Ollama, vLLM) take any bearer; hosted ones need a real key.
    const { url, headers } = openAiEndpoint(m);
    const call = async (withJsonMode: boolean): Promise<Response> => {
      const body: Record<string, unknown> = {
        model: m.model,
        messages: toOpenAiMessages(request),
        max_tokens: request.maxTokens,
        ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
        ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(request.tools?.length
          ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
      };
      return providerFetch('openai-compatible', url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers, ...gatewayHeaders(m, url) },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
    };
    // json_object mode and tools do not combine on every server; tools win
    // (the loop's final turn is still parsed by the caller's brace regex).
    let resp = await call(request.json === true && !request.tools?.length);
    if (!resp.ok && request.json && (resp.status === 400 || resp.status === 422)) {
      const detail = await errorBody(resp);
      if (/response_format|json_object/i.test(detail)) resp = await call(false);
      else throw new ProviderError(`openai-compatible: ${detail}`, resp.status, 'openai-compatible');
    }
    if (!resp.ok) throw new ProviderError(`openai-compatible: ${await errorBody(resp)}`, resp.status, 'openai-compatible');
    const data = await jsonBody('openai-compatible', resp);
    const { text, toolCalls } = parseChoice(data);
    return {
      text,
      toolCalls,
      usage: usageFromOpenAi(data.usage),
      model: typeof data.model === 'string' && data.model ? data.model : m.model,
      provider: 'openai-compatible',
    };
  },
};
