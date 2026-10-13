// One real Converse call through the adapter, with whatever AWS credentials
// the environment has (AWS_PROFILE locally, the task role on ECS):
//   AWS_PROFILE=cometloop AWS_REGION=us-east-2 npx tsx scripts/bedrock-live-check.mts [model-id]
import { bedrockProvider } from '../server/llm/providers/bedrock';

const model = process.argv[2] ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const started = Date.now();
const res = await bedrockProvider.chat(
  { system: 'You are a JSON function.', messages: [{ role: 'user', content: 'Reply with ONLY a JSON object: {"ok": true, "model_family": "<claude family name>"}' }], maxTokens: 60, json: true },
  { provider: { id: 0, name: 'Bedrock', kind: 'bedrock', baseUrl: null, credentialRef: '', defaultModel: model, extra: { region: process.env.AWS_REGION ?? 'us-east-2' }, createdAt: null, updatedAt: null }, model, credential: null, gatewayBaseUrl: null, metadata: {} },
);
console.log(JSON.stringify({ model: res.model, text: res.text, usage: res.usage, ms: Date.now() - started }));
