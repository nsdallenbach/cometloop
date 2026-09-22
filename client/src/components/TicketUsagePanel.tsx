import { useEffect, useState } from 'react';
import { api } from '../api';
import type { TicketUsage, UsageTotals } from '../types';
import { mono } from '../util';
import { fmtCost, fmtTokens, usageTokens } from '../lib/usage-format';

/**
 * What a ticket has cost in tokens, across every agent run, per model
 * (DAT-260). Reads the same rows the runners stream home (DAT-266), so a run
 * in flight shows up here while it works — `live` keeps it fresh. Mount it
 * keyed by ticket so a new ticket starts from a clean slate.
 */

const LIVE_POLL_MS = 15_000;

const breakdown = (t: UsageTotals): string =>
  `in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · cache ${fmtTokens(t.cacheRead + t.cacheCreate)}`;

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
  const cost = usage ? fmtCost(usage.total.costUsd) : '';

  return (
    <>
      <div style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>TOKEN USAGE</div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 3, padding: '10px 12px', marginBottom: 18 }}>
        {!usage || total === 0 ? (
          <div style={{ ...mono(400, 10.5), color: 'var(--tx3)' }}>
            {failed ? 'Usage unavailable right now' : usage ? 'N/A — no agent usage recorded' : 'Loading…'}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }} title={breakdown(usage.total)}>
              <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--tx)' }}>{fmtTokens(total)}</span>
              <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.06em' }}>TOKENS</span>
              {cost && <span style={{ ...mono(500, 11), color: 'var(--tx2)' }}>{cost}</span>}
              <span style={{ ...mono(400, 10), color: 'var(--tx3)', marginLeft: 'auto' }}>
                {usage.runs} RUN{usage.runs === 1 ? '' : 'S'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
              {usage.models.map((m) => {
                const tokens = usageTokens(m);
                return (
                  <div key={m.model || 'unknown'} title={breakdown(m)}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                      <span style={{ ...mono(500, 10.5), color: m.model ? 'var(--agent)' : 'var(--tx3)' }}>{m.model || 'Unknown model'}</span>
                      <span style={{ ...mono(400, 10.5), color: 'var(--tx2)', marginLeft: 'auto' }}>
                        {fmtTokens(tokens)}
                        {m.costUsd != null ? ` · ${fmtCost(m.costUsd)}` : ''}
                      </span>
                    </div>
                    <div style={{ height: 3, borderRadius: 2, background: 'var(--line)' }}>
                      <div style={{ height: '100%', borderRadius: 2, width: `${Math.max(2, (tokens / total) * 100)}%`, background: m.model ? 'var(--agent)' : 'var(--tx3)' }} />
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
