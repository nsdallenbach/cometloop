import type { ResolvedModel } from './provider';

/**
 * Cloudflare AI Gateway routing (platform-architecture §6). A gateway is
 * `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>`; a provider's
 * own URL is reached by appending the gateway's provider segment
 * (`/anthropic`, `/openai`, `/azure-openai/<resource>/<deployment>`, …) and
 * the vendor path. The tenant's own key still goes in the upstream auth
 * header — the gateway is a proxy with logs, caching and rate limits, never
 * a key holder.
 *
 * `cf-aig-metadata` tags every request with the tenant, role, flow and
 * ticket so the gateway's logs and cost view are per workspace with no code
 * of ours. `cf-aig-cache-ttl` comes from the provider row's `extra.gateway`.
 */

export const GATEWAY_HOST = 'gateway.ai.cloudflare.com';

/** Hosts the gateway has a native route for, by the segment that replaces them. */
const NATIVE_HOSTS: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.anthropic.com': 'anthropic',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral',
  'api.deepseek.com': 'deepseek',
  'api.perplexity.ai': 'perplexity-ai',
  'openrouter.ai': 'openrouter',
};

/** Trailing slashes off, so joining never doubles them. */
export const trimSlash = (u: string): string => u.replace(/\/+$/, '');

/** True when this call should go through the gateway: one is configured and the row did not opt out. */
export function gatewayEnabled(m: ResolvedModel): boolean {
  return Boolean(m.gatewayBaseUrl) && m.provider.extra.bypassGateway !== true;
}

/**
 * Rewrite a vendor URL onto the gateway when the vendor host has a native
 * route. Unknown hosts (a self-hosted vLLM, a Databricks workspace) are
 * returned unchanged — the gateway cannot proxy them by name.
 */
export function gatewayUrl(m: ResolvedModel, vendorUrl: string): string {
  if (!gatewayEnabled(m) || !m.gatewayBaseUrl) return vendorUrl;
  let parsed: URL;
  try {
    parsed = new URL(vendorUrl);
  } catch {
    return vendorUrl;
  }
  const segment = NATIVE_HOSTS[parsed.host];
  if (!segment) return vendorUrl;
  // Vendor paths keep their version prefix under the gateway except OpenAI,
  // whose gateway route already stands in for `/v1`.
  const path = segment === 'openai' ? parsed.pathname.replace(/^\/v1(?=\/|$)/, '') : parsed.pathname;
  return `${trimSlash(m.gatewayBaseUrl)}/${segment}${path}${parsed.search}`;
}

/** Azure OpenAI has its own gateway shape: `/azure-openai/<resource>/<deployment>/chat/completions?api-version=…`. */
export function gatewayAzureUrl(m: ResolvedModel, resource: string, deployment: string, apiVersion: string): string | null {
  if (!gatewayEnabled(m) || !m.gatewayBaseUrl) return null;
  return `${trimSlash(m.gatewayBaseUrl)}/azure-openai/${encodeURIComponent(resource)}/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

/** The `cf-aig-*` headers for a call that goes through the gateway; empty when it does not. */
export function gatewayHeaders(m: ResolvedModel, url: string): Record<string, string> {
  if (!url.includes(GATEWAY_HOST)) return {};
  const headers: Record<string, string> = { 'cf-aig-metadata': JSON.stringify(m.metadata) };
  const gateway = m.provider.extra.gateway;
  if (gateway && typeof gateway === 'object') {
    const g = gateway as { cacheTtl?: unknown; skipCache?: unknown };
    if (typeof g.cacheTtl === 'number' && g.cacheTtl > 0) headers['cf-aig-cache-ttl'] = String(Math.round(g.cacheTtl));
    if (g.skipCache === true) headers['cf-aig-skip-cache'] = 'true';
  }
  return headers;
}
