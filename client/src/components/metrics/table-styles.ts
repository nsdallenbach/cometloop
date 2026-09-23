import type { CSSProperties } from 'react';

/** Header and cell styles for the Metrics tables — mono uppercase headers, tabular figures right-aligned. */

export const th = (align: 'left' | 'right' = 'left'): CSSProperties => ({
  textAlign: align,
  fontFamily: "'DM Mono', monospace",
  fontSize: 9.5,
  color: 'var(--tx3)',
  letterSpacing: '.08em',
  padding: '4px 4px',
  fontWeight: 500,
  borderBottom: '1px solid var(--line)',
  whiteSpace: 'nowrap',
});

export const td = (align: 'left' | 'right' = 'left'): CSSProperties => ({
  textAlign: align,
  padding: '6px 4px',
  color: align === 'right' ? 'var(--tx)' : 'var(--tx2)',
  fontVariantNumeric: align === 'right' ? 'tabular-nums' : undefined,
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
});
