import { trimSlash } from '../gateway';
import {
  ProviderError,
  errorBody,
  jsonBody,
  providerFetch,
  usageFromOpenAi,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderCapabilities,
  type ResolvedModel,
} from '../provider';
import { parseChoice, toOpenAiMessages } from './openai-compatible';

/**
 * Databricks Model Serving — the one code path for everything that talks to
 * a workspace's serving endpoints (platform-architecture §6):
 *
 *  - `chat()` → `POST /serving-endpoints/<name>/invocations` with the
 *    service principal's M2M token. The model id IS the endpoint name.
 *    Foundation Model endpoints take the chat-completions body; Agent Bricks
 *    agents may want the responses-style `input` body instead, so a schema
 *    rejection (400/422) retries the other shape before giving up — exactly
 *    what the PR reviewer's `invokeAgentEndpoint` did before it folded in.
 *  - `fetchEndpointState()` — live READY / config state for the Agents page.
 *  - `listServingEndpoints()` — the chat-capable endpoints for the model
 *    picker (agent-models.ts), by REST rather than the SDK so the portable
 *    runtime lists them too.
 *
 * Credentials: a provider row names the SP secret in `credential_ref` and
 * carries the client id in `extra.clientId`; `base_url` is the workspace
 * host. The env-driven form (`DATABRICKS_HOST` / `DATABRICKS_CLIENT_ID` /
 * `DATABRICKS_CLIENT_SECRET`, which Databricks Apps inject) serves the
 * Agents page and the auto-registered provider. Cloudflare AI Gateway has no
 * native route for a workspace host, so these calls are always direct.
 */

export interface WorkspaceAuth {
  base: string;
  clientId: string;
  clientSecret: string;
}

export interface ServingState {
  ready: boolean;
  configUpdate: string;
  task: string | null;
  servedModel: string | null;
  /** Set when the endpoint could not be read — surfaced on the node so a
   *  missing CAN_QUERY grant looks like a permission problem, not a dead agent. */
  error?: string;
}

export interface ServingEndpointSummary {
  name: string;
  task: string | null;
  servedModel: string | null;
  ready: boolean;
}

/** Agent turns are long — a reviewer reads a diff and may call MCP tools. */
export const INVOKE_TIMEOUT_MS = 300_000;
const TOKEN_TTL_MS = 50 * 60_000;
const STATE_CACHE_MS = 60_000;

export function workspaceBaseUrl(host: string | undefined | null): string | null {
  if (!host) return null;
  const h = host.trim();
  if (!h) return null;
  return h.startsWith('http') ? trimSlash(h) : `https://${trimSlash(h)}`;
}

/** The process's own workspace credentials, or null when any part is missing. */
export function envWorkspaceAuth(): WorkspaceAuth | null {
  const base = workspaceBaseUrl(process.env.DATABRICKS_HOST);
  const clientId = process.env.DATABRICKS_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
  if (!base || !clientId || !clientSecret) return null;
  return { base, clientId, clientSecret };
}

/** Host + service-principal pair present — the only way this process can call the workspace by itself. */
export function workspaceCredentialsConfigured(): boolean {
  return envWorkspaceAuth() !== null;
}

function authFor(m: ResolvedModel): WorkspaceAuth {
  const base = workspaceBaseUrl(m.provider.baseUrl) ?? workspaceBaseUrl(process.env.DATABRICKS_HOST);
  const clientId = typeof m.provider.extra.clientId === 'string' && m.provider.extra.clientId ? m.provider.extra.clientId : (process.env.DATABRICKS_CLIENT_ID ?? '');
  const clientSecret = m.credential ?? '';
  if (!base || !clientId || !clientSecret) {
    throw new ProviderError('databricks: workspace credentials unavailable — base_url, extra.clientId and the SP secret are all required', 401, 'databricks');
  }
  return { base, clientId, clientSecret };
}

const tokenCache = new Map<string, { at: number; token: string }>();

