import { describe, expect, it, vi } from 'vitest';
import { decide, decideProviders, type DecideDeps } from './workflow-decide';

const choices = [
  { label: 'bug', description: 'something broke' },
  { label: 'feature', description: 'new behaviour' },
  { label: 'chore', description: 'housekeeping' },
];

const jsonResponse = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function deps(over: Partial<DecideDeps> = {}): DecideDeps {
  return {
    fetch: vi.fn().mockRejectedValue(new Error('no network in tests')),
    env: {},
    invoke: vi.fn().mockRejectedValue(new Error('no model in tests')),
    databricksToken: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

describe('decide — Jev', () => {
  it('sends one choice question with the labels as criteria and maps the answer back', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { model: 'jev-1.13.0', answers: { answer: { type: 'choice', choice: 'Feature', probabilities: { bug: 0.1, feature: 0.85, chore: 0.05 }, confidence: 0.8 } } }));
    const d = await decide({ state: 'Add dark mode', question: 'What kind of work?', choices }, deps({ fetch, env: { TYPESAFE_API_KEY: 'k' } }));
    expect(d).toMatchObject({ choice: 'feature', confidence: 0.8, provider: 'jev', probabilities: { feature: 0.85, bug: 0.1, chore: 0.05 } });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body as string) as { model: string; state: string; questions: { answer: { type: string; instructions: string; criteria: Record<string, string> } } };
    expect(body.model).toBe('jev-latest');
    expect(body.state).toBe('Add dark mode');
    expect(body.questions.answer).toEqual({ type: 'choice', instructions: 'What kind of work?', criteria: { bug: 'something broke', feature: 'new behaviour', chore: 'housekeeping' } });
  });

  it('is skipped without a key, and the note says so', async () => {
    const d = await decide({ state: 'x', question: 'q', choices, provider: 'jev' }, deps());
    expect(d.provider).toBe('fallback');
    expect(d.choice).toBe('bug');
    expect(d.confidence).toBe(0);
    expect(d.notes[0]).toContain('TYPESAFE_API_KEY');
  });
});

describe('decide — Databricks ai_decide', () => {
  it('runs ai_decide on the warehouse through the statement API and reads the VARIANT back', async () => {
    const cell = JSON.stringify({ response: { answers: { answer: { type: 'choice', choice: 'chore', probabilities: { chore: 0.7, bug: 0.2, feature: 0.1 }, confidence: 0.66 } } }, error_message: null });
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { status: { state: 'SUCCEEDED' }, result: { data_array: [[cell]] } }));
    const d = await decide(
      { state: { title: 'Bump deps' }, question: 'Kind?', choices, provider: 'databricks' },
      deps({ fetch, env: { DATABRICKS_WAREHOUSE_ID: 'wh1' }, databricksToken: vi.fn().mockResolvedValue({ base: 'https://dbc.example.com', token: 't' }) }),
    );
    expect(d).toMatchObject({ choice: 'chore', provider: 'databricks', confidence: 0.66 });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://dbc.example.com/api/2.0/sql/statements');
    const body = JSON.parse(init.body as string) as { warehouse_id: string; statement: string; parameters: { name: string; value: string }[] };
    expect(body.warehouse_id).toBe('wh1');
    expect(body.statement).toContain('ai_decide(:state,');
    expect(body.statement).toContain('"type":"choice"');
    expect(body.parameters[0]).toEqual({ name: 'state', type: 'STRING', value: '{"title":"Bump deps"}' });
  });

  it('reports a failed statement and falls through under auto', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { status: { state: 'FAILED', error: { message: 'ai_decide is not available in this region' } } }));
    const invoke = vi.fn().mockResolvedValue({ text: '{"choice":"bug","confidence":0.5}', toolCalls: [], usage: {}, model: 'm', provider: 'anthropic' });
    const d = await decide(
      { state: 'Login 500s', question: 'Kind?', choices },
      deps({ fetch, invoke, env: { DATABRICKS_WAREHOUSE_ID: 'wh1' }, databricksToken: vi.fn().mockResolvedValue({ base: 'https://dbc.example.com', token: 't' }) }),
    );
    expect(d.provider).toBe('model');
    expect(d.choice).toBe('bug');
    expect(d.notes).toEqual([expect.stringContaining('jev: TYPESAFE_API_KEY'), expect.stringContaining('databricks: statement FAILED: ai_decide is not available')]);
  });
});

describe('decide — the configured model and the last resort', () => {
  it('asks the review role for a JSON choice', async () => {
    const invoke = vi.fn().mockResolvedValue({ text: 'Sure: {"choice": "FEATURE", "confidence": 0.9}', toolCalls: [], usage: {}, model: 'm', provider: 'anthropic' });
    const d = await decide({ state: 'x', question: 'q', choices, provider: 'model' }, deps({ invoke }));
    expect(d).toMatchObject({ choice: 'feature', confidence: 0.9, provider: 'model' });
    expect(invoke.mock.calls[0][0]).toBe('review');
  });

  it('never throws: with every provider down the first choice wins with confidence 0', async () => {
    const d = await decide({ state: 'x', question: 'q', choices }, deps());
    expect(d).toMatchObject({ choice: 'bug', confidence: 0, provider: 'fallback' });
    expect(d.notes[d.notes.length - 1]).toContain('fell back to the first choice');
  });

  it('rejects an answer that names none of the choices and moves on', async () => {
    const invoke = vi.fn().mockResolvedValue({ text: '{"choice": "banana"}', toolCalls: [], usage: {}, model: 'm', provider: 'anthropic' });
    const d = await decide({ state: 'x', question: 'q', choices, provider: 'model' }, deps({ invoke }));
    expect(d.provider).toBe('fallback');
    expect(d.notes[0]).toContain('named no known choice');
  });
});

describe('decideProviders', () => {
  it('reports what the environment can reach', () => {
    expect(decideProviders({})).toEqual({ jev: false, databricks: false });
    expect(decideProviders({ TYPESAFE_API_KEY: 'k' })).toEqual({ jev: true, databricks: false });
    expect(decideProviders({ DATABRICKS_HOST: 'h', DATABRICKS_CLIENT_ID: 'c', DATABRICKS_CLIENT_SECRET: 's', DATABRICKS_WAREHOUSE_ID: 'w' })).toEqual({ jev: false, databricks: true });
  });
});
