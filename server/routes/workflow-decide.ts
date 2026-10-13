import { envWorkspaceAuth, workspaceToken } from '../llm/providers/databricks';
import { invokeModel } from './llm-health';

/**
 * The Decide node's brain: a typed decision — one of the node's choices —
 * made from the event by a decision model. Three providers, tried in order
 * under `auto`:
 *
 *  1. Jev (TypeSafe's System One): `POST /v1/systemone` with the state and
 *     one `choice` question; answers in well under a second with a choice,
 *     per-option probabilities and a confidence. Needs `TYPESAFE_API_KEY`
 *     (`TYPESAFE_API_URL` overrides the endpoint).
 *  2. Databricks `ai_decide()`: the same model behind a SQL function, run on
 *     a SQL warehouse through the Statement Execution API. Needs the
 *     workspace service principal (`DATABRICKS_HOST` / `_CLIENT_ID` /
 *     `_CLIENT_SECRET`) and `DATABRICKS_WAREHOUSE_ID`.
 *  3. The workspace's configured model through `invokeModel('review', …)`,
 *     asked for a JSON object naming the choice.
 *
 * When nothing answers, the first choice wins with confidence 0 and the step
 * says so — a decision model outage must degrade a workflow, never break it
 * (development-standards: every model call has a deterministic fallback).
 */

export interface Choice {
  label: string;
  description: string;
}

export interface Decision {
  choice: string;
  /** 0–1; 0 when the fallback decided. */
  confidence: number;
  probabilities: Record<string, number>;
  provider: 'jev' | 'databricks' | 'model' | 'fallback';
  /** Why a provider was skipped or failed, for the run's step log. */
  notes: string[];
}

export type DecideProvider = 'auto' | 'jev' | 'databricks' | 'model';

export interface DecideDeps {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  invoke: typeof invokeModel;
  /** The workspace token for Databricks, or null when the SP is not configured. */
  databricksToken: () => Promise<{ base: string; token: string } | null>;
}

const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';
const TIMEOUT_MS = 20_000;

export const defaultDecideDeps = (): DecideDeps => ({
  fetch: (input, init) => fetch(input, init),
  env: process.env,
  invoke: invokeModel,
  databricksToken: async () => {
    const auth = envWorkspaceAuth();
    if (!auth) return null;
    const token = await workspaceToken(auth);
    return token ? { base: auth.base, token } : null;
  },
});

