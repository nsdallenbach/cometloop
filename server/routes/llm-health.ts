import type express from 'express';

/**
 * Shared reliability layer for every serving-endpoint (LLM) call (DAT-180).
 *
 * Born from the 2026-08-11 planning-model outage: every flow called
 * `serving('default').invoke` exactly once, and background flows swallowed
 * failures into console.warn — so an endpoint blip silently produced unplanned
 * tickets, unanswered comment feedback and missing estimates. This module is
 * the single choke point that makes those failures visible and survivable:
 *
 * - `invokeModel` wraps every call with one retry on transient errors
 *   (network, 408/429/5xx), categorizes the failure (auth / rate-limit /
 *   server / payload / network), keeps per-flow counters, and surfaces a
 *   feed item on the engagement when a call fails (throttled per flow so a
 *   sustained outage doesn't flood the feed).
 * - `GET /api/llm/health` live-probes the endpoint and reports per-flow
 *   status, so "is the planning model up?" is one curl instead of a log dive.
 *
 * Callers keep their existing deterministic fallbacks (documented in
 * docs/llm-fallbacks.md) — this layer only adds detection and resilience,
 * it never changes what degrades.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type Serving = (alias: string) => { invoke(body: unknown): Promise<unknown> };

export type LlmFlow =
  | 'ticket-refine'
  | 'comment-rework'
  | 'estimate'
  | 'status-draft'
  | 'sow-parse'
  | 'standards-refine'
  | 'health-probe';

const FLOW_LABELS: Record<LlmFlow, string> = {
  'ticket-refine': 'ticket planning/refine',
  'comment-rework': 'comment-feedback rework',
  estimate: 'hours estimation',
  'status-draft': 'weekly status draft',
  'sow-parse': 'SOW plan extraction',
  'standards-refine': 'standards refine',
  'health-probe': 'health probe',
};

export type FailureCategory = 'auth' | 'rate-limit' | 'server' | 'payload' | 'network';

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
 * ExecutionResult-style failure from a programmatic serving invoke:
 * { ok: false, status?, message? }. Success and non-wrapper payloads → null.
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
  probeCache = null;
}

// ---------- model invocation ----------

export interface InvokeContext {
  engagementId?: string;
  ticketKey?: string;
}

async function surfaceFailure(
  q: Query | null,
  flow: LlmFlow,
  error: { message: string; status?: number },
  ctx: InvokeContext,
): Promise<void> {
  const category = categorizeFailure(error.status);
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

/**
 * Invoke the serving endpoint with failure accounting and one retry on
 * transient errors. Returns the raw invoke response on success (callers keep
 * their own extractText/parse logic). Throws on failure — callers' existing
 * catch blocks provide the deterministic fallback. Pass `q: null` when there
 * is no engagement to surface a feed item on (e.g. SOW parse pre-engagement).
 */
export async function invokeModel(
  serving: Serving,
  q: Query | null,
  flow: LlmFlow,
  body: unknown,
  ctx: InvokeContext = {},
  retryDelayMs: number = RETRY_DELAY_MS,
): Promise<unknown> {
  const s = statusFor(flow);
  s.calls++;
  let lastError: { message: string; status?: number } = { message: 'model invocation failed' };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      console.warn(`[llm] ${FLOW_LABELS[flow]}: transient model error (${lastError.message}) — retrying once`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    try {
      const response = await serving('default').invoke(body);
      const error = invokeError(response);
      if (!error) {
        s.consecutiveFailures = 0;
        s.lastSuccessAt = new Date().toISOString();
        return response;
      }
      lastError = error;
      if (!isTransientStatus(error.status)) break; // auth/payload — retrying can't help
    } catch (err) {
      lastError = { message: (err as Error).message || 'model invocation threw' };
    }
  }
  await surfaceFailure(q, flow, lastError, ctx);
  throw new Error(
    `planning model call failed (${FLOW_LABELS[flow]}, ${categorizeFailure(lastError.status)}): ${lastError.message}` +
      `${lastError.status !== undefined ? ` [HTTP ${lastError.status}]` : ''}`,
  );
}

// ---------- health endpoint ----------

let probeCache: { at: number; ok: boolean; latencyMs: number; error: string | null } | null = null;

async function probeEndpoint(serving: Serving): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const started = Date.now();
  try {
    await Promise.race([
      invokeModel(serving, null, 'health-probe', {
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        max_tokens: 8,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)),
    ]);
    return { ok: true, latencyMs: Date.now() - started, error: null };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

/**
 * GET /api/llm/health — live health of the serving endpoint plus per-flow
 * failure counters. 200 when the probe succeeds, 503 when it fails. Probe
 * results are cached briefly so pollers can't hammer the endpoint.
 */
export function setupLlmHealthRoutes(app: express.Application, serving: Serving): void {
  app.get('/api/llm/health', async (_req, res) => {
    const now = Date.now();
    let cached = true;
    if (!probeCache || now - probeCache.at >= PROBE_CACHE_MS) {
      cached = false;
      probeCache = { at: now, ...(await probeEndpoint(serving)) };
    }
    res.status(probeCache.ok ? 200 : 503).json({
      ok: probeCache.ok,
      endpoint: 'default',
      probe: {
        latencyMs: probeCache.latencyMs,
        at: new Date(probeCache.at).toISOString(),
        cached,
        error: probeCache.error,
      },
      flows: llmFlowStatuses(),
    });
  });
}
