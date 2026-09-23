import type express from 'express';
import { MODEL_ROLES, ROLE_CONTRACTS, checkContract, requestNeeds, resolveModel, resolveRole, type ModelRole } from '../llm/config';
import { providerFor } from '../llm/providers';
import { ProviderError, ProviderNotAvailableError, type ChatRequest, type ChatResponse, type ProviderConfig } from '../llm/provider';
import { recordControlPlaneUsage } from './token-usage';

/**
 * Shared reliability layer for every model (LLM) call (DAT-180), now over
 * the provider registry (platform-architecture §6, phase 3).
 *
 * Born from the 2026-08-11 planning-model outage: every flow called
 * `serving('default').invoke` exactly once, and background flows swallowed
 * failures into console.warn — so an endpoint blip silently produced unplanned
 * tickets, unanswered comment feedback and missing estimates. This module is
 * the single choke point that makes those failures visible and survivable:
 *
 * - `invokeModel(role, request)` resolves the role to the current tenant's
 *   provider + model (server/llm/config.ts), checks the role's capability
 *   contract, calls the adapter, wraps the call with one retry on transient
 *   errors (network, 408/429/5xx), categorizes the failure (auth / rate-limit
 *   / server / payload / network), keeps per-flow counters, surfaces a
 *   feed item on the engagement when a call fails (throttled per flow so a
 *   sustained outage doesn't flood the feed), and records the tokens the
 *   call spent in `app.run_token_usage` as a control-plane row.
 * - `GET /api/llm/health` live-probes each configured role and reports
 *   per-role and per-flow status, so "is the planning model up?" is one
 *   curl instead of a log dive.
 *
 * Callers keep their existing deterministic fallbacks (documented in
 * docs/llm-fallbacks.md) — this layer only adds detection and resilience,
 * it never changes what degrades. No provider configured for a role is not
 * an outage: the call is skipped without retry or feed item and the same
 * fallback applies.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export type LlmFlow =
  | 'ticket-refine'
  | 'comment-rework'
  | 'estimate'
  | 'status-draft'
  | 'sow-parse'
  | 'standards-refine'
  | 'pr-review'
  | 'health-probe';

const FLOW_LABELS: Record<LlmFlow, string> = {
  'ticket-refine': 'ticket planning/refine',
  'comment-rework': 'comment-feedback rework',
  estimate: 'hours estimation',
  'status-draft': 'weekly status draft',
  'sow-parse': 'SOW plan extraction',
  'standards-refine': 'standards refine',
  'pr-review': 'PR review',
  'health-probe': 'health probe',
};

/** Which role each flow runs under — the table in docs/llm-fallbacks.md. */
export const FLOW_ROLES: Record<LlmFlow, ModelRole> = {
  'ticket-refine': 'planning',
  'comment-rework': 'planning',
  'sow-parse': 'planning',
  'standards-refine': 'planning',
  estimate: 'estimate',
  'status-draft': 'draft',
  'pr-review': 'review',
  'health-probe': 'planning',
};

/** The flow a call is attributed to when the caller names none. */
const ROLE_DEFAULT_FLOW: Record<ModelRole, LlmFlow> = {
  planning: 'ticket-refine',
  estimate: 'estimate',
  review: 'pr-review',
  draft: 'status-draft',
};

export type FailureCategory = 'auth' | 'rate-limit' | 'server' | 'payload' | 'network';

/**
 * Thrown when a role has no model behind it (no provider row for the
 * tenant, or the mapped adapter is a stub in this build). Not an outage:
 * `invokeModel` neither retries nor posts the ⚠ feed item — it rethrows at
 * once so the caller's deterministic fallback applies, and
 * `/api/llm/health` reports it plainly.
 */
export class ModelNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`no model configured — ${reason}`);
    this.name = 'ModelNotConfiguredError';
  }
}

export interface FlowStatus {
  calls: number;
  failures: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastErrorCategory: FailureCategory | null;
}

// ---------- pure helpers (unit-tested) ----------