/** M2M token for a service principal, cached most of its hour. */
export async function workspaceToken(auth: WorkspaceAuth): Promise<string | null> {
  const key = `${auth.base}|${auth.clientId}`;
  const hit = tokenCache.get(key);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;
  const resp = await providerFetch('databricks', `${auth.base}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=all-apis',
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) return null;
  const data = (await resp.json().catch(() => ({}))) as { access_token?: unknown };
  if (typeof data.access_token !== 'string' || !data.access_token) return null;
  tokenCache.set(key, { at: Date.now(), token: data.access_token });
  return data.access_token;
}

/** Test seam. */
export function resetDatabricksCaches(): void {
  tokenCache.clear();
  stateCache.clear();
}

const stateCache = new Map<string, { at: number; state: ServingState | null }>();
let loggedNoWorkspace = false;

/**
 * Live state for any workspace serving endpoint — the planning endpoint, an
 * Agent Bricks agent, anything registered on the map. Cached ~60s per
 * endpoint; null means "could not read it" (no credentials, no such
 * endpoint, or the app service principal lacks CAN_QUERY).
 */
export async function fetchEndpointState(endpoint: string, auth: WorkspaceAuth | null = envWorkspaceAuth()): Promise<ServingState | null> {
  if (!endpoint) return null;
  const hit = stateCache.get(endpoint);
  if (hit && Date.now() - hit.at < STATE_CACHE_MS) return hit.state;
  if (!auth) {
    // Outside Databricks (or a local dev shell without the SP pair) there is
    // nothing to ask; say so once instead of a warning per endpoint per minute.
    if (!loggedNoWorkspace) {
      loggedNoWorkspace = true;
      console.log('[agents] DATABRICKS_HOST / DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET not set — serving endpoint state and endpoint agents are off');
    }
    stateCache.set(endpoint, { at: Date.now(), state: null });
    return null;
  }
  try {
    const token = await workspaceToken(auth);
    if (!token) throw new Error('workspace credentials unavailable');
    const resp = await fetch(`${auth.base}/api/2.0/serving-endpoints/${encodeURIComponent(endpoint)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const state: ServingState = {
        ready: false,
        configUpdate: 'UNKNOWN',
        task: null,
        servedModel: null,
        error: resp.status === 403 || resp.status === 401 ? 'no access — grant the app service principal CAN_QUERY' : `serving api returned ${resp.status}`,
      };
      stateCache.set(endpoint, { at: Date.now(), state });
      return state;
    }
    const d = (await resp.json()) as {
      state?: { ready?: string; config_update?: string };
      task?: string;
      config?: { served_entities?: { entity_name?: string; name?: string }[] };
    };
    const state: ServingState = {
      ready: d.state?.ready === 'READY',
      configUpdate: d.state?.config_update ?? 'UNKNOWN',
      task: d.task ?? null,
      servedModel: d.config?.served_entities?.[0]?.entity_name ?? d.config?.served_entities?.[0]?.name ?? null,
    };
    stateCache.set(endpoint, { at: Date.now(), state });
    return state;
  } catch (err) {
    console.warn(`[agents] serving endpoint '${endpoint}' state fetch failed:`, (err as Error).message);
    stateCache.set(endpoint, { at: Date.now(), state: null });
    return null;
  }
}

/** `system.ai.databricks-claude-opus-5` → `databricks-claude-opus-5`. */
const shortModel = (entity: string | null | undefined): string | null => {
  if (!entity) return null;
  const parts = entity.split('.');
  return parts[parts.length - 1] || entity;
};