/** Which providers this process can reach, for the builder's inspector. */
export function decideProviders(env: NodeJS.ProcessEnv = process.env): { jev: boolean; databricks: boolean } {
  return {
    jev: Boolean(env.TYPESAFE_API_KEY?.trim()),
    databricks: Boolean(env.DATABRICKS_HOST && env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_SECRET && env.DATABRICKS_WAREHOUSE_ID?.trim()),
  };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Map a provider's answer back onto the node's labels (case-insensitive), or null when it named none of them. */
function pick(choices: Choice[], raw: unknown, probs: unknown, confidence: unknown): Omit<Decision, 'provider' | 'notes'> | null {
  const label = typeof raw === 'string' ? choices.find((c) => c.label.toLowerCase() === raw.trim().toLowerCase())?.label : undefined;
  if (!label) return null;
  const probabilities: Record<string, number> = {};
  if (probs && typeof probs === 'object') {
    for (const [k, v] of Object.entries(probs as Record<string, unknown>)) {
      const match = choices.find((c) => c.label.toLowerCase() === k.toLowerCase());
      if (match) probabilities[match.label] = Math.max(0, Math.min(1, num(v)));
    }
  }
  const conf = confidence === undefined || confidence === null ? (probabilities[label] ?? 1) : num(confidence);
  return { choice: label, confidence: Math.max(0, Math.min(1, conf)), probabilities };
}

const criteria = (choices: Choice[]): Record<string, string> => Object.fromEntries(choices.map((c) => [c.label, c.description || c.label]));

async function viaJev(state: unknown, question: string, choices: Choice[], deps: DecideDeps): Promise<Omit<Decision, 'provider' | 'notes'>> {
  const key = deps.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error('TYPESAFE_API_KEY is not set');
  const resp = await deps.fetch(deps.env.TYPESAFE_API_URL?.trim() || JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: deps.env.TYPESAFE_MODEL?.trim() || JEV_MODEL,
      state,
      questions: { answer: { type: 'choice', instructions: question, criteria: criteria(choices) } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Jev answered ${resp.status}`);
  const data = (await resp.json()) as { answers?: { answer?: { choice?: unknown; probabilities?: unknown; confidence?: unknown } } };
  const a = data.answers?.answer;
  const picked = a ? pick(choices, a.choice, a.probabilities, a.confidence) : null;
  if (!picked) throw new Error('Jev named no known choice');
  return picked;
}

async function viaDatabricks(state: unknown, question: string, choices: Choice[], deps: DecideDeps): Promise<Omit<Decision, 'provider' | 'notes'>> {
  const warehouse = deps.env.DATABRICKS_WAREHOUSE_ID?.trim();
  if (!warehouse) throw new Error('DATABRICKS_WAREHOUSE_ID is not set');
  const auth = await deps.databricksToken();
  if (!auth) throw new Error('the workspace service principal is not configured');
  // `questions` must be a constant: inlined as a single-quoted SQL literal.
  const questions = JSON.stringify({ answer: { type: 'choice', instructions: question, criteria: criteria(choices) } }).replace(/'/g, "''");
  const resp = await deps.fetch(`${auth.base}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      warehouse_id: warehouse,
      statement: `SELECT to_json(ai_decide(:state, '${questions}', map('version', '1.0'))) AS r`,
      parameters: [{ name: 'state', type: 'STRING', value: typeof state === 'string' ? state : JSON.stringify(state) }],
      wait_timeout: '30s',
      on_wait_timeout: 'CANCEL',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS + 15_000),
  });
  if (!resp.ok) throw new Error(`Databricks answered ${resp.status}`);
  const data = (await resp.json()) as { status?: { state?: string; error?: { message?: string } }; result?: { data_array?: unknown[][] } };
  if (data.status?.state !== 'SUCCEEDED') throw new Error(`statement ${data.status?.state ?? 'failed'}${data.status?.error?.message ? `: ${data.status.error.message}` : ''}`);
  const cell = data.result?.data_array?.[0]?.[0];
  const parsed = (typeof cell === 'string' ? JSON.parse(cell) : cell) as { response?: { answers?: { answer?: { choice?: unknown; probabilities?: unknown; confidence?: unknown } } }; error_message?: unknown };
  if (parsed?.error_message) throw new Error(typeof parsed.error_message === 'string' ? parsed.error_message : JSON.stringify(parsed.error_message));
  const a = parsed?.response?.answers?.answer;
  const picked = a ? pick(choices, a.choice, a.probabilities, a.confidence) : null;
  if (!picked) throw new Error('ai_decide named no known choice');
  return picked;
}

async function viaModel(state: unknown, question: string, choices: Choice[], deps: DecideDeps): Promise<Omit<Decision, 'provider' | 'notes'>> {
  const prompt = [
    'You are a decision function inside an automation. Read the state and answer the question by choosing exactly one of the allowed choices.',
    `Question: ${question}`,
    'Allowed choices:',
    ...choices.map((c) => `- ${c.label}${c.description ? `: ${c.description}` : ''}`),
    'State:',
    typeof state === 'string' ? state : JSON.stringify(state, null, 1),
    'Reply with ONLY a JSON object: {"choice": "<one of the allowed labels>", "confidence": <0..1>}',
  ].join('\n\n');
  const response = await deps.invoke('review', { messages: [{ role: 'user', content: prompt }], maxTokens: 120, json: true }, { flow: 'workflow-decide' });
  const m = /\{[\s\S]*\}/.exec(response.text);
  const parsed = m ? (JSON.parse(m[0]) as { choice?: unknown; confidence?: unknown }) : {};
  const picked = pick(choices, parsed.choice, null, parsed.confidence);
  if (!picked) throw new Error('the model named no known choice');
  return picked;
}

export async function decide(
  input: { state: unknown; question: string; choices: Choice[]; provider?: DecideProvider },
  deps: DecideDeps = defaultDecideDeps(),
): Promise<Decision> {
  const notes: string[] = [];
  if (input.choices.length === 0) return { choice: '', confidence: 0, probabilities: {}, provider: 'fallback', notes: ['no choices configured'] };
  const want = input.provider ?? 'auto';
  const order: ('jev' | 'databricks' | 'model')[] = want === 'auto' ? ['jev', 'databricks', 'model'] : [want];
  for (const provider of order) {
    try {
      const result =
        provider === 'jev'
          ? await viaJev(input.state, input.question, input.choices, deps)
          : provider === 'databricks'
            ? await viaDatabricks(input.state, input.question, input.choices, deps)
            : await viaModel(input.state, input.question, input.choices, deps);
      return { ...result, provider, notes };
    } catch (err) {
      notes.push(`${provider}: ${(err as Error).message}`);
    }
  }
  return { choice: input.choices[0].label, confidence: 0, probabilities: {}, provider: 'fallback', notes: [...notes, `fell back to the first choice, ${input.choices[0].label}`] };
}