/** Retry once on errors that plausibly clear within seconds; never on auth/payload. */
export function isTransientStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // thrown/network error — no HTTP status
  return status === 408 || status === 429 || status >= 500;
}

/** Bucket a failure the way the incident review asks: scaling, auth, or payload. */
export function categorizeFailure(status: number | undefined): FailureCategory {
  if (status === undefined) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500 || status === 408) return 'server';
  return 'payload';
}

/**
 * ExecutionResult-style failure wrapper from a programmatic invoke:
 * { ok: false, status?, message? }. Success and non-wrapper payloads → null.
 * Kept for callers that still unwrap raw serving payloads (the MCP tool path).
 */
export function invokeError(response: unknown): { message: string; status?: number } | null {
  if (!response || typeof response !== 'object' || !('ok' in response)) return null;
  const wrapper = response as { ok: boolean; status?: unknown; message?: unknown };
  if (wrapper.ok) return null;
  return {
    message: typeof wrapper.message === 'string' && wrapper.message ? wrapper.message : 'model invocation failed',
    status: typeof wrapper.status === 'number' ? wrapper.status : undefined,
  };
}

/** Per-flow feed-item throttle: at most one failure feed item per window. */
export class FeedThrottle {
  private lastPosted = new Map<string, number>();
  constructor(private windowMs: number) {}

  shouldPost(flow: string, now: number): boolean {
    const last = this.lastPosted.get(flow);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.lastPosted.set(flow, now);
    return true;
  }

  reset(): void {
    this.lastPosted.clear();
  }
}

// ---------- in-process state ----------

export const FEED_THROTTLE_MS = 10 * 60_000;
const RETRY_DELAY_MS = 1500;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_CACHE_MS = 30_000;

const flowStatuses = new Map<LlmFlow, FlowStatus>();
const feedThrottle = new FeedThrottle(FEED_THROTTLE_MS);

/**
 * The tenant-scoped query the invoke layer reads configuration with and
 * writes feed items / usage rows through. It reads the tenant from the
 * async context (server/db/tenant-context.ts), so one function serves every
 * tenant. Set once by `setupApiRoutes`; tests set a pg-mem query.
 */
let llmQuery: Query | null = null;

export function setLlmQuery(q: Query | null): void {
  llmQuery = q;
}

function statusFor(flow: LlmFlow): FlowStatus {
  let s = flowStatuses.get(flow);
  if (!s) {
    s = {
      calls: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastErrorCategory: null,
    };
    flowStatuses.set(flow, s);
  }
  return s;
}

export function llmFlowStatuses(): Record<string, FlowStatus> {
  return Object.fromEntries(flowStatuses.entries());
}

/** Test hook: clear counters, throttle windows and the probe cache. */
export function resetLlmHealthState(): void {
  flowStatuses.clear();
  feedThrottle.reset();
  probeCache.clear();
}

// ---------- model invocation ----------

export interface InvokeContext {
  /** The flow the call is counted under; defaults to the role's main flow. */
  flow?: LlmFlow;
  engagementId?: string;
  ticketKey?: string;
  /** Pin the model on the role's provider (the PR reviewer's registered endpoint). */
  modelOverride?: string;
}

interface InvokeFailure {
  message: string;
  status?: number;
  category?: FailureCategory;
}

async function surfaceFailure(q: Query | null, flow: LlmFlow, error: InvokeFailure, ctx: InvokeContext): Promise<void> {
  const category = error.category ?? categorizeFailure(error.status);
  const s = statusFor(flow);
  s.failures++;
  s.consecutiveFailures++;
  s.lastFailureAt = new Date().toISOString();
  s.lastError = `${error.message}${error.status !== undefined ? ` [HTTP ${error.status}]` : ''}`;
  s.lastErrorCategory = category;
  console.error(
    `[llm] ${FLOW_LABELS[flow]} model call FAILED (${category}${error.status !== undefined ? ` ${error.status}` : ''})` +
      `${ctx.ticketKey ? ` on ${ctx.ticketKey}` : ''}${ctx.engagementId ? ` [${ctx.engagementId}]` : ''}: ${error.message} — deterministic fallback applies`,
  );
  // Surface on the engagement feed so an outage is visible in the app, not
  // just the server logs. Throttled per flow; a feed write must never mask
  // the model failure itself.
  if (q && ctx.engagementId && flow !== 'health-probe' && feedThrottle.shouldPost(flow, Date.now())) {
    try {
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
        [
          ctx.engagementId,
          `⚠ Planning model call failed during ${FLOW_LABELS[flow]}${ctx.ticketKey ? ` on ${ctx.ticketKey}` : ''} — ` +
            `${category} error (${s.lastError}). The deterministic fallback was applied; check /api/llm/health.`,
        ],
      );
    } catch (feedErr) {
      console.warn('[llm] could not write model-failure feed item:', (feedErr as Error).message);
    }
  }
}

