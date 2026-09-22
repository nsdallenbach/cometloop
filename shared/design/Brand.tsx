import type { CSSProperties } from 'react';

/**
 * The Cometloop mark and wordmark, shared by the web console (top bar,
 * signed-out screen) and the desktop client (title bar) so both shells carry
 * the same brand — parity by construction, like AgentLogos.tsx. The public
 * site (cometloop.ai) renders the same mark from its own copy.
 *
 * The mark: an orbit with a comet on it — the head is the dot, the bright arc
 * behind it is the tail, the faint ring is the loop it keeps running. Drawn in
 * the accent token so it follows the theme; scales from favicon to hero.
 * client/public/favicon.svg and desktop/resources/icon.svg are the same
 * geometry on a dark tile with the accent colour baked in.
 *
 * This module never imports from its consumers: the mono() helper is inlined
 * (it mirrors client/src/util.ts) rather than imported from the client.
 */

const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});

export function CometMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <circle cx="16" cy="16" r="11" stroke="var(--acc)" strokeOpacity="0.28" strokeWidth="3" />
      {/* tail: a third of the orbit, ending at the head (top right) */}
      <path d="M6.47 21.5 A11 11 0 0 1 23.78 8.22" stroke="var(--acc)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="23.78" cy="8.22" r="4" fill="var(--acc)" />
    </svg>
  );
}

/**
 * Mark + "COMETLOOP" in the console's uppercase mono idiom. `size` is the mark
 * size; the text scales with it (12px at the default 20px mark, the top-bar
 * weight the console has always used). `color` defaults to the primary text
 * token so the wordmark reads on both themes.
 */
export function Wordmark({ size = 20, color = 'var(--tx)' }: { size?: number; color?: string }) {
  const text = Math.round(size * 0.6);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <CometMark size={size} />
      <span style={{ ...mono(500, text), letterSpacing: '.12em', color }}>COMETLOOP</span>
    </span>
  );
}
