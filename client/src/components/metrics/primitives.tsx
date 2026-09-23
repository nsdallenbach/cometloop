import type { CSSProperties, ReactNode } from 'react';
import { mono } from '../../util';

/**
 * The Metrics page's building blocks — the same card, legend, KPI tile and
 * empty-state idioms the Analytics tab uses, so the two read as one system.
 */

export function Card({ title, caption, children, style }: { title: string; caption?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', overflow: 'hidden', minWidth: 0, ...style }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px' }}>
        <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>{title}</span>
        {caption && <span style={{ fontSize: 11.5, color: 'var(--tx2)' }}>{caption}</span>}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  );
}

export function LegendRow({ items }: { items: { label: string; color: string; n?: string | number }[] }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', alignItems: 'center', marginBottom: 4 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...mono(400, 10), color: 'var(--tx2)', letterSpacing: '.06em' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color, flexShrink: 0 }} />
          {it.label}
          {it.n != null && <b style={{ color: 'var(--tx)' }}>{it.n}</b>}
        </span>
      ))}
    </div>
  );
}

/** Stat tile: label · value · one-line context, matching the Analytics KPI. */
export function Kpi({ label, value, sub, color, big }: { label: string; value: string; sub?: string; color?: string; big?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, background: 'var(--bg2)', padding: '12px 14px', minWidth: 0 }}>
      <div style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: big ? 30 : 22, fontWeight: 600, color: 'var(--tx)', lineHeight: 1, overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ ...mono(400, 10), color: color ?? 'var(--tx3)', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

export function SectionHead({ title, caption }: { title: string; caption: string }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 10px', margin: '22px 0 12px' }}>
      <span style={{ ...mono(500, 10), color: 'var(--tx3)', letterSpacing: '.08em' }}>{title}</span>
      <span style={{ ...mono(400, 10), color: 'var(--tx3)' }}>{caption}</span>
    </div>
  );
}

/** Centered mono note inside a card when a chart has nothing to draw. */
export function Empty({ children }: { children: ReactNode }) {
  return <div style={{ ...mono(400, 10), color: 'var(--tx3)', padding: '18px 0', textAlign: 'center', letterSpacing: '.04em' }}>{children}</div>;
}

/** Horizontal share bars — the "where work waits" idiom; one row per entity. */
export function HBars({
  rows,
}: {
  rows: { key: string; label: string; sub?: string; value: number; display: string; color: string }[];
}) {
  const max = Math.max(0.0001, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 0' }}>
      {rows.map((r) => (
        <div key={r.key}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, marginBottom: 4, minWidth: 0 }}>
            <span style={{ ...mono(500, 10), color: 'var(--tx2)', letterSpacing: '.06em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.label.toUpperCase()}
              {r.sub && <span style={{ ...mono(400, 9), color: 'var(--tx3)', marginLeft: 6 }}>{r.sub}</span>}
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--tx)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.display}</span>
          </div>
          <div style={{ height: 5, borderRadius: 2, background: 'var(--bg3)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(2, Math.round((r.value / max) * 100))}%`, borderRadius: 2, background: r.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}
