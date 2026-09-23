import type express from 'express';
import { z } from 'zod';
import type { Caller } from './roles';
import { currentTenantId } from '../db/tenant-context';
import {
  MODEL_ROLES,
  ROLE_CONTRACTS,
  capabilitiesOf,
  checkContract,
  insertProvider,
  isModelRole,
  loadProvider,
  loadProviders,
  loadRoleMappings,
  markTenantDefaultsChecked,
  saveRoleMapping,
  updateProvider,
  type ModelRole,
  type ProviderInput,
} from '../llm/config';
import { credentialStatus, isValidCredentialRef } from '../llm/credentials';
import { LIVE_PROVIDER_KINDS } from '../llm/providers';
import { PROVIDER_KINDS, type ProviderConfig } from '../llm/provider';
import { probeModel } from './llm-health';

/**
 * Workspace model settings (platform-architecture §6; the site's
 * model-providers page): the providers a workspace brought, the role → model
 * map, and a test button. Admin-only — providers are workspace governance
 * (security.md, "Roles"), never runner configuration.
 *
 * Nothing here ever returns or stores a secret: a provider row carries the
 * NAME of its credential, and the API reports only where that name resolves
 * (`env`, `key-vault`, `missing`). `extra` is allow-listed per key so a key
 * pasted into the wrong field cannot land in the database.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type RequireAdmin = (req: express.Request, res: express.Response) => Promise<Caller | null>;

/** Adapter settings an admin may store. Anything that could be a secret is not on this list. */
const EXTRA_KEYS = ['preset', 'apiVersion', 'clientId', 'region', 'accessKeyId', 'project', 'location', 'bypassGateway', 'contextTokens', 'gateway', 'autoRegistered'] as const;

function sanitizeExtra(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EXTRA_KEYS) {
    const v = raw[key];
    if (v === undefined || v === null || v === '') continue;
    if (key === 'bypassGateway' || key === 'autoRegistered') {
      if (typeof v === 'boolean') out[key] = v;
    } else if (key === 'contextTokens') {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = Math.round(v);
    } else if (key === 'gateway') {
      if (v && typeof v === 'object') {
        const g = v as { cacheTtl?: unknown; skipCache?: unknown };
        out.gateway = {
          ...(typeof g.cacheTtl === 'number' && g.cacheTtl >= 0 ? { cacheTtl: Math.round(g.cacheTtl) } : {}),
          ...(typeof g.skipCache === 'boolean' ? { skipCache: g.skipCache } : {}),
        };
      }
    } else if (typeof v === 'string' && v.length <= 200) {
      out[key] = v;
    }
  }
  return out;
}

const CredentialRef = z
  .string()
  .trim()
  .max(127)
  .refine((v) => v === '' || isValidCredentialRef(v), 'credentialRef: letters, digits, dots, dashes and underscores only — the NAME of the secret, never the secret');

const ProviderBody = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(PROVIDER_KINDS),
  baseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'baseUrl must be an http(s) URL')
    .nullable()
    .default(null),
  credentialRef: CredentialRef.default(''),
  defaultModel: z.string().trim().max(200).default(''),
  extra: z.record(z.string(), z.unknown()).default({}),
});

const TestBody = z.object({ model: z.string().trim().max(200).optional() });

const RolesBody = z.object({
  roles: z
    .array(
      z.object({
        role: z.enum(MODEL_ROLES),
        providerId: z.number().int().positive().nullable(),
        model: z.string().trim().max(200).default(''),
      }),
    )
    .min(1)
    .max(MODEL_ROLES.length),
});

const toInput = (b: z.infer<typeof ProviderBody>): ProviderInput => ({
  name: b.name,
  kind: b.kind,
  baseUrl: b.baseUrl || null,
  credentialRef: b.credentialRef,
  defaultModel: b.defaultModel,
  extra: sanitizeExtra(b.extra),
});

