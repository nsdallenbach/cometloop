import type express from 'express';

/**
 * Model catalog for the Agents page (DAT-278): what the model picker offers.
 *
 * Two lists, because "the model" means two different things:
 *  - Endpoint-backed agents (Agent Bricks, model serving) run ON a workspace
 *    serving endpoint — the picker lists the chat-capable endpoints the
 *    workspace exposes (Foundation Model APIs like databricks-gpt-6-astra or
 *    databricks-claude-opus-5, plus custom / Agent Bricks endpoints).
 *  - Runners drive a coding harness whose CLI takes a model id
 *    (`claude --model claude-opus-5`, `codex -m gpt-5.3-codex`). Those ids
 *    are the harness vendor's, not the workspace's, so they are a static table.
 *
 * The workspace list is read through the SDK's default auth chain (the app's
 * service principal when deployed, the developer's CLI profile locally) and
 * cached for a few minutes. When it cannot be read the route still answers with
 * the static fallback and says so (`source: 'static'`) — a model picker that
 * blanks because a list call failed would block registering an agent.
 */

export interface ServingEndpointOption {
  name: string;
  servedModel: string | null;
  task: string | null;
  provider: string | null;
  ready: boolean;
}

export interface HarnessModelOption {
  id: string;
  label: string;
  provider: string;
  default?: boolean;
}

export interface AgentModelCatalog {
  source: 'workspace' | 'static';
  servingEndpoints: ServingEndpointOption[];
  harnessModels: Record<string, HarnessModelOption[]>;
}

/**
 * Model ids the harness CLIs accept. Claude Code takes the family aliases the
 * team uses in conversation (fable / opus / sonnet); Codex takes OpenAI ids.
 * Other harnesses have no vetted list yet — the picker falls back to free text.
 */
export const HARNESS_MODELS: Record<string, HarnessModelOption[]> = {
  'claude-code': [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', default: true },
    { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  ],
  codex: [
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', provider: 'openai', default: true },
    { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', provider: 'openai' },
    { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
  ],
};

/**
 * Model provider from a served-model or endpoint name, for the logo next to
 * the model. Only families the console brands get a provider id; everything
 * else is 'databricks' (it is served by the workspace, whoever trained it).
 */
export function providerForModel(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('claude')) return 'anthropic';
  if (n.includes('gpt') || n.includes('codex') || n.includes('o1') || n.includes('o3')) return 'openai';
  if (n.includes('gemini') || n.includes('gemma')) return 'google';
  if (n.includes('llama')) return 'meta';
  if (n.includes('grok')) return 'xai';
  if (n.includes('deepseek')) return 'deepseek';
  if (n.includes('qwen')) return 'alibaba';
  if (n.includes('kimi')) return 'moonshot';
  if (n.includes('glm')) return 'zhipu';
  return 'databricks';
}

/** Endpoint tasks an agent can be built on — chat models and agent endpoints, not embeddings. */
const AGENT_TASKS = new Set(['llm/v1/chat', 'agent/v1/responses', 'agent/v1/chat', 'agent/v2/responses']);

/**
 * The Foundation Model API endpoints every workspace ships, for when the live
 * list cannot be read. Kept to families the team actually picks; the live list
 * is the real catalog.
 */
export const STATIC_SERVING_ENDPOINTS: ServingEndpointOption[] = [
  'databricks-claude-opus-5',
  'databricks-claude-sonnet-5',
  'databricks-claude-haiku-4-5',
  'databricks-gpt-6-astra',
  'databricks-gpt-5-6-luna',
  'databricks-gpt-5-6-terra',
  'databricks-gpt-5-6-sol',
  'databricks-gpt-5-5',
  'databricks-gpt-5-3-codex',
  'databricks-gemini-3-8-flash',
  'databricks-gemini-2-5-pro',
  'databricks-llama-4-maverick',
].map((name) => ({ name, servedModel: name, task: 'llm/v1/chat', provider: providerForModel(name), ready: true }));

/** `system.ai.databricks-claude-opus-5` → `databricks-claude-opus-5`. */
const shortModel = (entity: string | null | undefined): string | null => {
  if (!entity) return null;
  const parts = entity.split('.');
  return parts[parts.length - 1] || entity;
};

let cache: { at: number; endpoints: ServingEndpointOption[] } | null = null;
const CACHE_MS = 5 * 60_000;
let loggedNoWorkspace = false;

/** Chat/agent endpoints from the workspace, or null when the list cannot be read. */
export async function listAgentEndpoints(): Promise<ServingEndpointOption[] | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.endpoints;
  // No workspace, no SDK: outside Databricks the AppKit client is never
  // loaded and the picker runs on the static catalog.
  if (!process.env.DATABRICKS_HOST) {
    if (!loggedNoWorkspace) {
      loggedNoWorkspace = true;
      console.log('[agents] DATABRICKS_HOST not set — serving endpoint list off, using the static model catalog');
    }
    return null;
  }
  try {
    const { getWorkspaceClient } = await import('@databricks/appkit');
    const w = getWorkspaceClient({});
    const out: ServingEndpointOption[] = [];
    for await (const ep of w.servingEndpoints.list()) {
      if (!ep.name) continue;
      const task = ep.task ?? null;
      if (task && !AGENT_TASKS.has(task)) continue;
      const entity = ep.config?.served_entities?.[0];
      const servedModel = shortModel(entity?.entity_name ?? entity?.foundation_model?.name ?? entity?.name ?? null);
      out.push({
        name: ep.name,
        servedModel,
        task,
        provider: providerForModel(servedModel ?? ep.name),
        ready: ep.state?.ready === 'READY',
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    cache = { at: Date.now(), endpoints: out };
    return out;
  } catch (err) {
    console.warn('[agents] serving endpoint list unavailable, using the static model catalog:', (err as Error).message);
    return null;
  }
}

export async function loadModelCatalog(): Promise<AgentModelCatalog> {
  const live = await listAgentEndpoints();
  return {
    source: live ? 'workspace' : 'static',
    servingEndpoints: live ?? STATIC_SERVING_ENDPOINTS,
    harnessModels: HARNESS_MODELS,
  };
}

export function setupAgentModelRoutes(app: express.Application) {
  app.get('/api/agents/models', async (_req, res) => {
    try {
      res.json(await loadModelCatalog());
    } catch (err) {
      console.error('agent model catalog failed:', err);
      res.status(500).json({ error: 'Failed to load the model catalog' });
    }
  });
}
