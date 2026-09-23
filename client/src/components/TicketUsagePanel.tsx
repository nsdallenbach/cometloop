import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TicketUsage, UsageTotals } from '../types';
import { mono } from '../util';
import { cacheLine, fmtCostLabel, fmtTokens, usageCacheTokens, usageTokens } from '../lib/usage-format';

/**
 * What a ticket has cost in tokens, across every agent run, per model
 * (DAT-260). Reads the same rows the runners stream home (DAT-266), so a run
 * in flight shows up here while it works — `live` keeps it fresh. Mount it
 * keyed by ticket so a new ticket starts from a clean slate.
 *
 * The headline is input + output — the number people quote. Cache reads and
 * writes stay visible on their own mono line, never in the total. Cost is
 * the harness's own figure where it sent one and otherwise estimated at the
 * workspace's model rates, labelled "est."; a model nothing prices is named
 * rather than shown as $0.
 */

const LIVE_POLL_MS = 15_000;

const breakdown = (t: UsageTotals): string => `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · ${cacheLine(t)}`;

export function TicketUsagePanel({ ticketKey, live }: { ticketKey: string; live: boolean }) {
  const [usage, setUsage] = useState<TicketUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .ticketUsage(ticketKey)
        .then((u) => {
          if (!alive) return;
          setUsage(u);
          setFailed(false);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    void load();
    const timer = live ? window.setInterval(() => void load(), LIVE_POLL_MS) : null;
    return () => {
      alive = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [ticketKey, live]);

  const total = usage ? usageTokens(usage.total) : 0;
  const any = usage ? total + usageCacheTokens(usage.total) : 0;
  const cost = usage ? fmtCostLabel({ usd: usage.total.costUsd, estimated: usage.costEstimated, unpriced: usage.unpricedModels }) : '';

  return (
    <>
      <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>TOKEN USAGE</div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '10px 12px', marginBottom: 18 }}>
        {!usage || any === 0 ? (
          <div style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>
            {failed ? 'Usage unavailable right now' : usage ? 'N/A — no agent usage recorded' : 'Loading…'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }} title={breakdown(usage.total)}>
              <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--tx)' }}>{fmtTokens(total)}</span>
              <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>TOKENS</span>
              {cost && (
                <span
                  style={{ ...mono(500, 11), color: usage.total.costUsd == null ? 'var(--tx3)' : 'var(--tx2)' }}
                  title={usage.costEstimated ? 'Estimated at the workspace’s model rates (Admin → Model prices) where a run reported no cost' : 'As reported by the harness'}
                >
                  {cost}
                </span>
              )}
              <span style={{ ...mono(400, 10), color: 'var(--tx3)', marginLeft: 'auto' }}>
                {usage.runs} RUN{usage.runs === 1 ? '' : 'S'}
                {usage.controlPlaneCalls > 0 ? ` · ${usage.controlPlaneCalls} PLANNING CALL${usage.controlPlaneCalls === 1 ? '' : 'S'}` : ''}
              </span>
            </div>
            <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginTop: 4 }}>
              in {fmtTokens(usage.total.input)} · out {fmtTokens(usage.total.output)} · {cacheLine(usage.total)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {usage.models.map((m) => {
                const tokens = usageTokens(m);
                const modelCost = fmtCostLabel({ usd: m.costUsd, estimated: m.costEstimated, unpriced: m.unpriced ? [m.model || 'unknown model'] : [] });
                return (
                  <div key={`${m.provider}:${m.model || 'unknown'}`} title={breakdown(m)}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                      <span style={{ ...mono(500, 10.5), color: m.model ? 'var(--agent)' : 'var(--tx3)' }}>{m.model || 'Unknown model'}</span>
                      {m.provider && m.runs === 0 && (
                        <span style={{ ...mono(400, 9.5), color: 'var(--tx3)', letterSpacing: '.06em' }}>CONTROL PLANE · {m.provider.toUpperCase()}</span>
                      )}
                      <span style={{ ...mono(400, 10.5), color: 'var(--tx2)', marginLeft: 'auto' }}>
                        {fmtTokens(tokens)}
                        {modelCost ? ` · ${modelCost}` : ''}
                      </span>
                    </div>
                    <div style={{ height: 3, borderRadius: 2, background: 'var(--line)' }}>
                      <div style={{ height: '100%', borderRadius: 2, width: `${Math.max(2, total > 0 ? (tokens / total) * 100 : 0)}%`, background: m.model ? 'var(--agent)' : 'var(--tx3)' }} />
                    </div>
                    <div style={{ ...mono(400, 9.5), color: 'var(--tx3)', marginTop: 4 }}>{breakdown(m)}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
