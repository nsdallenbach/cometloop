import type express from 'express';
import { estimateTicket } from './estimates';

/**
 * Hours population and validation (DAT-207).
 *
 * DAT-195 made `est_hours` / `human_est_hours` mandatory in the request body,
 * which turned the ticket agent's job into a human data-entry chore — and it
 * only ever held for callers that went through the console's New Ticket
 * modal. Tickets created outside the app (the stdio MCP `create_ticket` tool,
 * scripts hitting the API directly) had no form to enforce it.
 *
 * Since DAT-207 the estimates are OPTIONAL on the wire and the ticket agent
 * populates them. Every create path runs the same routine, because they all
 * land on `POST /api/engagements/:id/tickets`:
 *
 *   validate → if hours missing, run the estimation agent → re-check →
 *   ready, or flagged with the `needs-estimate-review` tag
 *
 * A ticket never persists silently incomplete: the flag tag goes on at insert
 * and only comes off once real hours exist, so a model outage leaves a
 * visible marker on the board rather than a blank estimate. The sweep routes
 * below re-run the same routine over anything still flagged.
 *
 * Caller-supplied estimates are still honoured verbatim — supplying them
 * skips the agent entirely, so DAT-195's "never clobber human input" rule
 * survives for the callers that do have figures.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;


/**
 * Visible flag for a ticket whose hours the agent has not produced yet.
 * Same tag `scripts/dev-migrate.cjs` used for the DAT-195 backfill, so the
 * board has one "estimates need attention" signal rather than two.
 */
export const NEEDS_ESTIMATE_TAG = 'needs-estimate-review';

/**
 * Placeholders written at insert when the caller supplied nothing: the
 * columns are NOT NULL, so a row cannot land empty. They are always paired
 * with {@link NEEDS_ESTIMATE_TAG}, which is what actually marks the hours as
 * un-populated — the numbers alone can't be told apart from a real 1h/4h
 * estimate.
 */
export const PROVISIONAL_EST_HOURS = 1;
export const PROVISIONAL_HUMAN_EST_HOURS = 4;

// ---------- pure helpers (unit-tested) ----------

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Tags arrive from Postgres as JSONB — an array already, or its JSON text. */
export function parseTags(raw: unknown): string[] {
  const value: unknown = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === 'string');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function hasNeedsEstimateTag(tags: string[]): boolean {
  return tags.some((t) => t.toLowerCase() === NEEDS_ESTIMATE_TAG);
}

/** Idempotent add — the flag must never pile up across repeated sweeps. */
export function withNeedsEstimateTag(tags: string[]): string[] {
  return hasNeedsEstimateTag(tags) ? tags : [...tags, NEEDS_ESTIMATE_TAG];
}

export function withoutNeedsEstimateTag(tags: string[]): string[] {
  return tags.filter((t) => t.toLowerCase() !== NEEDS_ESTIMATE_TAG);
}

/**
 * The check itself: both figures present and positive. This is the recheck
 * after the agent runs — deliberately blind to the flag tag, which the
 * caller strips once this returns true.
 */
export function hoursPopulated(estHours: unknown, humanEstHours: unknown): boolean {
  const est = numOrNull(estHours);
  const human = numOrNull(humanEstHours);
  return est != null && est > 0 && human != null && human > 0;
}

/**
 * Whether a stored ticket still needs the agent: either figure is missing, or
 * the row carries the flag (its hours are the provisional placeholders).
 */
export function hoursMissing(row: { est_hours?: unknown; human_est_hours?: unknown; tags?: unknown }): boolean {
  return !hoursPopulated(row.est_hours, row.human_est_hours) || hasNeedsEstimateTag(parseTags(row.tags));
}

// ---------- the shared populate/validate routine ----------

export interface HoursCheckInput {
  key: string;
  engagementId: string;
  title: string;
  description: string;
  ac: string[];
}

export interface HoursCheckResult {
  key: string;
  /** ready = hours are real; flagged = the agent could not produce them. */
  status: 'ready' | 'flagged';
  estHours: number | null;
  humanEstHours: number | null;
  /** True when this call had to invoke the estimation agent. */
  estimated: boolean;
}

/**
 * Validate a ticket's hours and, when they are missing, have the ticket agent
 * fill them in — the create-time hook for every path, and the unit of work
 * for the sweep endpoints. Never throws: a model outage must leave a flagged
 * ticket, not a failed create.
 */
export async function ensureTicketHours(
  q: Query,
  input: HoursCheckInput,
  kind: 'initial' | 'revised' = 'initial',
): Promise<HoursCheckResult> {
  const before = (await q('SELECT est_hours, human_est_hours, tags FROM app.tickets WHERE key = $1', [input.key]))
    .rows[0];
  if (!before) return { key: input.key, status: 'flagged', estHours: null, humanEstHours: null, estimated: false };
  if (!hoursMissing(before)) {
    return {
      key: input.key,
      status: 'ready',
      estHours: numOrNull(before.est_hours),
      humanEstHours: numOrNull(before.human_est_hours),
      estimated: false,
    };
  }

  // The ticket agent's population step — writes est/est_hours/human_est_hours
  // and appends the app.ticket_estimates row. Best-effort by contract: it
  // returns null (never throws) when the model is down or answers with
  // nothing usable.
  const agentHours = await estimateTicket(q, input, kind);

  // Recheck needs BOTH signals. The return value proves the agent actually
  // produced a figure; the row read proves it persisted and is what the board
  // will show. Reading the row alone would pass a ticket still sitting on its
  // provisional 1h/4h placeholders — those are non-null, so they look
  // populated, which is exactly the silent-incomplete case DAT-207 is about.
  const after = (await q('SELECT est_hours, human_est_hours, tags FROM app.tickets WHERE key = $1', [input.key]))
    .rows[0];
  const estHours = numOrNull(after?.est_hours);
  const humanEstHours = numOrNull(after?.human_est_hours);
  const tags = parseTags(after?.tags);
  const populated = agentHours != null && hoursPopulated(estHours, humanEstHours);

  const nextTags = populated ? withoutNeedsEstimateTag(tags) : withNeedsEstimateTag(tags);
  if (nextTags.length !== tags.length) {
    await q('UPDATE app.tickets SET tags = $2 WHERE key = $1', [input.key, JSON.stringify(nextTags)]);
  }

  if (populated) {
    console.log(`[hours] ${input.key}: agent populated ${estHours}h agent / ${humanEstHours}h human dev`);
    return { key: input.key, status: 'ready', estHours, humanEstHours, estimated: true };
  }

  // Visible, not silent: server log, the flag tag above, and a feed item so a
  // lead sees it without going looking.
  console.warn(`[hours] ${input.key}: hours still missing after the agent ran — flagged ${NEEDS_ESTIMATE_TAG}`);
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
    [
      input.engagementId,
      `${input.key} has no time estimate — the estimation agent could not produce one, so it is tagged ${NEEDS_ESTIMATE_TAG}.`,
    ],
  ).catch(() => {});
  return { key: input.key, status: 'flagged', estHours, humanEstHours, estimated: true };
}