async function providerJson(p: ProviderConfig, roles: { role: ModelRole; providerId: number; model: string }[]) {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    live: LIVE_PROVIDER_KINDS.includes(p.kind),
    baseUrl: p.baseUrl,
    credentialRef: p.credentialRef,
    credential: p.credentialRef ? await credentialStatus(p.credentialRef) : 'missing',
    defaultModel: p.defaultModel,
    extra: p.extra,
    roles: roles.filter((r) => r.providerId === p.id).map((r) => ({ role: r.role, model: r.model })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function roleJson(role: ModelRole, mapping: { providerId: number; model: string } | undefined, providers: ProviderConfig[]) {
  const c = ROLE_CONTRACTS[role];
  const provider = mapping ? providers.find((p) => p.id === mapping.providerId) : undefined;
  const model = mapping?.model || provider?.defaultModel || '';
  const gap = provider && model ? checkContract(role, c, capabilitiesOf(provider, model), `${provider.name} / ${model}`) : null;
  return {
    role,
    label: c.label,
    usedFor: c.usedFor,
    contract: { json: c.json, tools: c.tools, contextTokens: c.contextTokens },
    providerId: provider?.id ?? null,
    model: provider ? model : '',
    gap,
  };
}

export function setupModelSettingsRoutes(app: express.Application, q: Query, requireAdmin: RequireAdmin): void {
  const notFound = (res: express.Response) => res.status(404).json({ error: 'Provider not found' });

  app.get('/api/settings/providers', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const [providers, roles] = await Promise.all([loadProviders(q), loadRoleMappings(q)]);
      res.json({
        providers: await Promise.all(providers.map((p) => providerJson(p, roles))),
        kinds: PROVIDER_KINDS.map((kind) => ({ kind, live: LIVE_PROVIDER_KINDS.includes(kind) })),
        gateway: Boolean(process.env.AI_GATEWAY_URL),
        keyVault: Boolean(process.env.AZURE_KEY_VAULT_URL),
      });
    } catch (err) {
      console.error('providers list failed:', err);
      res.status(500).json({ error: 'Failed to load model providers' });
    }
  });

  app.post('/api/settings/providers', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = ProviderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid provider' });
      return;
    }
    try {
      const id = await insertProvider(q, toInput(parsed.data));
      const created = await loadProvider(q, id);
      if (!created) throw new Error('insert returned no row');
      res.status(201).json(await providerJson(created, []));
    } catch (err) {
      console.error('provider create failed:', err);
      res.status(500).json({ error: 'Failed to save the provider' });
    }
  });

  app.put('/api/settings/providers/:id', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = ProviderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid provider' });
      return;
    }
    try {
      const id = Number(req.params.id);
      const current = await loadProvider(q, id);
      if (!current) {
        notFound(res);
        return;
      }
      // An edited auto-registered row is the admin's now.
      const input = toInput(parsed.data);
      delete input.extra.autoRegistered;
      if (!(await updateProvider(q, id, input))) {
        notFound(res);
        return;
      }
      const updated = await loadProvider(q, id);
      const roles = await loadRoleMappings(q);
      res.json(await providerJson(updated ?? current, roles));
    } catch (err) {
      console.error('provider update failed:', err);
      res.status(500).json({ error: 'Failed to save the provider' });
    }
  });

  app.delete('/api/settings/providers/:id', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const id = Number(req.params.id);
      const { rows } = await q('DELETE FROM app.model_providers WHERE id = $1 RETURNING id', [id]);
      if (rows.length === 0) {
        notFound(res);
        return;
      }
      // Roles that pointed at it are gone with it (ON DELETE CASCADE).
      const remaining = await loadProviders(q);
      if (remaining.length === 0) markTenantDefaultsChecked(currentTenantId() ?? '');
      res.json({ ok: true, remaining: remaining.length });
    } catch (err) {
      console.error('provider delete failed:', err);
      res.status(500).json({ error: 'Failed to remove the provider' });
    }
  });

  /** Test an unsaved provider (the wizard's Test step): same probe, nothing written. */
  app.post('/api/settings/providers/test', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = ProviderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid provider' });
      return;
    }
    const input = toInput(parsed.data);
    if (!input.defaultModel) {
      res.status(400).json({ error: 'Name a model to test' });
      return;
    }
    const draft: ProviderConfig = { id: 0, ...input, createdAt: null, updatedAt: null };
    const result = await probeModel(draft, input.defaultModel);
    res.status(result.ok ? 200 : 502).json({ ...result, provider: draft.kind, requestedModel: input.defaultModel });
  });

  /** One tiny call at the provider with the given (or default) model: latency and the model that answered. */
  app.post('/api/settings/providers/:id/test', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = TestBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid test request' });
      return;
    }
    try {
      const provider = await loadProvider(q, Number(req.params.id));
      if (!provider) {
        notFound(res);
        return;
      }
      const model = parsed.data.model || provider.defaultModel;
      if (!model) {
        res.status(400).json({ error: 'Name a model to test' });
        return;
      }
      const result = await probeModel(provider, model);
      res.status(result.ok ? 200 : 502).json({ ...result, provider: provider.kind, requestedModel: model });
    } catch (err) {
      console.error('provider test failed:', err);
      res.status(500).json({ error: 'Failed to test the provider' });
    }
  });

  app.get('/api/settings/model-roles', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    try {
      const [providers, mappings] = await Promise.all([loadProviders(q), loadRoleMappings(q)]);
      res.json({ roles: MODEL_ROLES.map((role) => roleJson(role, mappings.find((m) => m.role === role), providers)) });
    } catch (err) {
      console.error('model roles failed:', err);
      res.status(500).json({ error: 'Failed to load model roles' });
    }
  });

  /**
   * Save one or more role mappings. Each is checked against the role's
   * capability contract first — a model that cannot answer with JSON, call
   * tools, or fit the role's context floor is refused with the gap named,
   * and nothing is written.
   */
  app.put('/api/settings/model-roles', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const parsed = RolesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid role map' });
      return;
    }
    try {
      const providers = await loadProviders(q);
      const writes: { role: ModelRole; providerId: number | null; model: string }[] = [];
      for (const r of parsed.data.roles) {
        if (!isModelRole(r.role)) continue;
        if (r.providerId === null) {
          writes.push({ role: r.role, providerId: null, model: '' });
          continue;
        }
        const provider = providers.find((p) => p.id === r.providerId);
        if (!provider) {
          res.status(404).json({ error: `Provider ${String(r.providerId)} not found` });
          return;
        }
        const model = r.model || provider.defaultModel;
        if (!model) {
          res.status(400).json({ error: `Name a model for the ${ROLE_CONTRACTS[r.role].label.toLowerCase()} role` });
          return;
        }
        const gap = checkContract(r.role, ROLE_CONTRACTS[r.role], capabilitiesOf(provider, model), `${provider.name} / ${model}`);
        if (gap) {
          res.status(422).json({ error: gap, role: r.role });
          return;
        }
        writes.push({ role: r.role, providerId: provider.id, model });
      }
      for (const w of writes) {
        if (w.providerId === null) await q('DELETE FROM app.model_roles WHERE role = $1', [w.role]);
        else await saveRoleMapping(q, { role: w.role, providerId: w.providerId, model: w.model });
      }
      const mappings = await loadRoleMappings(q);
      res.json({ roles: MODEL_ROLES.map((role) => roleJson(role, mappings.find((m) => m.role === role), providers)) });
    } catch (err) {
      console.error('model roles save failed:', err);
      res.status(500).json({ error: 'Failed to save model roles' });
    }
  });
}
