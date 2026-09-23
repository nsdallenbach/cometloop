import { isProviderKind, providerFor } from './providers';
import { resolveCredential } from './credentials';
import { type ChatRequest, type ModelProvider, type ProviderCapabilities, type ProviderConfig, type ProviderKind, type ResolvedModel } from './provider';
import { currentTenantId } from '../db/tenant-context';

/**
 * Per-workspace model configuration (platform-architecture §6, the site's
 * model-providers page). Two tenant-scoped tables:
 *
 *  - `app.model_providers` — one row per provider account the workspace
 *    brought: kind, base URL, the NAME of the credential (never the value),
 *    a default model and adapter extras.
 *  - `app.model_roles` — role → (provider, model). Cometloop never calls
 *    "the model"; it calls a role, and the role is mapped here.
 *
 * Both get `tenant_id` and row-level security from the phase-2 migration
 * (`TENANT_TABLES` in server/db/tenancy.ts), so every read below is already
 * the caller's workspace — the queries never name the tenant.
 *
 * Roles are the capability contract: `ROLE_CONTRACTS` says what each role
 * needs (JSON output, tools, a context window) and `checkContract` refuses a
 * mapping — at save time and again at call time — that cannot meet it, with
 * an error that names the gap.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const MODEL_CONFIG_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.model_providers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT,
    credential_ref TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    extra JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Primary key becomes (tenant_id, role) in server/db/tenancy.ts.
  `CREATE TABLE IF NOT EXISTS app.model_roles (
    role TEXT PRIMARY KEY,
    provider_id INT NOT NULL REFERENCES app.model_providers(id) ON DELETE CASCADE,
    model TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

/** The roles the control plane calls, with the site docs' names. */
export const MODEL_ROLES = ['planning', 'estimate', 'review', 'draft'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface RoleContract {
  label: string;
  usedFor: string;
  /** The role's prompts ask for a JSON object and parse it. */
  json: boolean;
  /** The role drives a tool-calling loop (the board-aware scoping agent). */
  tools: boolean;
  /** Smallest context window that fits the role's prompts, in tokens. */
  contextTokens: number;
}

export const ROLE_CONTRACTS: Record<ModelRole, RoleContract> = {
  planning: {
    label: 'Planning',
    usedFor: 'Writing and refining tickets, parsing SOWs, reworking a ticket from a comment, refining project standards',
    json: true,
    tools: true,
    contextTokens: 100_000,
  },
  estimate: { label: 'Estimate', usedFor: 'Agent and human hour estimates', json: true, tools: false, contextTokens: 16_000 },
  review: { label: 'Review', usedFor: 'The automated first pass on a PR', json: true, tools: false, contextTokens: 100_000 },
  draft: { label: 'Draft', usedFor: 'Status updates and other prose', json: false, tools: false, contextTokens: 16_000 },
};

export function isModelRole(v: unknown): v is ModelRole {
  return typeof v === 'string' && (MODEL_ROLES as readonly string[]).includes(v);
}

/** Current Anthropic ids the one-env-var install maps roles to. */
export const DEFAULT_ANTHROPIC_MODELS: Record<ModelRole, string> = {
  planning: 'claude-sonnet-5',
  review: 'claude-sonnet-5',
  estimate: 'claude-haiku-4-5-20251001',
  draft: 'claude-haiku-4-5-20251001',
};

// ---------- row mapping ----------

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? v : null);

function extraOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