/**
 * Drop the flag once a ticket has real hours from any source — the lead
 * typing them into the drawer counts. Without this a manual fix would leave
 * the ticket wearing "NO EST" forever and the sweep would re-estimate over
 * the figures a human just entered.
 */
export async function clearNeedsEstimateFlag(q: Query, key: string): Promise<void> {
  try {
    const row = (await q('SELECT est_hours, human_est_hours, tags FROM app.tickets WHERE key = $1', [key])).rows[0];
    if (!row || !hoursPopulated(row.est_hours, row.human_est_hours)) return;
    const tags = parseTags(row.tags);
    if (!hasNeedsEstimateTag(tags)) return;
    await q('UPDATE app.tickets SET tags = $2 WHERE key = $1', [key, JSON.stringify(withoutNeedsEstimateTag(tags))]);
    console.log(`[hours] ${key}: hours set manually — cleared ${NEEDS_ESTIMATE_TAG}`);
  } catch (err) {
    console.warn(`[hours] could not clear the estimate flag on ${key}:`, (err as Error).message);
  }
}

/** Acceptance criteria arrive as JSONB; coerce defensively for the prompt. */
export function acList(raw: unknown): string[] {
  const value: unknown = typeof raw === 'string' ? safeJson(raw) : raw;
  return Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string') : [];
}

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---------- routes ----------

const MISSING_HOURS_SQL = `SELECT key, title, description, ac, est_hours, human_est_hours, tags
   FROM app.tickets
   WHERE engagement_id = $1 AND status <> 'dismissed'
     AND (est_hours IS NULL OR est_hours <= 0 OR human_est_hours IS NULL OR human_est_hours <= 0
          OR tags @> $2::jsonb)
   ORDER BY key`;

export function setupTicketHoursRoutes(
  app: express.Application,
  q: Query,
  requireLead?: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<unknown>,
) {
  /**
   * The standing validation check: every ticket on the board whose hours are
   * missing or still flagged. Read-only, so anyone who can see the board can
   * see what is incomplete.
   */
  app.get('/api/engagements/:id/tickets/missing-hours', async (req, res) => {
    try {
      const engagementId = req.params.id;
      const rows = (await q(MISSING_HOURS_SQL, [engagementId, JSON.stringify([NEEDS_ESTIMATE_TAG])])).rows;
      res.json({
        missing: rows.map((r) => ({
          key: txt(r.key),
          title: txt(r.title),
          estHours: numOrNull(r.est_hours),
          humanEstHours: numOrNull(r.human_est_hours),
          flagged: hasNeedsEstimateTag(parseTags(r.tags)),
        })),
      });
    } catch (err) {
      console.error('missing-hours check failed:', err);
      res.status(500).json({ error: 'Failed to check ticket hours' });
    }
  });

  /**
   * Backfill sweep for anything the check found — the recovery path for
   * tickets that landed while the serving endpoint was down. Responds
   * immediately and runs the model calls sequentially in the background,
   * matching the DAT-197 estimate backfill.
   */
  if (requireLead) {
    app.post('/api/engagements/:id/tickets/missing-hours/backfill', async (req, res) => {
      try {
        const engagementId = req.params.id;
        if (!(await requireLead(req, res, engagementId))) return;
        const rows = (await q(MISSING_HOURS_SQL, [engagementId, JSON.stringify([NEEDS_ESTIMATE_TAG])])).rows;
        res.json({ ok: true, started: rows.length });
        if (rows.length === 0) return;
        void (async () => {
          let ready = 0;
          for (const r of rows) {
            const result = await ensureTicketHours(
              q,
              {
                key: txt(r.key),
                engagementId,
                title: txt(r.title),
                description: txt(r.description),
                ac: acList(r.ac),
              },
              'revised',
            );
            if (result.status === 'ready') ready++;
          }
          const stillFlagged = rows.length - ready;
          console.log(`[hours] backfill for ${engagementId}: ${ready}/${rows.length} tickets now have hours`);
          await q(
            `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
             VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
            [
              engagementId,
              `Hours backfill complete — ${ready} of ${rows.length} tickets estimated${stillFlagged > 0 ? `, ${stillFlagged} still tagged ${NEEDS_ESTIMATE_TAG}` : ''}.`,
            ],
          ).catch(() => {});
        })();
      } catch (err) {
        console.error('missing-hours backfill failed:', err);
        res.status(500).json({ error: 'Failed to start hours backfill' });
      }
    });
  }
}
