/**
 * The model-provider contract (platform-architecture §6, phase 3).
 *
 * Every model call in the control plane goes `invokeModel(role, request)` →
 * role → provider row → adapter. Adapters are pure request shapers over
 * `fetch`: they take a provider-neutral {@link ChatRequest}, speak one
 * vendor's wire format, and hand back a {@link ChatResponse} with the text,
 * any tool calls and the token usage the vendor reported. They never read
 * the database, never resolve credentials (the invoke layer does, from the
 * row's `credential_ref`) and never retry — the reliability layer in
 * `server/routes/llm-health.ts` keeps its retry / categorize / feed-item
 * behaviour unchanged above them.
 */

/** The adapter ids a `model_providers.kind` may carry. */
export const PROVIDER_KINDS = ['anthropic', 'openai-compatible', 'databricks', 'bedrock', 'vertex'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ToolDef {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  /** Text content; may be '' on an assistant turn that only called tools. */
  content: string;
  /** Assistant turn: the calls it made (echoed back verbatim on the next turn). */
  toolCalls?: ToolCall[];
  /** Tool turn: which call this answers. */
  toolCallId?: string;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** The caller will parse a JSON object out of the reply. Adapters that can, force it. */
  json?: boolean;
  tools?: ToolDef[];
  temperature?: number;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** The model id the provider reports it used (the request's when it reports none). */
  model: string;
  provider: ProviderKind;
}

export interface ProviderCapabilities {
  /** Can be held to "reply with only a JSON object". */
  json: boolean;
  /** Function / tool calling. */
  tools: boolean;
  /** Context window the model is assumed to have, in tokens. */
  contextTokens: number;
}

/** A `model_providers` row, as the invoke layer reads it. Never carries a secret. */
export interface ProviderConfig {
  id: number;
  name: string;
  kind: ProviderKind;
  /** Vendor base URL (`https://api.openai.com/v1`, a workspace host, an Azure resource…); null = the adapter's default. */
  baseUrl: string | null;
  /** Name of the environment variable (dev) or Key Vault secret (prod) holding the key — never the key. */
  credentialRef: string;
  defaultModel: string;
  /** Adapter-specific settings: `apiVersion` (Azure), `clientId` (Databricks SP), `preset`, `bypassGateway`, `contextTokens`… */
  extra: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
}

/** What an adapter is handed per call: the row, the model to use, the resolved secret and the gateway routing. */
export interface ResolvedModel {
  provider: ProviderConfig;
  model: string;
  /** The resolved API key / secret, or null when `credential_ref` resolved to nothing. */
  credential: string | null;
  /** `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>` when the call should route through Cloudflare AI Gateway. */
  gatewayBaseUrl: string | null;
  /** Tags for the gateway's logs: tenant, role, flow, ticket. */
  metadata: Record<string, string>;
}

export interface ModelProvider {
  readonly kind: ProviderKind;
  /** Baseline capabilities of the adapter; `capabilitiesFor` refines per model id. */
  readonly capabilities: ProviderCapabilities;
  /** Capabilities of one model on this provider (context window by model family, `extra.contextTokens` override). */
  capabilitiesFor(model: ResolvedModel): ProviderCapabilities;
  chat(request: ChatRequest, model: ResolvedModel, signal?: AbortSignal): Promise<ChatResponse>;
}

/**
 * A provider call that failed. `status` is the HTTP status when there was
 * one (undefined for network errors), which is what `categorizeFailure` and
 * `isTransientStatus` in llm-health.ts key on.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly provider?: ProviderKind,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** A provider kind that is declared but has no working adapter in this build (bedrock, vertex). */
export class ProviderNotAvailableError extends ProviderError {
  constructor(kind: ProviderKind, detail: string) {
    super(`${kind} provider is not configured in this build — ${detail}`, undefined, kind);
    this.name = 'ProviderNotAvailableError';
  }
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** OpenAI-style `usage` block → {@link TokenUsage} (cache reads from `prompt_tokens_details.cached_tokens`). */
export function usageFromOpenAi(u: unknown): TokenUsage {
  if (!u || typeof u !== 'object') return emptyUsage();
  const o = u as { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  const cacheRead = int(o.prompt_tokens_details?.cached_tokens);
  return { input: Math.max(0, int(o.prompt_tokens) - cacheRead), output: int(o.completion_tokens), cacheRead, cacheCreate: 0 };
}

/** Anthropic `usage` block → {@link TokenUsage}. */
export function usageFromAnthropic(u: unknown): TokenUsage {
  if (!u || typeof u !== 'object') return emptyUsage();
  const o = u as { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
  return { input: int(o.input_tokens), output: int(o.output_tokens), cacheRead: int(o.cache_read_input_tokens), cacheCreate: int(o.cache_creation_input_tokens) };
}

/** Read the body of a failed response for the error message, bounded so a stack trace can't flood the logs. */
export async function errorBody(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message =
      typeof parsed.error === 'string' ? parsed.error : typeof parsed.error?.message === 'string' ? parsed.error.message : parsed.message;
    if (typeof message === 'string' && message) return message.slice(0, 400);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 400);
}

/** Wrap a fetch so a thrown network/timeout error becomes a status-less {@link ProviderError}. */
export async function providerFetch(kind: ProviderKind, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new ProviderError(`${kind}: ${(err as Error).message || 'request failed'}`, undefined, kind);
  }
}

/** Parse a JSON body defensively; a non-JSON 200 is a provider error, not a crash. */
export async function jsonBody(kind: ProviderKind, resp: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await resp.json();
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ProviderError(`${kind}: response was not a JSON object`, resp.status, kind);
}
