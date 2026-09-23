import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { LlmHealth, ModelProvider, ModelProviderInput, ModelRole, ModelRoleMapping, ProviderProbe } from '../types';
import { mono } from '../util';
import { MODEL_PROVIDER_PRESETS, modelProviderBrand } from './AgentLogos';

/**
 * Workspace model providers (platform-architecture §6; the site's
 * model-providers page). Three pieces, all visual:
 *
 *  - a grid of provider cards — logo, name, default model, a status dot from
 *    the per-role health probe, the roles the provider serves;
 *  - an "Add provider" wizard — pick a kind from a logo grid, fill the few
 *    fields that kind needs (the credential is a NAME, never a key), test it
 *    with one tiny call, save;
 *  - the role → model table — a provider dropdown and a model per role, with
 *    the role's contract shown and the server's refusal surfaced inline.
 *
 * Admin-only by construction: it lives on the Admin page and every call is
 * behind the admin gate on the server.
 */

const ROLE_ORDER: ModelRole[] = ['planning', 'estimate', 'review', 'draft'];

/** Per-preset defaults the wizard starts from; every field stays editable. */
const PRESET_DEFAULTS: Record<string, { name: string; baseUrl: string; credentialRef: string; models: string[]; extra: Record<string, unknown>; fields: ('baseUrl' | 'apiVersion' | 'clientId' | 'region' | 'project')[] }> = {
  anthropic: { name: 'Anthropic', baseUrl: '', credentialRef: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1'], extra: {}, fields: [] },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', credentialRef: 'OPENAI_API_KEY', models: ['gpt-5.5', 'gpt-5.3-codex', 'gpt-4.1'], extra: {}, fields: ['baseUrl'] },
  'azure-openai': { name: 'Azure OpenAI', baseUrl: 'https://<resource>.openai.azure.com', credentialRef: 'AZURE_OPENAI_API_KEY', models: [], extra: { apiVersion: '2025-04-01-preview' }, fields: ['baseUrl', 'apiVersion'] },
  databricks: { name: 'Databricks Model Serving', baseUrl: 'https://<workspace>.cloud.databricks.com', credentialRef: 'DATABRICKS_CLIENT_SECRET', models: ['databricks-claude-sonnet-5', 'databricks-claude-opus-5', 'databricks-gpt-5-5'], extra: {}, fields: ['baseUrl', 'clientId'] },
  neon: { name: 'Neon AI Gateway', baseUrl: 'https://<gateway>.neon.tech/v1', credentialRef: 'NEON_AI_GATEWAY_KEY', models: [], extra: {}, fields: ['baseUrl'] },
  bedrock: { name: 'AWS Bedrock', baseUrl: '', credentialRef: 'AWS_SECRET_ACCESS_KEY', models: ['anthropic.claude-sonnet-5'], extra: { region: 'us-east-1' }, fields: ['region'] },
  vertex: { name: 'Vertex AI', baseUrl: '', credentialRef: 'GOOGLE_APPLICATION_CREDENTIALS', models: ['gemini-2.5-pro', 'claude-sonnet-5'], extra: { location: 'us-central1' }, fields: ['project'] },
  custom: { name: 'OpenAI-compatible', baseUrl: 'http://localhost:11434/v1', credentialRef: 'LLM_API_KEY', models: [], extra: {}, fields: ['baseUrl'] },
};

const FIELD_LABEL: Record<string, string> = { baseUrl: 'Base URL', apiVersion: 'API version', clientId: 'Service principal client id', region: 'Region', project: 'Project' };

const card: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden' };
const head: React.CSSProperties = { padding: '10px 14px', borderBottom: '1px solid var(--line)', ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', display: 'flex', alignItems: 'center', gap: 10 };
const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 3, color: 'var(--tx)', padding: '7px 9px', fontSize: 12.5 };
const label: React.CSSProperties = { ...mono(400, 9.5), color: 'var(--tx3)', letterSpacing: '.06em', marginBottom: 4 };
const ghostBtn: React.CSSProperties = { border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '5px 10px', fontSize: 11.5, cursor: 'pointer' };
const primaryBtn = (on: boolean): React.CSSProperties => ({ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: on ? 1 : 0.45 });

