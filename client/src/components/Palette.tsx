import { useState } from 'react';
import { mono } from '../util';

export interface PaletteItem {
  kind: string;
  label: string;
  hint: string;
  run: () => void;
}

export function Palette({
  theme,
  items,
  onClose,
}: {
  theme: 'dark' | 'light';
  items: PaletteItem[];
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const pq = q.trim().toLowerCase();
  const filtered = (pq ? items.filter((i) => i.label.toLowerCase().includes(pq)) : items).slice(0, 9);
  const activeIdx = Math.min(active, Math.max(0, filtered.length - 1));

  const runItem = (item: PaletteItem) => {
    onClose();
    item.run();
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 50 }} />
      <div
        data-theme={theme}
        className="eec"
        style={{
          position: 'fixed',
          top: 110,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 560,
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 6,
          zIndex: 51,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(0,0,0,.5)',
          animation: 'eec-fadeUp .15s ease',
          color: 'var(--tx)',
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive(Math.min(activeIdx + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive(Math.max(activeIdx - 1, 0));
            } else if (e.key === 'Enter' && filtered[activeIdx]) {
              e.preventDefault();
              runItem(filtered[activeIdx]);
            }
          }}
          placeholder="Type a command or search tickets…"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: 'none',
            border: 'none',
            borderBottom: '1px solid var(--line)',
            color: 'var(--tx)',
            padding: '14px 16px',
            fontSize: 14,
            outline: 'none',
          }}
        />
        <div style={{ maxHeight: 320, overflowY: 'auto', padding: 6 }}>
          {filtered.length === 0 && (
            <div style={{ padding: '14px 11px', fontSize: 12.5, color: 'var(--tx3)' }}>No matching commands or tickets.</div>
          )}
          {filtered.map((r, i) => (
            <div
              key={r.kind + r.label}
              className="hv-bg"
              onClick={() => runItem(r)}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                padding: '9px 11px',
                borderRadius: 3,
                cursor: 'pointer',
                background: i === activeIdx ? 'var(--bg3)' : 'transparent',
              }}
            >
              <span
                style={{
                  ...mono(500, 9),
                  color: 'var(--tx3)',
                  border: '1px solid var(--line2)',
                  borderRadius: 2,
                  padding: '2px 6px',
                  letterSpacing: '.06em',
                  width: 52,
                  textAlign: 'center',
                }}
              >
                {r.kind}
              </span>
              <span style={{ fontSize: 13 }}>{r.label}</span>
              <span style={{ marginLeft: 'auto', ...mono(400, 10), color: 'var(--tx3)' }}>{r.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
