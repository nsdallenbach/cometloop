import type express from 'express';
import { z } from 'zod';
import { createNotification } from './notifications';
import type { Caller } from './roles';

/**
 * Stale-ticket nudges (DAT-107): a ticket sitting in `progress` or `review`
 * with no activity for N business days nudges its assignee through the
 * notification centre (DAT-105) — or the engagement leads when the ticket has
 * no human assignee.
 *
 * Activity is the DAT-101 event trail (`app.ticket_events`) plus human/agent
 * comments (`app.ticket_comments.created_at`). Comments authored by the
 * console itself ('Delivery Console' — review-SLA pings and the like) do not
 * count: an automated chaser must never reset the very clock it chases.
 *
 * One nudge per quiet period, not one per day: a nudge row is keyed on
 * (ticket, quiet_since) where quiet_since is the last-activity timestamp the
 * nudge fired against. While nothing touches the ticket that timestamp never
 * moves, so the unique key makes the INSERT a claim — a re-poll, two app
 * replicas, or a manual sweep can never send the same nudge twice. New
 * activity moves quiet_since forward and thereby opens the next quiet period.
 *
 * The threshold defaults to 5 business days (Sat/Sun never count) and is
 * configurable per engagement in `app.nudge_settings`, editable from the
 * Config tab. The nudge itself lands in `app.notifications`, which is also
 * what the email digest (`GET /api/notifications/digest`) renders — so a
 * nudge is in the digest by construction.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const STALE_NUDGE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.nudge_settings (
    engagement_id TEXT PRIMARY KEY REFERENCES app.engagements(id) ON DELETE CASCADE,
    quiet_days INT NOT NULL DEFAULT 5,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.ticket_nudges (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    engagement_id TEXT NOT NULL,
    -- Last activity the nudge fired against; the (ticket, quiet_since) pair
    -- IS the "one nudge per quiet period" rule, enforced by the database.
    quiet_since TIMESTAMPTZ NOT NULL,
    nudged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recipients JSONB NOT NULL DEFAULT '[]'
  )`,
  // The one-nudge-per-quiet-period claim. A separate unique INDEX rather than
  // an inline table constraint so ON CONFLICT resolves it everywhere — real
  // Postgres treats them identically, pg-mem only registers the index form.
  `CREATE UNIQUE INDEX IF NOT EXISTS ticket_nudges_quiet_period ON app.ticket_nudges (ticket_key, quiet_since)`,
  `CREATE INDEX IF NOT EXISTS ticket_nudges_engagement ON app.ticket_nudges (engagement_id, nudged_at)`,
];

export const DEFAULT_QUIET_DAYS = 5;
export const MIN_QUIET_DAYS = 1;
export const MAX_QUIET_DAYS = 30;

/** Board statuses a nudge applies to — work that claims to be moving. */
export const NUDGE_STATUSES = ['progress', 'review'] as const;

/** Comments by this author are console automation, never ticket activity. */
const CONSOLE_AUTHOR = 'Delivery Console';