type Status = 'ok' | 'bad' | 'unknown';
const STATUS_COLOR: Record<Status, string> = { ok: 'var(--ok)', bad: 'var(--bad)', unknown: 'var(--tx3)' };

function Dot({ status, title }: { status: Status; title?: string }) {
  return <span title={title} style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[status], flex: 'none', display: 'inline-block' }} />;
}

function Logo({ preset, kind, size = 26 }: { preset: string | null; kind: string; size?: number }) {
  const brand = modelProviderBrand(preset, kind);
  return (
    <span title={brand.label} style={{ width: size + 10, height: size + 10, borderRadius: 6, background: 'var(--bg3)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', flex: 'none' }}>
      {brand.mark(size)}
    </span>
  );
}

const presetOf = (p: ModelProvider): string | null => (typeof p.extra.preset === 'string' ? p.extra.preset : null);
const extraText = (extra: Record<string, unknown>, key: string): string => {
  const v = extra[key];
  return typeof v === 'string' ? v : '';
};
const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Status per provider from the per-role probes: any failing role → bad, any answering → ok, none probed → unknown. */
function providerStatus(health: LlmHealth | null, providerId: number): { status: Status; title: string } {
  if (!health) return { status: 'unknown', title: 'Health not read yet' };
  const probes = ROLE_ORDER.map((r) => health.roles[r]).filter((r) => r.provider?.id === providerId && r.probe);
  if (probes.length === 0) return { status: 'unknown', title: 'No role mapped — not probed' };
  const bad = probes.find((r) => r.probe && !r.probe.ok);
  if (bad) return { status: 'bad', title: bad.probe?.error ?? 'not answering' };
  return { status: 'ok', title: `Answering · ${String(probes[0].probe?.latencyMs ?? 0)} ms` };
}

