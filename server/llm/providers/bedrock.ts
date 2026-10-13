import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type Tool,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { ProviderError, usageFromAnthropic, type ChatMessage, type ChatRequest, type ChatResponse, type ModelProvider, type ProviderCapabilities, type ResolvedModel, type ToolCall } from '../provider';

/**
 * AWS Bedrock through the Converse API — one request shape for every model
 * Bedrock hosts, Claude included. Model ids are Bedrock's: a foundation
 * model (`anthropic.claude-haiku-4-5-20251001-v1:0`) or, for the Claude
 * models that only serve through inference profiles, the profile id
 * (`us.anthropic.claude-sonnet-5`, `global.anthropic.claude-haiku-4-5-…`).
 *
 * Credentials come from the AWS SDK's default chain — on ECS the task role,
 * locally the `AWS_PROFILE` — so a row needs no secret at all. A row can
 * still pin a key pair (`extra.accessKeyId` + `credential_ref` naming the
 * secret key) for a deployment outside AWS. The Region is `extra.region`,
 * else `AWS_REGION`, else us-east-1; `base_url` overrides the endpoint.
 *
 * JSON-shaped output is asked for at system level, as the Anthropic adapter
 * does — Converse has no response-format switch. Tools map onto Converse's
 * `toolConfig` / `toolUse` / `toolResult` blocks.
 */

/** The SDK's JSON document type (tool inputs and schemas). */
type Doc = NonNullable<ToolUseBlock['input']>;

const TIMEOUT_MS = 120_000;
const JSON_SYSTEM = 'Reply with a single JSON object and nothing else: no prose before or after it, no markdown code fence.';

const CONTEXT: [RegExp, number][] = [
  [/claude-(fable|opus|sonnet)-5/, 1_000_000],
  [/claude-haiku-4-5|claude-sonnet-4|claude-opus-4/, 200_000],
  [/claude/, 200_000],
  [/nova-pro|nova-lite|nova-premier/, 300_000],
  [/llama|mistral|deepseek/i, 128_000],
];

/** Converse client factory; a test swaps it for a scripted one. */
export type ConverseSend = (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;
let sendOverride: ConverseSend | null = null;
const clients = new Map<string, BedrockRuntimeClient>();

export function setBedrockSendForTests(send: ConverseSend | null): void {
  sendOverride = send;
}

function regionOf(m: ResolvedModel): string {
  const r = m.provider.extra.region;
  return (typeof r === 'string' && r.trim()) || process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || 'us-east-1';
}

function clientFor(m: ResolvedModel): BedrockRuntimeClient {
  const region = regionOf(m);
  const accessKeyId = typeof m.provider.extra.accessKeyId === 'string' ? m.provider.extra.accessKeyId.trim() : '';
  const endpoint = m.provider.baseUrl?.trim() || '';
  const key = `${region}|${endpoint}|${accessKeyId}|${m.credential ? 'k' : ''}`;
  let client = clients.get(key);
  if (!client) {
    client = new BedrockRuntimeClient({
      region,
      ...(endpoint ? { endpoint } : {}),
      // A pinned key pair; otherwise the default chain (task role / profile).
      ...(accessKeyId && m.credential ? { credentials: { accessKeyId, secretAccessKey: m.credential } } : {}),
      requestHandler: { requestTimeout: TIMEOUT_MS },
    });
    clients.set(key, client);
  }
  return client;
}

/** Provider-neutral history → Converse turns (tool results fold into a user turn; empty turns dropped). */
export function toConverseMessages(messages: ChatMessage[]): Message[] {
  const out: Message[] = [];
  const push = (role: 'user' | 'assistant', blocks: ContentBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) (last.content as ContentBlock[]).push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      push('user', [{ toolResult: { toolUseId: m.toolCallId ?? '', content: [{ text: m.content }] } }]);
      continue;
    }
    const blocks: ContentBlock[] = [];
    if (m.content) blocks.push({ text: m.content });
    if (m.role === 'assistant') {
      for (const c of m.toolCalls ?? []) blocks.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.arguments as Doc } });
    }
    push(m.role, blocks);
  }
  return out;
}

export function parseConverseOutput(output: ConverseCommandOutput): { text: string; toolCalls: ToolCall[] } {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of output.output?.message?.content ?? []) {
    if (typeof block.text === 'string') texts.push(block.text);
    if (block.toolUse?.name) {
      const input = block.toolUse.input;
      toolCalls.push({
        id: block.toolUse.toolUseId ?? '',
        name: block.toolUse.name,
        arguments: input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {},
      });
    }
  }
  return { text: texts.join(''), toolCalls };
}

const toTool = (t: { name: string; description: string; parameters: Record<string, unknown> }): Tool => ({
  toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters as Doc } },
});

/** Build the Converse input for a request — exported so a test can pin the wire shape. */
export function toConverseInput(request: ChatRequest, m: ResolvedModel): ConverseCommandInput {
  const system = [request.system, request.json ? JSON_SYSTEM : ''].filter(Boolean).join('\n\n');
  return {
    modelId: m.model,
    messages: toConverseMessages(request.messages),
    ...(system ? { system: [{ text: system }] } : {}),
    inferenceConfig: { maxTokens: request.maxTokens, ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}) },
    ...(request.tools?.length ? { toolConfig: { tools: request.tools.map(toTool) } } : {}),
  };
}

/** AWS SDK errors carry the HTTP status on $metadata; map the ones the health layer keys on. */
function statusOf(err: unknown): number | undefined {
  const e = err as { $metadata?: { httpStatusCode?: number }; name?: string };
  if (typeof e?.$metadata?.httpStatusCode === 'number') return e.$metadata.httpStatusCode;
  switch (e?.name) {
    case 'ThrottlingException':
      return 429;
    case 'AccessDeniedException':
      return 403;
    case 'ResourceNotFoundException':
      return 404;
    case 'ValidationException':
      return 400;
    case 'CredentialsProviderError':
      return 401;
    default:
      return undefined;
  }
}

export const bedrockProvider: ModelProvider = {
  kind: 'bedrock',
  capabilities: { json: true, tools: true, contextTokens: 200_000 },

  capabilitiesFor(m: ResolvedModel): ProviderCapabilities {
    const override = m.provider.extra.contextTokens;
    const known = CONTEXT.find(([re]) => re.test(m.model))?.[1];
    return { ...this.capabilities, contextTokens: typeof override === 'number' && override > 0 ? override : (known ?? this.capabilities.contextTokens) };
  },

  async chat(request: ChatRequest, m: ResolvedModel, signal?: AbortSignal): Promise<ChatResponse> {
    const input = toConverseInput(request, m);
    let output: ConverseCommandOutput;
    try {
      output = sendOverride ? await sendOverride(input) : await clientFor(m).send(new ConverseCommand(input), { abortSignal: signal });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const e = err as { name?: string; message?: string };
      throw new ProviderError(`bedrock: ${e?.name ? `${e.name}: ` : ''}${e?.message ?? String(err)}`, statusOf(err), 'bedrock');
    }
    const { text, toolCalls } = parseConverseOutput(output);
    const u = output.usage;
    return {
      text,
      toolCalls,
      usage: usageFromAnthropic({ input_tokens: u?.inputTokens, output_tokens: u?.outputTokens, cache_read_input_tokens: u?.cacheReadInputTokens, cache_creation_input_tokens: u?.cacheWriteInputTokens }),
      model: m.model,
      provider: 'bedrock',
    };
  },
};
