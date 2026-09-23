import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ModelPrice, ModelPriceInput } from '../types';
import { mono } from '../util';

/**
 * Model prices — USD per 1M tokens, the rates estimated cost uses whenever a
 * usage row carries no recorded cost (every control-plane call, every run
 * whose harness does not price itself). One simple table: the published
 * defaults, pulled from the providers' own pricing pages on the date each
 * row shows, with the workspace's overrides on top. Edit a row inline, reset
 * it to the default, or add a model nothing prices yet (a serving endpoint,
 * a fine-tune). Admin-only like the providers above it.
 */

const card: React.CSSProperties = { border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden', marginTop: 12 };
const head: React.CSSProperties = { padding: '10px 14px', borderBottom: '1px solid var(--line)', ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', display: 'flex', alignItems: 'center', gap: 10 };
const th: React.CSSProperties = { textAlign: 'left', ...mono(500, 10), letterSpacing: '.08em', color: 'var(--tx3)', borderBottom: '1px solid var(--line)', padding: '8px 12px', whiteSpace: 'nowrap' };
const td = (align: 'left' | 'right' = 'left'): React.CSSProperties => ({ padding: '6px 12px', borderBottom: '1px solid var(--line)', fontSize: 12, textAlign: align, whiteSpace: 'nowrap', verticalAlign: 'middle' });
const rateInput: React.CSSProperties = { width: 78, boxSizing: 'border-box', background: 'var(--bg)', border: '1px solid var(--line2)', borderRadius: 3, color: 'var(--tx)', padding: '4px 6px', ...mono(500, 11.5), textAlign: 'right' };
const ghostBtn: React.CSSProperties = { border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '3px 9px', fontSize: 11, cursor: 'pointer' };
const primaryBtn = (on: boolean): React.CSSProperties => ({ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '4px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: on ? 1 : 0.45 });

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'ANTHROPIC', openai: 'OPENAI', google: 'GOOGLE' };
const RATE_KEYS: (keyof ModelPriceInput)[] = ['inputPerM', 'outputPerM', 'cacheReadPerM', 'cacheWritePerM'];

type Draft = Record<keyof ModelPriceInput, string>;

const toDraft = (p: ModelPriceInput): Draft => ({ inputPerM: String(p.inputPerM), outputPerM: String(p.outputPerM), cacheReadPerM: String(p.cacheReadPerM), cacheWritePerM: String(p.cacheWritePerM) });
const emptyDraft = (): Draft => ({ inputPerM: '', outputPerM: '', cacheReadPerM: '0', cacheWritePerM: '0' });

/** Every field a non-negative number, or null. */
function parseDraft(d: Draft): ModelPriceInput | null {
  const out = {} as ModelPriceInput;
  for (const k of RATE_KEYS) {
    const n = Number(d[k].trim());
    if (d[k].trim() === '' || !Number.isFinite(n) || n < 0) return null;
    out[k] = n;
  }
  return out;
}

/** $2, $0.20, $0.075 — as many decimals as the rate needs, no trailing zeros. */
function fmtRate(n: number): string {
  if (n === 0) return '$0';
  const s = n >= 1 ? n.toFixed(2) : n.toFixed(4);
  return `$${s.replace(/0+$/, '').replace(/\.$/, '')}`;
}

const sameRates = (a: ModelPriceInput, b: ModelPriceInput): boolean => RATE_KEYS.every((k) => a[k] === b[k]);

function SourceBadge({ p }: { p: ModelPrice }) {
  const override = p.source === 'override';
  const title = override
    ? `Set in this workspace${p.updatedBy ? ` by ${p.updatedBy}` : ''}${p.default ? ` — published default ${fmtRate(p.default.inputPerM)} in / ${fmtRate(p.default.outputPerM)} out` : ' — no published default'}`
    : `Published price, read from ${p.default?.sourceUrl ?? 'the provider'} on ${p.default?.fetchedAt ?? '—'}${p.default?.note ? ` (${p.default.note})` : ''}`;
  return (
    <span title={title} style={{ ...mono(500, 9), letterSpacing: '.06em', color: override ? 'var(--acc)' : 'var(--tx3)', border: `1px solid ${override ? 'var(--acc)' : 'var(--line)'}`, borderRadius: 3, padding: '1px 6px' }}>
      {override ? 'OVERRIDE' : 'DEFAULT'}
    </span>
  );
}

export function ModelPrices({ toast }: { toast: (msg: string) => void }) {
  const [prices, setPrices] = useState<ModelPrice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The model being edited inline, or 'new' for the add row. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [newModel, setNewModel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .modelPrices()
      .then((r) => {
        setPrices(r.prices);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(reload, [reload]);

  const startEdit = (p: ModelPrice) => {
    setEditing(p.model);
    setDraft(toDraft(p));
  };
  const startAdd = () => {
    setEditing('new');
    setDraft(emptyDraft());
    setNewModel('');
  };
  const cancel = () => setEditing(null);

  const save = (model: string, current: ModelPriceInput | null) => {
    const rates = parseDraft(draft);
    const id = model.trim();
    if (!id) {
      toast('Name the model first');
      return;
    }
    if (!rates) {
      toast('Rates are USD per 1M tokens — a number, 0 or more, in every column');
      return;
    }
    if (current && sameRates(rates, current)) {
      setEditing(null);
      return;
    }
    setBusy(id);
    api
      .saveModelPrice(id, rates)
      .then(() => {
        toast(`${id} priced at ${fmtRate(rates.inputPerM)} in / ${fmtRate(rates.outputPerM)} out — estimates use it from now on`);
        setEditing(null);
        reload();
      })
      .catch((e: Error) => toast(`Save failed — ${e.message}`))
      .finally(() => setBusy(null));
  };

  const reset = (p: ModelPrice) => {
    setBusy(p.model);
    api
      .resetModelPrice(p.model)
      .then(() => {
        toast(p.default ? `${p.model} is back on the published default` : `${p.model} removed — nothing prices it now`);
        if (editing === p.model) setEditing(null);
        reload();
      })
      .catch((e: Error) => toast(`Reset failed — ${e.message}`))
      .finally(() => setBusy(null));
  };

  const overrides = prices?.filter((p) => p.source === 'override').length ?? 0;
  const fetched = prices?.find((p) => p.default)?.default?.fetchedAt;

  const rateCells = (p: ModelPriceInput | null, model: string) =>
    RATE_KEYS.map((k) => (
      <td key={k} style={td('right')}>
        {editing === model ? (
          <input
            type="number"
            min={0}
            step="0.01"
            value={draft[k]}
            onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(model === 'new' ? newModel : model, p);
              if (e.key === 'Escape') cancel();
            }}
            style={rateInput}
          />
        ) : (
          <span style={{ ...mono(500, 11.5), color: p && p[k] === 0 ? 'var(--tx3)' : 'var(--tx)' }}>{p ? fmtRate(p[k]) : '—'}</span>
        )}
      </td>
    ));

  return (
    <div style={card}>
      <div style={head}>
        MODEL PRICES · USD PER 1M TOKENS — WHAT ESTIMATED COST USES WHEN A RUN REPORTS NONE
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          {fetched && <span title="Defaults were read from the providers' pricing pages on this date">DEFAULTS AS OF {fetched}</span>}
          {prices && <span style={{ color: overrides ? 'var(--acc)' : undefined }}>{overrides} OVERRIDE{overrides === 1 ? '' : 'S'}</span>}
        </span>
      </div>

      {error && <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--bad)' }}>{error}</div>}
      {!prices && !error && <div style={{ padding: '12px 14px', ...mono(400, 11), color: 'var(--tx3)' }}>LOADING…</div>}

      {prices && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>MODEL</th>
                <th style={th}>PROVIDER</th>
                <th style={{ ...th, textAlign: 'right' }}>INPUT</th>
                <th style={{ ...th, textAlign: 'right' }}>OUTPUT</th>
                <th style={{ ...th, textAlign: 'right' }}>CACHE READ</th>
                <th style={{ ...th, textAlign: 'right' }}>CACHE WRITE</th>
                <th style={th}>SOURCE</th>
                <th style={th}>AS OF</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => {
                const isEditing = editing === p.model;
                const isBusy = busy === p.model;
                return (
                  <tr key={p.model} style={{ background: isEditing ? 'var(--bg)' : undefined }}>
                    <td style={td()}>
                      <span style={{ ...mono(500, 11.5), color: 'var(--agent)' }} title={p.default?.note ?? p.model}>
                        {p.model}
                      </span>
                    </td>
                    <td style={{ ...td(), ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.04em' }}>{p.provider ? PROVIDER_LABEL[p.provider] : 'CUSTOM'}</td>
                    {rateCells(p, p.model)}
                    <td style={td()}>
                      <SourceBadge p={p} />
                    </td>
                    <td style={{ ...td(), ...mono(400, 10), color: 'var(--tx3)' }}>
                      {p.source === 'override' ? (
                        <span title={p.updatedBy ? `by ${p.updatedBy}` : undefined}>{p.updatedAt ? p.updatedAt.slice(0, 10) : '—'}</span>
                      ) : p.default ? (
                        <a href={p.default.sourceUrl} target="_blank" rel="noreferrer" title={p.default.sourceUrl} style={{ color: 'var(--tx3)', textDecoration: 'underline dotted' }}>
                          {p.default.fetchedAt}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ ...td('right'), width: 1 }}>
                      <span style={{ display: 'inline-flex', gap: 5 }}>
                        {isEditing ? (
                          <>
                            <button className="hv-bright" disabled={isBusy} onClick={() => save(p.model, p)} style={primaryBtn(!isBusy)}>
                              {isBusy ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={cancel} style={ghostBtn}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button disabled={isBusy} onClick={() => startEdit(p)} style={ghostBtn}>
                              Edit
                            </button>
                            {p.source === 'override' && (
                              <button disabled={isBusy} onClick={() => reset(p)} style={{ ...ghostBtn, border: 'none', color: 'var(--tx3)', ...mono(400, 10), letterSpacing: '.06em' }} title={p.default ? 'Back to the published default' : 'Remove this price'}>
                                {isBusy ? 'RESETTING…' : p.default ? 'RESET TO DEFAULT' : 'REMOVE'}
                              </button>
                            )}
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}

              {editing === 'new' ? (
                <tr style={{ background: 'var(--bg)' }}>
                  <td style={td()}>
                    <input
                      autoFocus
                      value={newModel}
                      onChange={(e) => setNewModel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') save(newModel, null);
                        if (e.key === 'Escape') cancel();
                      }}
                      placeholder="model id or endpoint name"
                      style={{ ...rateInput, width: 220, textAlign: 'left' }}
                    />
                  </td>
                  <td style={{ ...td(), ...mono(400, 10), color: 'var(--tx3)' }}>CUSTOM</td>
                  {rateCells(null, 'new')}
                  <td style={td()} />
                  <td style={td()} />
                  <td style={{ ...td('right'), width: 1 }}>
                    <span style={{ display: 'inline-flex', gap: 5 }}>
                      <button className="hv-bright" disabled={busy === newModel.trim() && busy !== ''} onClick={() => save(newModel, null)} style={primaryBtn(true)}>
                        Save
                      </button>
                      <button onClick={cancel} style={ghostBtn}>
                        Cancel
                      </button>
                    </span>
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={9} style={{ padding: '8px 12px' }}>
                    <button className="hv-border" onClick={startAdd} style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'transparent', color: 'var(--tx2)', cursor: 'pointer', padding: '6px 14px', fontSize: 12 }}>
                      + Add a model
                    </button>
                    <span style={{ ...mono(400, 10), color: 'var(--tx3)', marginLeft: 12 }}>A SERVING ENDPOINT OR FINE-TUNE NOTHING PRICES YET · DATED IDS MATCH THEIR BASE MODEL (claude-sonnet-5-20260401 → claude-sonnet-5)</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
