import { useMemo, useState } from 'react';
import { api } from '../api';
import type { Engagement } from '../types';
import { HEALTH_COLOR, HEALTH_LABEL, mono } from '../util';

function Chips({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ ...mono(400, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>{label}</span>
      {options.map((o) => {
        const active = o === value;
        return (
          <button
            key={o}
            className="hv-border"
            onClick={() => onChange(o)}
            style={{
              border: `1px solid ${active ? 'var(--tx3)' : 'var(--line)'}`,
              background: active ? 'var(--bg3)' : 'transparent',
              color: active ? 'var(--tx)' : 'var(--tx2)',
              borderRadius: 3,
              padding: '4px 9px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

export function Portfolio({
  engagements,
  loading,
  onOpen,
  onNew,
  onDeleted,
  toast,
  canCreate,
  canManage,
}: {
  engagements: Engagement[];
  loading: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDeleted: () => void;
  toast: (msg: string) => void;
  canCreate: boolean;
  canManage: (id: string) => boolean;
}) {
  const [fOwner, setFOwner] = useState('All');
  const [fPhase, setFPhase] = useState('All');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const doDelete = (e: Engagement) => {
    if (deletingId) return;
    setDeletingId(e.id);
    api
      .deleteEngagement(e.id)
      .then(() => {
        toast(`${e.name} deleted — tickets, sources and feed removed`);
        onDeleted();
      })
      .catch(() => toast('Delete failed'))
      .finally(() => {
        setDeletingId(null);
        setConfirmId(null);
      });
  };

  const owners = useMemo(() => ['All', ...new Set(engagements.map((e) => e.owner).filter(Boolean))], [engagements]);
  const phases = useMemo(() => ['All', ...new Set(engagements.map((e) => e.phase).filter(Boolean))], [engagements]);
  const filtered = useMemo(
    () => engagements.filter((e) => (fOwner === 'All' || e.owner === fOwner) && (fPhase === 'All' || e.phase === fPhase)),
    [engagements, fOwner, fPhase],
  );
  const nRisk = engagements.filter((e) => e.health === 'risk').length;
  const nOff = engagements.filter((e) => e.health === 'off').length;

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: '-.01em' }}>Portfolio</h1>
        <span style={{ ...mono(400, 11), color: 'var(--tx3)' }}>
          {engagements.length} ACTIVE · {nRisk} AT RISK · {nOff} OFF TRACK
        </span>
        <div style={{ flex: 1 }} />
        {canCreate && (
          <button
            className="hv-bright"
            onClick={onNew}
            style={{
              background: 'var(--acc)',
              color: '#fff',
              border: 'none',
              borderRadius: 3,
              padding: '7px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            New engagement
          </button>
        )}
      </div>
      {engagements.length > 1 && (
        <div style={{ display: 'flex', gap: 18, margin: '14px 0 18px', flexWrap: 'wrap' }}>
          <Chips label="OWNER" options={owners} value={fOwner} onChange={setFOwner} />
          <Chips label="PHASE" options={phases} value={fPhase} onChange={setFPhase} />
        </div>
      )}
      {loading && engagements.length === 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 12, marginTop: 14 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ border: '1px solid var(--line)', background: 'var(--bg2)', borderRadius: 4, height: 150, animation: 'eec-pulse 1.6s infinite' }} />
          ))}
        </div>
      )}
      {!loading && engagements.length === 0 && (
        <div style={{ border: '1px dashed var(--line2)', borderRadius: 4, background: 'var(--bg2)', padding: '44px 20px', textAlign: 'center', marginTop: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>No engagements yet</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)', marginBottom: canCreate ? 14 : 0 }}>
            {canCreate ? 'Create the first one from a SOW or a written project brief.' : 'An engagement lead or admin can create one.'}
          </div>
          {canCreate && (
            <button
              className="hv-bright"
              onClick={onNew}
              style={{ background: 'var(--acc)', color: '#fff', border: 'none', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              New engagement
            </button>
          )}
        </div>
      )}
      {engagements.length > 0 && filtered.length === 0 && (
        <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '20px', textAlign: 'center', marginTop: 14 }}>
          <span style={{ fontSize: 12.5, color: 'var(--tx2)' }}>No engagements match these filters. </span>
          <button
            onClick={() => {
              setFOwner('All');
              setFPhase('All');
            }}
            style={{ border: 'none', background: 'none', color: 'var(--acc)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}
          >
            Clear filters
          </button>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', gap: 12 }}>
        {filtered.map((e) => {
          const hc = HEALTH_COLOR[e.health];
          const burnColor = e.burn > e.plan + 5 ? 'var(--bad)' : e.burn > e.plan ? 'var(--warn)' : 'var(--tx2)';
          return (
            <div
              key={e.id}
              className="hv-card"
              role="button"
              tabIndex={0}
              onClick={() => onOpen(e.id)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' && ev.target === ev.currentTarget) onOpen(e.id);
              }}
              style={{
                border: '1px solid var(--line)',
                background: 'var(--bg2)',
                borderRadius: 4,
                padding: '14px 16px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                animation: 'eec-fadeUp .25s ease both',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 3 }}>{e.client}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-.01em' }}>{e.name}</div>
                </div>
                <span style={{ ...mono(500, 10), color: hc, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: hc }} />
                  {HEALTH_LABEL[e.health]}
                </span>
                {canManage(e.id) && (
                <button
                  className="del-btn hv-bad"
                  title="Delete project"
                  aria-label={`Delete ${e.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setConfirmId(e.id);
                  }}
                  style={{ border: 'none', background: 'none', color: 'var(--tx3)', fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                >
                  ×
                </button>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.45, minHeight: 16 }}>{e.healthReason}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', ...mono(400, 10), color: 'var(--tx3)', marginBottom: 4 }}>
                    <span>TICKETS</span>
                    <span style={{ color: 'var(--tx2)' }}>{e.pct}%</span>
                  </div>
                  <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${e.pct}%`, background: 'var(--tx2)' }} />
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', ...mono(400, 10), color: 'var(--tx3)', marginBottom: 4 }}>
                    <span>BURN / PLAN</span>
                    <span style={{ color: burnColor }}>
                      {e.burn}% / {e.plan}%
                    </span>
                  </div>
                  <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                    <div style={{ height: '100%', width: `${Math.min(100, e.burn)}%`, background: burnColor }} />
                    <div
                      style={{
                        position: 'absolute',
                        top: -2,
                        bottom: -2,
                        left: `${Math.min(100, e.plan)}%`,
                        width: 1,
                        background: 'var(--tx)',
                      }}
                    />
                  </div>
                </div>
              </div>
              {confirmId === e.id ? (
                <div
                  onClick={(ev) => ev.stopPropagation()}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--line)', paddingTop: 9 }}
                >
                  <span style={{ ...mono(500, 10), color: 'var(--bad)', letterSpacing: '.06em' }}>
                    DELETE PROJECT + ALL TICKETS?
                  </span>
                  <div style={{ flex: 1 }} />
                  <button
                    onClick={() => doDelete(e)}
                    disabled={deletingId === e.id}
                    style={{ border: '1px solid var(--bad)', background: 'none', color: 'var(--bad)', borderRadius: 3, padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: deletingId === e.id ? 0.5 : 1 }}
                  >
                    {deletingId === e.id ? 'Deleting…' : 'Delete'}
                  </button>
                  <button
                    onClick={() => setConfirmId(null)}
                    disabled={deletingId === e.id}
                    style={{ border: '1px solid var(--line2)', background: 'none', color: 'var(--tx2)', borderRadius: 3, padding: '3px 10px', fontSize: 11, cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    borderTop: '1px solid var(--line)',
                    paddingTop: 9,
                    fontSize: 11,
                    color: 'var(--tx2)',
                  }}
                >
                  <span style={{ ...mono(400, 10), letterSpacing: '.04em' }}>{e.phase}</span>
                  <span style={{ color: 'var(--tx3)' }}>·</span>
                  <span>{e.owner}</span>
                  <span style={{ color: 'var(--tx3)' }}>·</span>
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Next: {e.nextMilestone}</span>
                  {e.blockers > 0 && <span style={{ ...mono(500, 10), color: 'var(--bad)' }}>{e.blockers} BLOCKED</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