export function mapProviderRow(r: Record<string, unknown>): ProviderConfig {
  const kind = r.kind;
  return {
    id: num(r.id),
    name: txt(r.name),
    kind: isProviderKind(kind) ? kind : 'openai-compatible',
    baseUrl: r.base_url == null || txt(r.base_url) === '' ? null : txt(r.base_url),
    credentialRef: txt(r.credential_ref),
    defaultModel: txt(r.default_model),
    extra: extraOf(r.extra),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface RoleMapping {
  role: ModelRole;
  providerId: number;
  model: string;
  updatedAt: string | null;
}

export async function loadProviders(q: Query): Promise<ProviderConfig[]> {
  const { rows } = await q('SELECT * FROM app.model_providers ORDER BY id');
  return rows.map(mapProviderRow);
}

export async function loadProvider(q: Query, id: number): Promise<ProviderConfig | null> {
  const row = (await q('SELECT * FROM app.model_providers WHERE id = $1', [id])).rows[0];
  return row ? mapProviderRow(row) : null;
}

export async function loadRoleMappings(q: Query): Promise<RoleMapping[]> {
  const { rows } = await q('SELECT role, provider_id, model, updated_at FROM app.model_roles');
  return rows.flatMap((r) => (isModelRole(r.role) ? [{ role: r.role, providerId: num(r.provider_id), model: txt(r.model), updatedAt: iso(r.updated_at) }] : []));
}

export async function saveRoleMapping(q: Query, m: { role: ModelRole; providerId: number; model: string }): Promise<void> {
  await q(
    `INSERT INTO app.model_roles (role, provider_id, model) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, role) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model, updated_at = NOW()`,
    [m.role, m.providerId, m.model],
  );
}

// ---------- capability contract ----------

/** What a request actually needs of the model, on top of the role's floor. */
export function requestNeeds(role: ModelRole, request: Pick<ChatRequest, 'json' | 'tools'>): { json: boolean; tools: boolean; contextTokens: number } {
  const c = ROLE_CONTRACTS[role];
  return { json: request.json === true, tools: (request.tools?.length ?? 0) > 0, contextTokens: c.contextTokens };
}

/**
 * Why a model cannot serve a role — or null when it can. Used at save time
 * (with the role's declared needs) and at call time (with the request's).
 */
export function checkContract(
  role: ModelRole,
  needs: { json: boolean; tools: boolean; contextTokens: number },
  caps: ProviderCapabilities,
  label: string,
): string | null {
  const gaps: string[] = [];
  if (needs.json && !caps.json) gaps.push('JSON output');
  if (needs.tools && !caps.tools) gaps.push('tool use');
  if (caps.contextTokens < needs.contextTokens) gaps.push(`a ${fmtK(needs.contextTokens)} context window (has ${fmtK(caps.contextTokens)})`);
  if (gaps.length === 0) return null;
  return `${label} cannot serve the ${ROLE_CONTRACTS[role].label.toLowerCase()} role: it lacks ${gaps.join(', ')}`;
}

const fmtK = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// ---------- resolution ----------

export interface ResolvedRole {
  adapter: ModelProvider;
  config: ProviderConfig;
  model: string;
  capabilities: ProviderCapabilities;
}

/** The Cloudflare AI Gateway base for this process, if any (`AI_GATEWAY_URL`). */
export function gatewayBaseUrl(): string | null {
  const v = process.env.AI_GATEWAY_URL?.trim();
  return v ? v.replace(/\/+$/, '') : null;
}

/** Build the per-call object an adapter takes, resolving the row's credential by name. */
export async function resolveModel(config: ProviderConfig, model: string, metadata: Record<string, string>): Promise<ResolvedModel> {
  return {
    provider: config,
    model,
    credential: await resolveCredential(config.credentialRef),
    gatewayBaseUrl: gatewayBaseUrl(),
    metadata: { tenant: currentTenantId() ?? '', ...metadata },
  };
}

/** Capabilities of one model on a row, without a credential lookup. */
export function capabilitiesOf(config: ProviderConfig, model: string): ProviderCapabilities {
  const adapter = providerFor(config.kind);
  return adapter.capabilitiesFor({ provider: config, model, credential: null, gatewayBaseUrl: null, metadata: {} });
}

/**
 * The provider and model mapped to a role for the current tenant, or null
 * when the role is unmapped (and no provider could be auto-registered).
 * `modelOverride` lets a caller pin the model on the role's provider — the
 * PR reviewer uses it for a project's registered review endpoint.
 */
export async function resolveRole(q: Query, role: ModelRole, opts: { modelOverride?: string } = {}): Promise<ResolvedRole | null> {
  await ensureTenantLlmDefaults(q);
  const row = (
    await q(
      `SELECT r.model AS role_model, p.* FROM app.model_roles r JOIN app.model_providers p ON p.id = r.provider_id WHERE r.role = $1`,
      [role],
    )
  ).rows[0];
  if (!row) return null;
  const config = mapProviderRow(row);
  const model = opts.modelOverride?.trim() || txt(row.role_model) || config.defaultModel;
  if (!model) return null;
  const adapter = providerFor(config.kind);
  return { adapter, config, model, capabilities: capabilitiesOf(config, model) };
}

// ---------- defaults: a fresh install works with one env var ----------

const defaultsChecked = new Set<string>();

/** Test seam / after a delete: let the next resolve re-check the tenant. */
export function resetTenantDefaults(tenantId?: string): void {
  if (tenantId) defaultsChecked.delete(tenantId);
  else defaultsChecked.clear();
}

/** After an admin removes the last provider, do not re-seed it behind their back until the process restarts. */
export function markTenantDefaultsChecked(tenantId: string): void {
  defaultsChecked.add(tenantId);
}

/**
 * Seed nothing by default. If the tenant has no providers and the process
 * has `ANTHROPIC_API_KEY`, register an Anthropic provider whose credential
 * is that variable's NAME and map every role to a sensible Claude model; if
 * instead it has the Databricks workspace pair and a serving endpoint name,
 * register that endpoint (the pre-phase-3 deployment shape). Idempotent and
 * checked once per tenant per process.
 */
export async function ensureTenantLlmDefaults(q: Query): Promise<'anthropic' | 'databricks' | null> {
  const tenant = currentTenantId() ?? '';
  if (defaultsChecked.has(tenant)) return null;
  defaultsChecked.add(tenant);
  try {
    const count = num((await q('SELECT COUNT(*)::int AS n FROM app.model_providers')).rows[0]?.n);
    if (count > 0) return null;
    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      const id = await insertProvider(q, {
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: null,
        credentialRef: 'ANTHROPIC_API_KEY',
        defaultModel: DEFAULT_ANTHROPIC_MODELS.planning,
        extra: { preset: 'anthropic', autoRegistered: true },
      });
      for (const role of MODEL_ROLES) await saveRoleMapping(q, { role, providerId: id, model: DEFAULT_ANTHROPIC_MODELS[role] });
      console.log(`[llm] registered the Anthropic provider from ANTHROPIC_API_KEY for tenant ${tenant || '(none)'} — every role mapped`);
      return 'anthropic';
    }
    const endpoint = process.env.DATABRICKS_SERVING_ENDPOINT_NAME?.trim();
    const host = process.env.DATABRICKS_HOST?.trim();
    const clientId = process.env.DATABRICKS_CLIENT_ID?.trim();
    if (endpoint && host && clientId && process.env.DATABRICKS_CLIENT_SECRET?.trim()) {
      const id = await insertProvider(q, {
        name: 'Databricks Model Serving',
        kind: 'databricks',
        baseUrl: host,
        credentialRef: 'DATABRICKS_CLIENT_SECRET',
        defaultModel: endpoint,
        extra: { preset: 'databricks', clientId, autoRegistered: true },
      });
      for (const role of MODEL_ROLES) await saveRoleMapping(q, { role, providerId: id, model: endpoint });
      console.log(`[llm] registered the workspace serving endpoint ${endpoint} as the provider for tenant ${tenant || '(none)'} — every role mapped`);
      return 'databricks';
    }
    return null;
  } catch (err) {
    // A failed seed must never fail the call that triggered it; the caller's
    // fallback applies and the next process start tries again.
    defaultsChecked.delete(tenant);
    console.warn('[llm] provider auto-registration failed:', (err as Error).message);
    return null;
  }
}

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  credentialRef: string;
  defaultModel: string;
  extra: Record<string, unknown>;
}

export async function insertProvider(q: Query, p: ProviderInput): Promise<number> {
  const { rows } = await q(
    `INSERT INTO app.model_providers (name, kind, base_url, credential_ref, default_model, extra)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.name, p.kind, p.baseUrl, p.credentialRef, p.defaultModel, JSON.stringify(p.extra)],
  );
  return num(rows[0]?.id);
}

export async function updateProvider(q: Query, id: number, p: ProviderInput): Promise<boolean> {
  const { rows } = await q(
    `UPDATE app.model_providers SET name = $2, kind = $3, base_url = $4, credential_ref = $5, default_model = $6, extra = $7, updated_at = NOW()
     WHERE id = $1 RETURNING id`,
    [id, p.name, p.kind, p.baseUrl, p.credentialRef, p.defaultModel, JSON.stringify(p.extra)],
  );
  return rows.length > 0;
}
