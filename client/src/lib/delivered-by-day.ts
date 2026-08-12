import type { Ticket } from '../types';

/** Fallback conversion for legacy day-based est strings ('3d'), matching the roadmap default. */
const LEGACY_HOURS_PER_DAY = 6;

export type DeliveredDay = {
  date: string;
  hours: number;
  tickets: number;
};

/** Agent hours for a ticket: logged actuals win, then the model estimate, then legacy est strings ('6h', '3d'). */
export function agentHoursOf(t: Ticket): number {
  if (t.actualHours != null) return t.actualHours;
  if (t.estHours != null) return t.estHours;
  const h = /^(\d+(?:\.\d+)?)\s*h$/i.exec(t.est.trim());
  if (h) return Number(h[1]);
  const d = /^(\d+(?:\.\d+)?)\s*d$/i.exec(t.est.trim());
  if (d) return Number(d[1]) * LEGACY_HOURS_PER_DAY;
  return 0;
}

/**
 * Done tickets bucketed per day for the trailing window: agent hours delivered
 * and tickets completed. Only tickets with a done status count, dated by the
 * day they entered Done.
 */
export function deliveredByDay(tickets: Ticket[], days: number, today: Date = new Date()): DeliveredDay[] {
  const end = new Date(today);
  end.setHours(0, 0, 0, 0);
  const buckets: DeliveredDay[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(end);
    d.setDate(d.getDate() - (days - 1 - i));
    return { date: d.toISOString().slice(0, 10), hours: 0, tickets: 0 };
  });
  const idx = new Map(buckets.map((b, i) => [b.date, i]));
  for (const t of tickets) {
    if (t.status !== 'done' || t.doneAt == null) continue;
    const i = idx.get(t.doneAt.slice(0, 10));
    if (i == null) continue;
    buckets[i].hours += agentHoursOf(t);
    buckets[i].tickets += 1;
  }
  // Keep hour sums presentable — float accumulation would otherwise leak 13.700000000000001 into tooltips.
  for (const b of buckets) b.hours = Math.round(b.hours * 10) / 10;
  return buckets;
}
