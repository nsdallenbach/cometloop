import { gatewayHeaders, gatewayUrl, trimSlash } from '../gateway';
import {
  ProviderError,
  errorBody,
  jsonBody,
  providerFetch,
  usageFromAnthropic,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderCapabilities,
  type ResolvedModel,
  type ToolCall,
} from '../provider';

/**
 * Anthropic Messages API (`POST /v1/messages`, `x-api-key`). No streaming —
 * every control-plane call wants the whole reply to parse.
 *
 * JSON-shaped output is asked for through the system prompt (the caller's
 * prompt already says "reply with ONLY a JSON object"; this adds the same
 * instruction at system level, which Claude honours reliably) — no prefill,
 * so `{`-less replies still parse through the callers' first-brace regex.
 *
 * Tools map 1:1 onto Anthropic's `tools` / `tool_use` / `tool_result`
 * blocks; the provider-neutral messages carry OpenAI-style tool turns, so
 * consecutive tool results fold into one user turn as the API requires.
 */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 120_000;

/** Context windows by model family; unknown claude models get the adapter default. */
const CONTEXT: [RegExp, number][] = [
  [/claude-(fable|opus|sonnet)-5/, 1_000_000],
  [/claude-haiku-4-5/, 200_000],
  [/claude-/, 200_000],
];

const JSON_SYSTEM = 'Reply with a single JSON object and nothing else: no prose before or after it, no markdown code fence.';

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface WireMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

/** Provider-neutral history → Anthropic turns (tool results fold into a user turn; empty turns dropped). */
export function toAnthropicMessages(messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: WireMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }]);
      continue;
    }
    const blocks: Block[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    if (m.role === 'assistant') {
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
    }
    push(m.role, blocks);
  }
  return out;
}

function parseBlocks(content: unknown): { text: string; toolCalls: ToolCall[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(content)) {
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        toolCalls.push({
          id: typeof b.id === 'string' ? b.id : '',
          name: b.name,
          arguments: b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : {},
        });
      }
    }
  }
  return { text: texts.join(''), toolCalls };
}

export const anthropicProvider: ModelProvider = {
  kind: 'anthropic',
  capabilities: { json: true, tools: true, contextTokens: 200_000 },

  capabilitiesFor(m: ResolvedModel): ProviderCapabilities {
    const override = m.provider.extra.contextTokens;
    const known = CONTEXT.find(([re]) => re.test(m.model))?.[1];
    return { ...this.capabilities, contextTokens: typeof override === 'number' && override > 0 ? override : (known ?? this.capabilities.contextTokens) };
  },

  async chat(request: ChatRequest, m: ResolvedModel, signal?: AbortSignal): Promise<ChatResponse> {
    if (!m.credential) throw new ProviderError('anthropic: no API key — credential_ref resolved to nothing', 401, 'anthropic');
    const url = gatewayUrl(m, `${trimSlash(m.provider.baseUrl || ANTHROPIC_BASE_URL)}/v1/messages`);
    const system = [request.system, request.json ? JSON_SYSTEM : ''].filter(Boolean).join('\n\n');
    const body: Record<string, unknown> = {
      model: m.model,
      max_tokens: request.maxTokens,
      messages: toAnthropicMessages(request.messages),
      ...(system ? { system } : {}),
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(request.tools?.length
        ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
        : {}),
    };
    const resp = await providerFetch('anthropic', url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': m.credential,
        'anthropic-version': API_VERSION,
        ...gatewayHeaders(m, url),
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) throw new ProviderError(`anthropic: ${await errorBody(resp)}`, resp.status, 'anthropic');
    const data = await jsonBody('anthropic', resp);
    const { text, toolCalls } = parseBlocks(data.content);
    return {
      text,
      toolCalls,
      usage: usageFromAnthropic(data.usage),
      model: typeof data.model === 'string' && data.model ? data.model : m.model,
      provider: 'anthropic',
    };
  },
};