const DAY_MS = 86_400_000;

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Postgres timestamps arrive as Date or string depending on the driver path. */
function toMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && v) {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/**
 * Whole business days elapsed between two instants: count each full 24h step
 * from `startMs` whose end lands on a weekday (UTC). Quiet since Monday 09:00
 * reaches 5 business days the following Monday 09:00 — the weekend steps
 * exist but score nothing.
 */
export function businessDaysBetween(startMs: number, endMs: number): number {
  if (endMs <= startMs) return 0;
  const steps = Math.floor((endMs - startMs) / DAY_MS);
  let days = 0;
  for (let k = 1; k <= steps; k++) {
    const weekday = new Date(startMs + k * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days++;
  }
  return days;
}

/** A stored or submitted threshold, forced into the sane range. */
export function clampQuietDays(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_QUIET_DAYS;
  return Math.min(MAX_QUIET_DAYS, Math.max(MIN_QUIET_DAYS, Math.round(n)));
}

/**
 * Who a stale ticket nudges: the assignee when it is a person (an email —
 * runner names like `desktop-xyz` aren't inboxes), otherwise the engagement
 * leads. An engagement with neither configured has nobody to tell; the
 * ticket is skipped rather than claimed, so the nudge still fires the moment
 * a lead is recorded.
 */
export async function resolveNudgeRecipients(
  q: Query,
  engagementId: string,
  assignee: string,
): Promise<{ recipients: string[]; assigneeNudged: boolean }> {
  const person = assignee.trim().toLowerCase();
  if (person.includes('@')) return { recipients: [person], assigneeNudged: true };
  const leads = (await q('SELECT email FROM app.engagement_leads WHERE engagement_id = $1 ORDER BY email', [engagementId])).rows
    .map((r) => asText(r.email).trim().toLowerCase())
    .filter(Boolean);
  return { recipients: [...new Set(leads)], assigneeNudged: false };
}

export interface NudgeRun {
  /** Tickets on the board in a nudgeable status. */
  candidates: number;
  /** Nudges actually sent this pass. */
  nudged: number;
}

export interface NudgeDeps {
  now(): number;
}

/**
 * One pass over the board: find tickets quiet past their engagement's
 * threshold and nudge each exactly once per quiet period. Safe to call as
 * often as you like — the (ticket, quiet_since) claim is what prevents
 * duplicates, not the caller's cadence.
 */
export async function checkStaleNudges(q: Query, overrides: Partial<NudgeDeps> = {}): Promise<NudgeRun> {
  const now = overrides.now ?? (() => Date.now());
  const run: NudgeRun = { candidates: 0, nudged: 0 };

  const tickets = (
    await q(
      `SELECT key, engagement_id, title, assignee, status FROM app.tickets
       WHERE status IN (${NUDGE_STATUSES.map((s) => `'${s}'`).join(',')}) ORDER BY key`,
    )
  ).rows;
  run.candidates = tickets.length;
  if (tickets.length === 0) return run;

  const settings = new Map<string, number>();
  for (const row of (await q('SELECT engagement_id, quiet_days FROM app.nudge_settings')).rows) {
    settings.set(asText(row.engagement_id), clampQuietDays(row.quiet_days));
  }
  const lastEvent = new Map<string, number>();
  for (const row of (await q('SELECT ticket_key, MAX(created_at) AS last FROM app.ticket_events GROUP BY ticket_key')).rows) {
    const ms = toMs(row.last);
    if (ms !== null) lastEvent.set(asText(row.ticket_key), ms);
  }
  const lastComment = new Map<string, number>();
  for (const row of (
    await q('SELECT ticket_key, MAX(created_at) AS last FROM app.ticket_comments WHERE author <> $1 GROUP BY ticket_key', [
      CONSOLE_AUTHOR,
    ])
  ).rows) {
    const ms = toMs(row.last);
    if (ms !== null) lastComment.set(asText(row.ticket_key), ms);
  }

  for (const ticket of tickets) {
    const key = asText(ticket.key);
    const engagementId = asText(ticket.engagement_id);
    const status = asText(ticket.status);
    const lastActivityMs = Math.max(lastEvent.get(key) ?? -Infinity, lastComment.get(key) ?? -Infinity);
    // No trail at all (backfill hasn't run) — quietness can't be judged.
    if (!Number.isFinite(lastActivityMs)) continue;

    const quietDays = settings.get(engagementId) ?? DEFAULT_QUIET_DAYS;
    const nowMs = now();
    const quietFor = businessDaysBetween(lastActivityMs, nowMs);
    if (quietFor < quietDays) continue;

    const { recipients, assigneeNudged } = await resolveNudgeRecipients(q, engagementId, asText(ticket.assignee));
    if (recipients.length === 0) continue;

    // Claim the quiet period before dispatching: a second sweep racing this
    // one loses the INSERT and sends nothing (AC: exactly one nudge, no spam).
    // The SELECT handles the common case (a later sweep of the same quiet
    // period); the ON CONFLICT is the true race guard for two concurrent
    // sweeps — pg-mem wrongly RETURNING-s a row on a suppressed conflict, so
    // the claim must not rely on RETURNING alone.
    const quietSince = new Date(lastActivityMs).toISOString();
    const seen = (await q('SELECT 1 FROM app.ticket_nudges WHERE ticket_key = $1 AND quiet_since = $2', [key, quietSince])).rows;
    if (seen.length > 0) continue;
    const claimed = (
      await q(
        `INSERT INTO app.ticket_nudges (ticket_key, engagement_id, quiet_since, recipients)
         VALUES ($1,$2,$3,$4) ON CONFLICT (ticket_key, quiet_since) DO NOTHING RETURNING id`,
        [key, engagementId, quietSince, JSON.stringify(recipients)],
      )
    ).rows;
    if (claimed.length === 0) continue;

    const title = asText(ticket.title);
    const lane = status === 'review' ? 'Review' : 'In Progress';
    const sinceLabel = new Date(lastActivityMs).toISOString().slice(0, 10);
    for (const recipient of recipients) {
      await createNotification(q, {
        recipient,
        type: 'stale_nudge',
        title: assigneeNudged
          ? `${key} has been quiet for ${String(quietFor)} business days`
          : `${key} is unassigned and quiet for ${String(quietFor)} business days`,
        message: assigneeNudged
          ? `"${title}" has sat in ${lane} with no status change or comment since ${sinceLabel}. Move it along, or comment with what it is waiting on.`
          : `"${title}" sits in ${lane} with nobody assigned and no activity since ${sinceLabel}. Assign it or move it off the board.`,
        ticketKey: key,
        engagementId,
      });
    }
    await q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
       VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
      [
        engagementId,
        `💤 ${key} quiet for ${String(quietFor)} business days in ${lane} — nudged ${assigneeNudged ? recipients[0] : `the engagement lead${recipients.length === 1 ? '' : 's'} (${recipients.join(', ')})`}.`,
      ],
    );
    console.log(`[stale-nudges] ${key} quiet ${String(quietFor)}bd (threshold ${String(quietDays)}) — nudged ${recipients.join(', ')}`);
    run.nudged++;
  }

  return run;
}

// ---------- per-engagement settings routes ----------

const SettingsBody = z.object({ quietDays: z.number().int().min(MIN_QUIET_DAYS).max(MAX_QUIET_DAYS) });

interface SettingsPayload {
  quietDays: number;
  configured: boolean;
  defaultQuietDays: number;
  minQuietDays: number;
  maxQuietDays: number;
  updatedBy: string;
  updatedAt: string | null;
}

function settingsPayload(row: Record<string, unknown> | undefined): SettingsPayload {
  const updatedMs = row ? toMs(row.updated_at) : null;
  return {
    quietDays: row ? clampQuietDays(row.quiet_days) : DEFAULT_QUIET_DAYS,
    configured: row != null,
    defaultQuietDays: DEFAULT_QUIET_DAYS,
    minQuietDays: MIN_QUIET_DAYS,
    maxQuietDays: MAX_QUIET_DAYS,
    updatedBy: row ? asText(row.updated_by) : '',
    updatedAt: updatedMs === null ? null : new Date(updatedMs).toISOString(),
  };
}

export function setupStaleNudgeRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
): void {
  app.get('/api/engagements/:id/nudge-settings', async (req, res) => {
    try {
      const engagementId = req.params.id;
      if ((await q('SELECT 1 FROM app.engagements WHERE id = $1', [engagementId])).rows.length === 0) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const row = (await q('SELECT * FROM app.nudge_settings WHERE engagement_id = $1', [engagementId])).rows[0];
      res.json(settingsPayload(row));
    } catch (err) {
      console.error('nudge settings load failed:', err);
      res.status(500).json({ error: 'Failed to load nudge settings' });
    }
  });

  app.put('/api/engagements/:id/nudge-settings', async (req, res) => {
    const parsed = SettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: `quietDays must be a whole number of business days between ${String(MIN_QUIET_DAYS)} and ${String(MAX_QUIET_DAYS)}`,
      });
      return;
    }
    try {
      const engagementId = req.params.id;
      if ((await q('SELECT 1 FROM app.engagements WHERE id = $1', [engagementId])).rows.length === 0) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const lead = await requireLead(req, res, engagementId);
      if (!lead) return;
      const saved = (
        await q(
          `INSERT INTO app.nudge_settings (engagement_id, quiet_days, updated_by, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (engagement_id) DO UPDATE SET quiet_days = $2, updated_by = $3, updated_at = NOW()
           RETURNING *`,
          [engagementId, parsed.data.quietDays, lead.email],
        )
      ).rows[0];
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', false)`,
        [engagementId, `Stale-ticket nudge threshold set to ${String(parsed.data.quietDays)} business days.`],
      );
      console.log(`[stale-nudges] ${engagementId} threshold → ${String(parsed.data.quietDays)}bd (${lead.email})`);
      res.json(settingsPayload(saved));
    } catch (err) {
      console.error('nudge settings save failed:', err);
      res.status(500).json({ error: 'Failed to save nudge settings' });
    }
  });
}

/**
 * Background sweep. Staleness moves at the speed of days, so a slow cadence
 * is plenty; every pass is idempotent thanks to the quiet-period claim.
 */
export function startStaleNudgePolling(q: Query, intervalMs = 30 * 60_000): void {
  const tick = async () => {
    try {
      const run = await checkStaleNudges(q);
      if (run.nudged > 0) console.log(`[stale-nudges] ${String(run.candidates)} candidates, ${String(run.nudged)} nudged`);
    } catch (err) {
      console.warn('[stale-nudges] sweep failed:', (err as Error).message);
    }
  };
  setInterval(() => void tick(), intervalMs).unref?.();
}
