import type { CSSProperties } from 'react';
import type { Health } from './types';

export const HEALTH_COLOR: Record<Health, string> = {
  ok: 'var(--ok)',
  risk: 'var(--warn)',
  off: 'var(--bad)',
};

export const HEALTH_LABEL: Record<Health, string> = {
  ok: 'ON TRACK',
  risk: 'AT RISK',
  off: 'OFF TRACK',
};

export const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  progress: 'In Progress',
  review: 'In Review',
  done: 'Done',
  proposed: 'Agent proposed',
  dismissed: 'Dismissed',
};

/** Percent position of date d within [t0, t1]. */
export function pct(t0: string, t1: string, d: string): number {
  const a = +new Date(t0);
  const b = +new Date(t1);
  return Math.max(0, Math.min(100, ((+new Date(d) - a) / (b - a)) * 100));
}

export function fmtD(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleString('en', { month: 'short', day: '2-digit' }).toUpperCase();
}

export function initials(name: string): string {
  return name
    .split(/[ .]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export const mono = (weight: number, size: number): CSSProperties => ({
  fontFamily: "'DM Mono', monospace",
  fontWeight: weight,
  fontSize: size,
});