/** Every serving endpoint the SP can see, raw; the caller filters by task. Throws when the list cannot be read. */
export async function listServingEndpoints(auth: WorkspaceAuth): Promise<ServingEndpointSummary[]> {
  const token = await workspaceToken(auth);
  if (!token) throw new Error('workspace credentials unavailable');
  const resp = await fetch(`${auth.base}/api/2.0/serving-endpoints`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`serving api returned ${resp.status}`);
  const d = (await resp.json()) as {
    endpoints?: {
      name?: string;
      task?: string;
      state?: { ready?: string };
      config?: { served_entities?: { entity_name?: string; foundation_model?: { name?: string }; name?: string }[] };
    }[];
  };
  const out: ServingEndpointSummary[] = [];
  for (const ep of d.endpoints ?? []) {
    if (!ep.name) continue;
    const entity = ep.config?.served_entities?.[0];
    out.push({
      name: ep.name,
      task: ep.task ?? null,
      servedModel: shortModel(entity?.entity_name ?? entity?.foundation_model?.name ?? entity?.name ?? null),
      ready: ep.state?.ready === 'READY',
    });
  }
  return out;
}

/**
 * Pull the assistant text out of the shapes serving endpoints actually
 * return: chat completions, responses-style `output[].content[].text`,
 * `messages` / `predictions` lists, or a bare `content` / `text`.
 */
export function extractServingText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const r = response as Record<string, unknown>;

  const choices = r.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
    const content = first?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return parseChoice(r).text;
    if (typeof first?.text === 'string') return first.text;
  }

  const output = r.output ?? r.messages ?? r.predictions;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      if (typeof o.text === 'string') parts.push(o.text);
      if (typeof o.content === 'string') parts.push(o.content);
      if (Array.isArray(o.content)) {
        for (const seg of o.content) {
          if (seg && typeof seg === 'object' && typeof (seg as { text?: unknown }).text === 'string') {
            parts.push((seg as { text: string }).text);
          }
        }
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }

  if (typeof r.content === 'string') return r.content;
  if (typeof r.text === 'string') return r.text;
  return '';
}

export const databricksProvider: ModelProvider = {
  kind: 'databricks',
  // Foundation Model API endpoints (Claude, GPT, Gemini, Llama) all clear
  // 128k; an Agent Bricks agent inherits its model's. `extra.contextTokens`
  // says otherwise for a custom endpoint.
  capabilities: { json: true, tools: true, contextTokens: 200_000 },

  capabilitiesFor(m: ResolvedModel): ProviderCapabilities {
    const override = m.provider.extra.contextTokens;
    return { ...this.capabilities, contextTokens: typeof override === 'number' && override > 0 ? override : this.capabilities.contextTokens };
  },

  async chat(request: ChatRequest, m: ResolvedModel, signal?: AbortSignal): Promise<ChatResponse> {
    const auth = authFor(m);
    const token = await workspaceToken(auth);
    if (!token) throw new ProviderError('databricks: could not obtain a workspace token for the service principal', 401, 'databricks');
    const url = `${auth.base}/serving-endpoints/${encodeURIComponent(m.model)}/invocations`;
    const messages = toOpenAiMessages(request);
    const chatBody: Record<string, unknown> = {
      messages,
      max_tokens: request.maxTokens,
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(request.tools?.length
        ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };
    // Agent Bricks agents differ in request schema — chat-style `messages`
    // for supervisor / custom-LLM agents, responses-style `input` for
    // others — so a schema rejection retries the other shape.
    const shapes: Record<string, unknown>[] = [chatBody, { input: messages }];
    let last: ProviderError = new ProviderError('databricks: endpoint call failed', undefined, 'databricks');
    for (const body of shapes) {
      const resp = await providerFetch('databricks', url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(INVOKE_TIMEOUT_MS),
      });
      if (resp.ok) {
        const data = await jsonBody('databricks', resp);
        const { text, toolCalls } = parseChoice(data);
        return {
          text: text || extractServingText(data),
          toolCalls,
          usage: usageFromOpenAi(data.usage),
          model: typeof data.model === 'string' && data.model ? data.model : m.model,
          provider: 'databricks',
        };
      }
      last = new ProviderError(`databricks: endpoint returned ${resp.status}: ${await errorBody(resp)}`, resp.status, 'databricks');
      if (resp.status !== 400 && resp.status !== 422) break;
    }
    throw last;
  },
};