export function ModelProviders({ toast }: { toast: (msg: string) => void }) {
  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  const [roles, setRoles] = useState<ModelRoleMapping[]>([]);
  const [health, setHealth] = useState<LlmHealth | null>(null);
  const [flags, setFlags] = useState({ gateway: false, keyVault: false });
  const [editing, setEditing] = useState<ModelProvider | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void Promise.all([api.modelProviders(), api.modelRoles()])
      .then(([p, r]) => {
        setProviders(p.providers);
        setRoles(r.roles);
        setFlags({ gateway: p.gateway, keyVault: p.keyVault });
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
    void api.llmHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(reload, [reload]);

  const testSaved = (p: ModelProvider) => {
    setTesting(p.id);
    api
      .testModelProvider({ id: p.id })
      .then((r) => toast(`${p.name} answered in ${String(r.latencyMs)} ms (${r.model ?? p.defaultModel})`))
      .catch((e: Error) => toast(`${p.name} did not answer — ${e.message}`))
      .finally(() => {
        setTesting(null);
        void api.llmHealth().then(setHealth).catch(() => undefined);
      });
  };

  const remove = (p: ModelProvider) => {
    api
      .deleteModelProvider(p.id)
      .then(() => {
        toast(`${p.name} removed — roles it served are unmapped`);
        reload();
      })
      .catch((e: Error) => toast(`Remove failed — ${e.message}`))
      .finally(() => setConfirmDelete(null));
  };

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ ...card }}>
        <div style={head}>
          MODEL PROVIDERS · THE MODELS THAT PLAN, ESTIMATE, REVIEW AND DRAFT
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
            {flags.gateway && <span title="Provider calls route through Cloudflare AI Gateway">VIA AI GATEWAY</span>}
            {flags.keyVault && <span title="Credential names resolve from Azure Key Vault">KEY VAULT</span>}
            {health && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Dot status={health.ok ? 'ok' : health.configured ? 'bad' : 'unknown'} />
                {health.ok ? 'ALL ROLES ANSWERING' : health.configured ? 'A ROLE IS NOT ANSWERING' : 'NO PROVIDER YET'}
              </span>
            )}
          </span>
        </div>

        {error && <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--bad)' }}>{error}</div>}
        {!providers && !error && <div style={{ padding: '12px 14px', ...mono(400, 11), color: 'var(--tx3)' }}>LOADING…</div>}

        {providers && (
          <div style={{ padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
            {providers.map((p) => {
              const st = providerStatus(health, p.id);
              return (
                <div key={p.id} className="hv-border" style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg)', padding: '12px 12px 10px', display: 'flex', flexDirection: 'column', gap: 8, opacity: p.live ? 1 : 0.75 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Logo preset={presetOf(p)} kind={p.kind} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 7 }}>
                        <Dot status={st.status} title={st.title} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                      </div>
                      <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.04em' }}>{modelProviderBrand(presetOf(p), p.kind).label.toUpperCase()}{p.live ? '' : ' · NOT IN THIS BUILD'}</div>
                    </div>
                  </div>
                  <div style={{ ...mono(500, 11), color: 'var(--agent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.defaultModel}>
                    {p.defaultModel || '— no default model'}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minHeight: 18 }}>
                    {p.roles.map((r) => (
                      <span key={r.role} title={r.model} style={{ ...mono(500, 9), letterSpacing: '.06em', color: 'var(--tx2)', background: 'var(--bg3)', border: '1px solid var(--line)', borderRadius: 3, padding: '1px 6px' }}>
                        {r.role.toUpperCase()}
                      </span>
                    ))}
                    {p.roles.length === 0 && <span style={{ ...mono(400, 9.5), color: 'var(--tx3)' }}>serves no role yet</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, ...mono(400, 10), color: p.credential === 'missing' ? 'var(--warn)' : 'var(--tx3)' }} title={`Credential ref ${p.credentialRef || '(none)'}`}>
                    <Dot status={p.credential === 'missing' ? 'bad' : 'ok'} />
                    {p.credential === 'env' ? 'KEY FROM ENV' : p.credential === 'key-vault' ? 'KEY FROM KEY VAULT' : 'KEY NOT FOUND'} · {p.credentialRef || '—'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 'auto' }}>
                    <button style={ghostBtn} disabled={testing === p.id || !p.live} onClick={() => testSaved(p)}>
                      {testing === p.id ? 'Testing…' : 'Test'}
                    </button>
                    <button style={ghostBtn} onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    {confirmDelete === p.id ? (
                      <span style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto' }}>
                        <button onClick={() => remove(p)} style={{ ...ghostBtn, border: '1px solid var(--bad)', color: 'var(--bad)', fontWeight: 600 }}>
                          Confirm
                        </button>
                        <button onClick={() => setConfirmDelete(null)} style={ghostBtn}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button className="hv-bad" onClick={() => setConfirmDelete(p.id)} style={{ ...ghostBtn, border: 'none', color: 'var(--tx3)', marginLeft: 'auto', ...mono(400, 10), letterSpacing: '.06em' }}>
                        REMOVE
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <button
              className="hv-border"
              onClick={() => setEditing('new')}
              style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'transparent', color: 'var(--tx2)', minHeight: 150, cursor: 'pointer', display: 'grid', placeItems: 'center', fontSize: 12.5 }}
            >
              <span>
                <span style={{ display: 'block', fontSize: 26, lineHeight: 1, marginBottom: 6, color: 'var(--tx3)' }}>+</span>
                Add provider
              </span>
            </button>
          </div>
        )}

        {editing && providers && (
          <ProviderWizard
            existing={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={(p, created) => {
              setEditing(null);
              toast(created ? `${p.name} added — map it to a role below` : `${p.name} saved`);
              reload();
            }}
          />
        )}
      </div>

      {providers && <RoleTable providers={providers} roles={roles} health={health} onSaved={(next) => { setRoles(next); reload(); }} toast={toast} />}
    </div>
  );
}

// ---------- Add / edit wizard ----------

type Step = 'kind' | 'details' | 'test';

function ProviderWizard({ existing, onClose, onSaved }: { existing: ModelProvider | null; onClose: () => void; onSaved: (p: ModelProvider, created: boolean) => void }) {
  const [step, setStep] = useState<Step>(existing ? 'details' : 'kind');
  const [preset, setPreset] = useState<string>(existing ? (presetOf(existing) ?? (Object.entries(MODEL_PROVIDER_PRESETS).find(([, p]) => p.kind === existing.kind)?.[0] ?? 'custom')) : 'anthropic');
  const [form, setForm] = useState<ModelProviderInput>(() =>
    existing
      ? { name: existing.name, kind: existing.kind, baseUrl: existing.baseUrl, credentialRef: existing.credentialRef, defaultModel: existing.defaultModel, extra: { ...existing.extra } }
      : draftFor('anthropic'),
  );
  const [probe, setProbe] = useState<ProviderProbe | { error: string } | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [endpoints, setEndpoints] = useState<string[]>([]);

  const def = PRESET_DEFAULTS[preset] ?? PRESET_DEFAULTS.custom;
  const brand = MODEL_PROVIDER_PRESETS[preset] ?? MODEL_PROVIDER_PRESETS.custom;

  // Databricks: the model is an endpoint name — offer the workspace's list.
  useEffect(() => {
    if (form.kind !== 'databricks') return;
    void api.agentModels().then((c) => setEndpoints(c.servingEndpoints.map((e) => e.name))).catch(() => setEndpoints([]));
  }, [form.kind]);

  const pick = (key: string) => {
    setPreset(key);
    setForm(draftFor(key));
    setProbe(null);
    setStep('details');
  };

  const set = (patch: Partial<ModelProviderInput>) => {
    setForm((f) => ({ ...f, ...patch }));
    setProbe(null);
  };
  const setExtra = (key: string, value: unknown) => set({ extra: { ...form.extra, [key]: value } });

  const valid = form.name.trim().length > 0 && form.defaultModel.trim().length > 0 && /^[A-Za-z0-9_.-]*$/.test(form.credentialRef) && (!def.fields.includes('baseUrl') || /^https?:\/\/\S+$/i.test(form.baseUrl ?? ''));
  const suggestions = form.kind === 'databricks' && endpoints.length > 0 ? endpoints : def.models;

  const test = () => {
    setBusy('test');
    api
      .testModelProvider({ draft: { ...form, extra: { ...form.extra, preset } } })
      .then((r) => setProbe(r))
      .catch((e: Error) => setProbe({ error: e.message }))
      .finally(() => setBusy(null));
  };

  const save = () => {
    setBusy('save');
    const input: ModelProviderInput = { ...form, name: form.name.trim(), defaultModel: form.defaultModel.trim(), baseUrl: form.baseUrl?.trim() || null, extra: { ...form.extra, preset } };
    (existing ? api.updateModelProvider(existing.id, input) : api.createModelProvider(input))
      .then((p) => onSaved(p, !existing))
      .catch((e: Error) => {
        setProbe({ error: e.message });
        setBusy(null);
      });
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: 14, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        {(['kind', 'details', 'test'] as Step[]).map((s, i) => (
          <span key={s} style={{ ...mono(500, 10), letterSpacing: '.08em', color: step === s ? 'var(--tx)' : 'var(--tx3)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 16, height: 16, borderRadius: '50%', display: 'grid', placeItems: 'center', background: step === s ? 'var(--acc)' : 'var(--bg3)', color: step === s ? '#fff' : 'var(--tx3)', fontSize: 9 }}>{i + 1}</span>
            {s === 'kind' ? 'PROVIDER' : s === 'details' ? 'DETAILS' : 'TEST & SAVE'}
          </span>
        ))}
        <button onClick={onClose} style={{ ...ghostBtn, marginLeft: 'auto' }}>
          Cancel
        </button>
      </div>

      {step === 'kind' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
          {Object.entries(MODEL_PROVIDER_PRESETS).map(([key, p]) => {
            const stub = p.kind === 'bedrock' || p.kind === 'vertex';
            return (
              <button
                key={key}
                className="hv-border"
                onClick={() => pick(key)}
                title={stub ? `${p.label} — declared, not wired in this build` : p.label}
                style={{ border: `1px solid ${preset === key ? 'var(--tx3)' : 'var(--line)'}`, background: 'var(--bg2)', borderRadius: 4, padding: '14px 10px', cursor: 'pointer', color: 'var(--tx)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, opacity: stub ? 0.6 : 1 }}
              >
                {p.mark(30)}
                <span style={{ fontSize: 12, fontWeight: 600, textAlign: 'center' }}>{p.label}</span>
                {stub && <span style={{ ...mono(400, 9), color: 'var(--tx3)', letterSpacing: '.06em' }}>SOON</span>}
              </button>
            );
          })}
        </div>
      )}

      {step !== 'kind' && (
        <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: 14, alignItems: 'start' }}>
          <Logo preset={preset} kind={form.kind} size={30} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, maxWidth: 760 }}>
            <div>
              <div style={label}>NAME</div>
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} style={input} />
            </div>
            {def.fields.includes('baseUrl') && (
              <div>
                <div style={label}>{FIELD_LABEL.baseUrl.toUpperCase()}</div>
                <input value={form.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={def.baseUrl} style={input} />
              </div>
            )}
            {def.fields.filter((f) => f !== 'baseUrl').map((f) => (
              <div key={f}>
                <div style={label}>{FIELD_LABEL[f].toUpperCase()}</div>
                <input value={extraText(form.extra, f)} onChange={(e) => setExtra(f, e.target.value)} style={input} />
              </div>
            ))}
            <div>
              <div style={label}>CREDENTIAL NAME · ENV VAR{form.kind === 'anthropic' ? '' : ' / KEY VAULT SECRET'}</div>
              <input value={form.credentialRef} onChange={(e) => set({ credentialRef: e.target.value.trim() })} placeholder={def.credentialRef} style={{ ...input, ...mono(500, 12) }} />
              <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginTop: 3 }}>The name of the secret. The key itself never goes through this form.</div>
            </div>
            <div>
              <div style={label}>{form.kind === 'databricks' ? 'SERVING ENDPOINT' : form.extra.apiVersion ? 'DEPLOYMENT' : 'DEFAULT MODEL'}</div>
              <input list={`models-${preset}`} value={form.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })} placeholder={suggestions[0] ?? 'model id'} style={{ ...input, ...mono(500, 12) }} />
              <datalist id={`models-${preset}`}>
                {suggestions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {suggestions.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                  {suggestions.slice(0, 6).map((m) => (
                    <button key={m} onClick={() => set({ defaultModel: m })} style={{ ...ghostBtn, padding: '2px 7px', ...mono(400, 10), color: form.defaultModel === m ? 'var(--tx)' : 'var(--tx3)', borderColor: form.defaultModel === m ? 'var(--tx3)' : 'var(--line)' }}>
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {form.kind === 'openai-compatible' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--tx2)', alignSelf: 'end', paddingBottom: 6 }}>
                <input type="checkbox" checked={form.extra.bypassGateway === true} onChange={(e) => setExtra('bypassGateway', e.target.checked)} />
                Call this endpoint directly (bypass the AI Gateway)
              </label>
            )}
          </div>
        </div>
      )}

      {step !== 'kind' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          {!existing && (
            <button onClick={() => setStep('kind')} style={ghostBtn}>
              ← Provider
            </button>
          )}
          <button onClick={test} disabled={!valid || busy !== null || brand.kind === 'bedrock' || brand.kind === 'vertex'} style={{ ...ghostBtn, opacity: valid ? 1 : 0.45 }}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
          {probe && 'ok' in probe && probe.ok && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...mono(500, 11), color: 'var(--ok)' }}>
              <Dot status="ok" /> {probe.model ?? form.defaultModel} answered in {probe.latencyMs} ms
            </span>
          )}
          {probe && 'error' in probe && probe.error && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--bad)' }}>
              <Dot status="bad" /> {probe.error}
            </span>
          )}
          <button
            className="hv-bright"
            onClick={() => {
              setStep('test');
              save();
            }}
            disabled={!valid || busy !== null}
            style={{ ...primaryBtn(valid && busy === null), marginLeft: 'auto' }}
          >
            {busy === 'save' ? 'Saving…' : existing ? 'Save changes' : 'Save provider'}
          </button>
        </div>
      )}
    </div>
  );
}