const skipped = (flow: LlmFlow, reason: string): Error =>
  new Error(`planning model call skipped (${FLOW_LABELS[flow]}): no model configured — ${reason} — deterministic fallback applies`);

/**
 * Call the model behind a role with failure accounting and one retry on
 * transient errors. Returns the adapter's {@link ChatResponse} (text, tool
 * calls, usage). Throws on failure — callers' existing catch blocks provide
 * the deterministic fallback. Configuration gaps (no provider for the role,
 * a stub adapter, a model that cannot meet the role's contract) throw
 * without retrying.
 */
export async function invokeModel(
  role: ModelRole,
  request: ChatRequest,
  ctx: InvokeContext = {},
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<ChatResponse> {
  const flow = ctx.flow ?? ROLE_DEFAULT_FLOW[role];
  const q = llmQuery;
  if (!q) throw skipped(flow, 'the model layer has no database connection');

  const resolved = await resolveRole(q, role, { modelOverride: ctx.modelOverride });
  if (!resolved) throw skipped(flow, `no provider is mapped to the ${role} role for this workspace`);
  const label = `${resolved.config.name} / ${resolved.model}`;

  const s = statusFor(flow);
  // A model that cannot meet the role's contract is refused up front — the
  // call would fail or, worse, return something the caller cannot parse.
  const gap = checkContract(role, requestNeeds(role, request), resolved.capabilities, label);
  if (gap) {
    await surfaceFailure(q, flow, { message: gap, category: 'payload' }, ctx);
    throw new Error(`planning model call refused (${FLOW_LABELS[flow]}): ${gap}`);
  }

  const model = await resolveModel(resolved.config, resolved.model, {
    role,
    flow,
    ...(ctx.ticketKey ? { ticket: ctx.ticketKey } : {}),
    ...(ctx.engagementId ? { project: ctx.engagementId } : {}),
  });

  s.calls++;
  let lastError: InvokeFailure = { message: 'model invocation failed' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.warn(`[llm] ${FLOW_LABELS[flow]}: transient model error (${lastError.message}) — retrying once`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    try {
      const response = await resolved.adapter.chat(request, model);
      s.consecutiveFailures = 0;
      s.lastSuccessAt = new Date().toISOString();
      if (flow !== 'health-probe') {
        // Usage is telemetry: losing a row costs accuracy, never the call.
        void recordControlPlaneUsage(q, {
          role,
          flow,
          provider: response.provider,
          model: response.model,
          ticketKey: ctx.ticketKey ?? '',
          engagementId: ctx.engagementId ?? '',
          usage: response.usage,
        }).catch((err: unknown) => console.warn('[llm] could not record control-plane usage:', (err as Error).message));
      }
      return response;
    } catch (err) {
      if (err instanceof ProviderNotAvailableError) {
        // Configuration, not an incident: no retry, no feed item, no counters.
        s.calls--;
        throw skipped(flow, err.message);
      }
      if (err instanceof ModelNotConfiguredError) {
        s.calls--;
        throw skipped(flow, err.message);
      }
      lastError =
        err instanceof ProviderError ? { message: err.message, status: err.status } : { message: (err as Error).message || 'model invocation threw' };
      if (!isTransientStatus(lastError.status)) break; // auth/payload — retrying can't help
    }
  }
  await surfaceFailure(q, flow, lastError, ctx);
  throw new Error(
    `planning model call failed (${FLOW_LABELS[flow]}, ${categorizeFailure(lastError.status)}): ${lastError.message}` +
      `${lastError.status !== undefined ? ` [HTTP ${lastError.status}]` : ''}`,
  );
}

// ---------- probes ----------

const PROBE_REQUEST: ChatRequest = { messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 8 };

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  model: string | null;
  error: string | null;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms))]);

