import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { bedrockProvider, parseConverseOutput, setBedrockSendForTests, toConverseInput, toConverseMessages } from './bedrock';
import { ProviderError, type ChatRequest, type ProviderConfig, type ResolvedModel } from '../provider';

/**
 * The Bedrock adapter against a scripted Converse call: the request shape
 * (system + JSON instruction, tool config, inference config), the parse of
 * text, tool use and usage, and the error mapping the health layer keys on.
 */

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 3,
  name: 'Bedrock',
  kind: 'bedrock',
  baseUrl: null,
  credentialRef: '',
  defaultModel: 'us.anthropic.claude-sonnet-5',
  extra: { region: 'us-east-2' },
  createdAt: null,
  updatedAt: null,
  ...over,
});

const resolved = (over: Partial<ResolvedModel> = {}): ResolvedModel => ({
  provider: config(),
  model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  credential: null,
  gatewayBaseUrl: null,
  metadata: { tenant: 't_a', role: 'estimate', flow: 'estimate' },
  ...over,
});

const REQ: ChatRequest = { system: 'You estimate.', messages: [{ role: 'user', content: 'estimate it' }], maxTokens: 120, json: true, temperature: 0.2 };

afterEach(() => setBedrockSendForTests(null));

describe('toConverseInput', () => {
  it('sends the model id, the system prompt with the JSON instruction, and the inference config', () => {
    const input = toConverseInput(REQ, resolved());
    expect(input.modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(input.system).toHaveLength(1);
    expect(input.system?.[0].text).toContain('You estimate.');
    expect(input.system?.[0].text).toContain('single JSON object');
    expect(input.inferenceConfig).toEqual({ maxTokens: 120, temperature: 0.2 });
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: 'estimate it' }] }]);
    expect(input.toolConfig).toBeUndefined();
  });

  it('maps tools onto toolConfig and folds tool results into one user turn', () => {
    const input = toConverseInput(
      {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }, { id: 'c2', name: 'read_file', arguments: { path: 'b.ts' } }] },
          { role: 'tool', content: 'A', toolCallId: 'c1' },
          { role: 'tool', content: 'B', toolCallId: 'c2' },
        ],
        maxTokens: 50,
        tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      },
      resolved(),
    );
    expect(input.toolConfig?.tools?.[0]).toEqual({ toolSpec: { name: 'read_file', description: 'Read', inputSchema: { json: { type: 'object', properties: { path: { type: 'string' } } } } } });
    const msgs = toConverseMessages([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
      { role: 'tool', content: 'A', toolCallId: 'c1' },
      { role: 'tool', content: 'B', toolCallId: 'c2' },
    ]);
    expect(msgs).toEqual([
      { role: 'assistant', content: [{ toolUse: { toolUseId: 'c1', name: 'read_file', input: { path: 'a.ts' } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'c1', content: [{ text: 'A' }] } }, { toolResult: { toolUseId: 'c2', content: [{ text: 'B' }] } }] },
    ]);
    expect(input.messages).toHaveLength(3);
  });
});

describe('bedrockProvider.chat', () => {
  it('parses text, tool use and usage from the Converse output', async () => {
    const seen: ConverseCommandInput[] = [];
    const output: ConverseCommandOutput = {
      $metadata: {},
      output: { message: { role: 'assistant', content: [{ text: '{"hours": 1.5}' }, { toolUse: { toolUseId: 't1', name: 'lookup', input: { key: 'DAT-1' } } }] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52, cacheReadInputTokens: 8, cacheWriteInputTokens: 0 },
      metrics: { latencyMs: 300 },
    };
    setBedrockSendForTests((input) => {
      seen.push(input);
      return Promise.resolve(output);
    });
    const res = await bedrockProvider.chat(REQ, resolved());
    expect(seen).toHaveLength(1);
    expect(res).toEqual({
      text: '{"hours": 1.5}',
      toolCalls: [{ id: 't1', name: 'lookup', arguments: { key: 'DAT-1' } }],
      usage: { input: 40, output: 12, cacheRead: 8, cacheCreate: 0 },
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      provider: 'bedrock',
    });
  });

  it('maps SDK failures onto ProviderError with the status the health layer expects', async () => {
    const throttled = Object.assign(new Error('Too many requests'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } });
    setBedrockSendForTests(vi.fn().mockRejectedValue(throttled));
    const err = await bedrockProvider.chat(REQ, resolved()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(429);
    expect((err as Error).message).toContain('bedrock: ThrottlingException');

    const noCreds = Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' });
    setBedrockSendForTests(vi.fn().mockRejectedValue(noCreds));
    const err2 = await bedrockProvider.chat(REQ, resolved()).catch((e: unknown) => e);
    expect((err2 as ProviderError).status).toBe(401);
  });

  it('knows the context windows of the Claude families on Bedrock', () => {
    expect(bedrockProvider.capabilitiesFor(resolved({ model: 'us.anthropic.claude-sonnet-5' })).contextTokens).toBe(1_000_000);
    expect(bedrockProvider.capabilitiesFor(resolved({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' })).contextTokens).toBe(200_000);
    expect(bedrockProvider.capabilitiesFor(resolved({ provider: config({ extra: { contextTokens: 42 } }) })).contextTokens).toBe(42);
  });

  it('handles an empty reply', () => {
    expect(parseConverseOutput({ $metadata: {} } as ConverseCommandOutput)).toEqual({ text: '', toolCalls: [] });
  });
});