function draftFor(preset: string): ModelProviderInput {
  const d = PRESET_DEFAULTS[preset] ?? PRESET_DEFAULTS.custom;
  const p = MODEL_PROVIDER_PRESETS[preset] ?? MODEL_PROVIDER_PRESETS.custom;
  return { name: d.name, kind: p.kind, baseUrl: d.fields.includes('baseUrl') ? d.baseUrl : null, credentialRef: d.credentialRef, defaultModel: d.models[0] ?? '', extra: { ...d.extra } };
}

// ---------- Roles → models ----------

function RoleTable({ providers, roles, health, onSaved, toast }: { providers: ModelProvider[]; roles: ModelRoleMapping[]; health: LlmHealth | null; onSaved: (roles: ModelRoleMapping[]) => void; toast: (msg: string) => void }) {
  const [draft, setDraft] = useState<Record<ModelRole, { providerId: number | null; model: string }>>(() => fromRoles(roles));
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<{ role: string; error: string } | null>(null);
  // A fresh role map from the server resets the draft (state adjusted during render, not in an effect).
  const [seenRoles, setSeenRoles] = useState(roles);
  if (seenRoles !== roles) {
    setSeenRoles(roles);
    setDraft(fromRoles(roles));
  }

  const dirty = useMemo(() => roles.some((r) => draft[r.role].providerId !== r.providerId || (draft[r.role].providerId !== null && draft[r.role].model !== r.model)), [draft, roles]);

  const save = () => {
    setSaving(true);
    setRefused(null);
    api
      .saveModelRoles(ROLE_ORDER.map((role) => ({ role, providerId: draft[role].providerId, model: draft[role].model })))
      .then((r) => {
        onSaved(r.roles);
        toast('Role map saved');
      })
      .catch((e: Error & { status?: number }) => {
        setRefused({ role: '', error: e.message });
      })
      .finally(() => setSaving(false));
  };

  const modelsFor = (providerId: number | null): string[] => {
    const p = providers.find((x) => x.id === providerId);
    if (!p) return [];
    const preset = presetOf(p);
    const known = (preset ? PRESET_DEFAULTS[preset]?.models : undefined) ?? [];
    return [...new Set([p.defaultModel, ...known, ...p.roles.map((r) => r.model)].filter(Boolean))];
  };

  return (
    <div style={{ ...card, marginTop: 12 }}>
      <div style={head}>
        ROLES → MODELS · COMETLOOP CALLS A ROLE, NOT “THE MODEL”
        {dirty && (
          <button className="hv-bright" onClick={save} disabled={saving} style={{ ...primaryBtn(!saving), marginLeft: 'auto', padding: '4px 12px' }}>
            {saving ? 'Saving…' : 'Save role map'}
          </button>
        )}
      </div>
      {refused && <div style={{ padding: '8px 14px', fontSize: 12, color: 'var(--bad)', borderBottom: '1px solid var(--line)' }}>{refused.error}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['ROLE', 'USED FOR', 'NEEDS', 'PROVIDER', 'MODEL', ''].map((h) => (
              <th key={h} style={{ textAlign: 'left', ...mono(500, 10), letterSpacing: '.08em', color: 'var(--tx3)', borderBottom: '1px solid var(--line)', padding: '8px 14px' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => {
            const d = draft[r.role];
            const provider = providers.find((p) => p.id === d.providerId) ?? null;
            const probe = health?.roles[r.role]?.probe ?? null;
            const status: Status = !r.providerId ? 'unknown' : r.gap ? 'bad' : probe ? (probe.ok ? 'ok' : 'bad') : 'unknown';
            const title = r.gap ?? (probe ? (probe.ok ? `Answering · ${String(probe.latencyMs)} ms` : (probe.error ?? 'not answering')) : r.providerId ? 'Not probed yet' : 'No provider mapped — the deterministic fallback applies');
            return (
              <tr key={r.role}>
                <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.label}</td>
                <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', fontSize: 11.5, color: 'var(--tx2)', maxWidth: 320 }}>{r.usedFor}</td>
                <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[r.contract.json ? 'JSON' : 'PROSE', r.contract.tools ? 'TOOLS' : null, `${fmtK(r.contract.contextTokens).toUpperCase()} CTX`].filter(Boolean).map((chip) => (
                      <span key={chip} style={{ ...mono(500, 9), letterSpacing: '.06em', color: 'var(--tx3)', border: '1px solid var(--line)', borderRadius: 3, padding: '1px 5px' }}>
                        {chip}
                      </span>
                    ))}
                  </div>
                </td>
                <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {provider && <Logo preset={presetOf(provider)} kind={provider.kind} size={16} />}
                    <select
                      value={d.providerId ?? ''}
                      onChange={(e) => {
                        const id = e.target.value ? Number(e.target.value) : null;
                        const p = providers.find((x) => x.id === id);
                        setDraft((cur) => ({ ...cur, [r.role]: { providerId: id, model: p?.defaultModel ?? '' } }));
                      }}
                      style={{ ...input, width: 190, padding: '5px 7px' }}
                    >
                      <option value="">— not mapped</option>
                      {providers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </td>
                <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
                  <input
                    list={`role-models-${r.role}`}
                    value={d.model}
                    disabled={!d.providerId}
                    onChange={(e) => setDraft((cur) => ({ ...cur, [r.role]: { ...cur[r.role], model: e.target.value } }))}
                    placeholder={provider?.defaultModel ?? ''}
                    style={{ ...input, width: 230, padding: '5px 7px', ...mono(500, 11.5), opacity: d.providerId ? 1 : 0.5 }}
                  />
                  <datalist id={`role-models-${r.role}`}>
                    {modelsFor(d.providerId).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </td>
                <td style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                  <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...mono(400, 10), color: status === 'bad' ? 'var(--bad)' : 'var(--tx3)' }}>
                    <Dot status={status} />
                    {r.gap ? 'CANNOT SERVE' : probe ? (probe.ok ? `${String(probe.latencyMs)} MS` : 'NOT ANSWERING') : r.providerId ? 'UNPROBED' : 'FALLBACK'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fromRoles(roles: ModelRoleMapping[]): Record<ModelRole, { providerId: number | null; model: string }> {
  const out = {} as Record<ModelRole, { providerId: number | null; model: string }>;
  for (const role of ROLE_ORDER) {
    const r = roles.find((x) => x.role === role);
    out[role] = { providerId: r?.providerId ?? null, model: r?.model ?? '' };
  }
  return out;
}