/** One tiny call straight at a provider row + model (the settings page's Test button). Bypasses roles and counters. */
export async function probeModel(config: ProviderConfig, modelId: string): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const model = await resolveModel(config, modelId, { flow: 'health-probe', role: 'test' });
    const response = await withTimeout(providerFor(config.kind).chat(PROBE_REQUEST, model), PROBE_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - started, model: response.model, error: null };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, model: null, error: (err as Error).message };
  }
}

const probeCache = new Map<string, { at: number; result: ProbeResult }>();

async function probeRole(role: ModelRole): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const response = await withTimeout(invokeModel(role, PROBE_REQUEST, { flow: 'health-probe' }), PROBE_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - started, model: response.model, error: null };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, model: null, error: (err as Error).message };
  }
}

export interface RoleHealth {
  configured: boolean;
  provider: { id: number; name: string; kind: string } | null;
  model: string | null;
  contract: { json: boolean; tools: boolean; contextTokens: number };
  /** Why the mapping cannot meet the contract, when it cannot. */
  contractGap: string | null;
  probe: (ProbeResult & { at: string; cached: boolean }) | null;
}

/** Every role's mapping and, for the configured ones, a cached live probe. */
export async function rolesHealth(q: Query, tenantKey: string): Promise<Record<ModelRole, RoleHealth>> {
  const out = {} as Record<ModelRole, RoleHealth>;
  for (const role of MODEL_ROLES) {
    const c = ROLE_CONTRACTS[role];
    const contract = { json: c.json, tools: c.tools, contextTokens: c.contextTokens };
    const resolved = await resolveRole(q, role);
    if (!resolved) {
      out[role] = { configured: false, provider: null, model: null, contract, contractGap: null, probe: null };
      continue;
    }
    const gap = checkContract(role, contract, resolved.capabilities, `${resolved.config.name} / ${resolved.model}`);
    const key = `${tenantKey}:${role}`;
    const now = Date.now();
    let cached = true;
    let hit = probeCache.get(key);
    if (!hit || now - hit.at >= PROBE_CACHE_MS) {
      cached = false;
      hit = { at: now, result: await probeRole(role) };
      probeCache.set(key, hit);
    }
    out[role] = {
      configured: true,
      provider: { id: resolved.config.id, name: resolved.config.name, kind: resolved.config.kind },
      model: resolved.model,
      contract,
      contractGap: gap,
      probe: { ...hit.result, at: new Date(hit.at).toISOString(), cached },
    };
  }
  return out;
}

/**
 * GET /api/llm/health — per-role live health for the caller's workspace plus
 * per-flow failure counters. 200 when every configured role answers (and at
 * least one is configured), 503 otherwise. Probe results are cached briefly
 * per role so pollers can't hammer the providers.
 */
export function setupLlmHealthRoutes(app: express.Application, q: Query, tenantKeyOf: (req: express.Request) => string): void {
  app.get('/api/llm/health', async (req, res) => {
    try {
      const roles = await rolesHealth(q, tenantKeyOf(req));
      const configured = MODEL_ROLES.filter((r) => roles[r].configured);
      const ok = configured.length > 0 && configured.every((r) => roles[r].probe?.ok === true && roles[r].contractGap === null);
      res.status(ok ? 200 : 503).json({
        ok,
        configured: configured.length > 0,
        error: configured.length === 0 ? 'no model provider configured for this workspace' : null,
        roles,
        flows: llmFlowStatuses(),
      });
    } catch (err) {
      console.error('llm health failed:', err);
      res.status(500).json({ ok: false, error: 'Failed to read model health' });
    }
  });
}
