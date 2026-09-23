import { ProviderNotAvailableError, type ChatRequest, type ChatResponse, type ModelProvider, type ProviderCapabilities, type ResolvedModel } from '../provider';

/**
 * AWS Bedrock — declared, not implemented. The row shape is ready
 * (`base_url` = region endpoint or empty for the default, `credential_ref`
 * = the secret holding `AWS_SECRET_ACCESS_KEY`, `extra.region`,
 * `extra.accessKeyId`) and the settings UI lets an admin register one, but
 * every call answers with a clear "not configured in this build" so the
 * caller's deterministic fallback applies. Wiring it means SigV4 signing of
 * the Converse API (or Cloudflare AI Gateway's `/aws-bedrock` route, which
 * signs for us) — tracked for a later phase.
 */
export const bedrockProvider: ModelProvider = {
  kind: 'bedrock',
  capabilities: { json: true, tools: true, contextTokens: 200_000 },
  capabilitiesFor(_m: ResolvedModel): ProviderCapabilities {
    return { ...this.capabilities };
  },
  chat(_request: ChatRequest, _m: ResolvedModel): Promise<ChatResponse> {
    return Promise.reject(new ProviderNotAvailableError('bedrock', 'the Converse API adapter (SigV4) is not wired in yet'));
  },
};
