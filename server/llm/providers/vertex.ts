import { ProviderNotAvailableError, type ChatRequest, type ChatResponse, type ModelProvider, type ProviderCapabilities, type ResolvedModel } from '../provider';

/**
 * Google Vertex AI — declared, not implemented. The row shape is ready
 * (`extra.project`, `extra.location`, `credential_ref` = the secret holding
 * a service-account JSON key) and the settings UI lets an admin register
 * one, but every call answers with a clear "not configured in this build"
 * so the caller's deterministic fallback applies. Wiring it means a
 * service-account OAuth exchange plus the `generateContent` body (or
 * Cloudflare AI Gateway's `/google-vertex-ai` route) — a later phase.
 */
export const vertexProvider: ModelProvider = {
  kind: 'vertex',
  capabilities: { json: true, tools: true, contextTokens: 1_000_000 },
  capabilitiesFor(_m: ResolvedModel): ProviderCapabilities {
    return { ...this.capabilities };
  },
  chat(_request: ChatRequest, _m: ResolvedModel): Promise<ChatResponse> {
    return Promise.reject(new ProviderNotAvailableError('vertex', 'the generateContent adapter (service-account OAuth) is not wired in yet'));
  },
};
