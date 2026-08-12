import { z } from 'zod';
import type express from 'express';

/**
 * LLM-hours estimation loop (DAT-120): the serving endpoint reviews each
 * ticket at creation (and re-estimates after a refine) and predicts how many
 * hours of actual agent/LLM working time it will take, to one decimal place.
 * When the ticket is marked ready for review, the actual agent time — summed
 * from the ticket's agent_tasks run durations — is logged next to the
 * estimate. That history drives a per-engagement calibration factor (median
 * actual/estimate ratio) applied to every subsequent estimate, and the most
 * recent estimate-vs-actual pairs are fed back to the model as examples, so
 * estimates converge on each project's real velocity over time.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

type Serving = (alias: string) => { invoke(body: unknown): Promise<unknown> };

export const ESTIMATE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.ticket_estimates (
    id SERIAL PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'initial',
    raw_hours NUMERIC(6,1) NOT NULL,
    est_hours NUMERIC(6,1) NOT NULL,
    calibration NUMERIC(6,3) NOT NULL DEFAULT 1,
    confidence TEXT NOT NULL DEFAULT 'medium',
    rationale TEXT NOT NULL DEFAULT '',
    actual_hours NUMERIC(7,1),
    actual_source TEXT,
    actual_recorded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS ticket_estimates_engagement ON app.ticket_estimates (engagement_id, created_at)`,
  // Latest estimate and recorded actual, denormalized onto the ticket so the
  // board and drawer get them with the row they already load.
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS est_hours NUMERIC(6,1)`,
  `ALTER TABLE app.tickets ADD COLUMN IF NOT EXISTS actual_hours NUMERIC(7,1)`,
];

// ---------- pure helpers (unit-tested) ----------

export const MIN_HOURS = 0.1;
export const MAX_HOURS = 999;

/** One-decimal hours, clamped to the range the schema stores. */
export function clampHours(n: number): number {
  const rounded = Math.round(n * 10) / 10;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, rounded));
}

/**
 * Per-engagement calibration: the median actual/estimate ratio of completed
 * tickets. Needs at least 3 samples to move off 1.0 (a single outlier must
 * not swing new estimates), and stays within [0.3, 3] so a run of bad data
 * can never push estimates into nonsense.
 */
export function calibrationFactor(ratios: number[]): number {
  const valid = ratios.filter((r) => Number.isFinite(r) && r > 0);
  if (valid.length < 3) return 1;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(Math.min(3, Math.max(0.3, median)) * 1000) / 1000;
}

const EstimateOutput = z.object({
  hours: z.number().positive(),
  confidence: z.enum(['low', 'medium', 'high']).catch('medium'),
  rationale: z.string().catch(''),
});

export interface ParsedEstimate {
  hours: number;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

/** Extract the {"hours": …} JSON object from a model response, or null. */
export function parseEstimateOutput(text: string): ParsedEstimate | null {
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) return null;
  try {
    const parsed = EstimateOutput.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) return null;
    return {
      hours: clampHours(parsed.data.hours),
      confidence: parsed.data.confidence,
      rationale: parsed.data.rationale.trim().slice(0, 1000),
    };
  } catch {
    return null;
  }
}

export interface AgentRun {
  state: string;
  claimed_at: unknown;
  updated_at: unknown;
}

const TERMINAL_STATES = ['done', 'failed', 'cancelled'];

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Actual LLM working time for a ticket: the sum of its agent runs' active
 * durations (claim → completion for finished runs, claim → now for a run
 * still active when the ticket is dragged to Review). Null when no run was
 * ever claimed — there is no LLM time to log for purely human work.
 */
export function agentHoursFromRuns(runs: AgentRun[], now: Date = new Date()): number | null {
  let ms = 0;
  let counted = 0;
  for (const run of runs) {
    const start = asDate(run.claimed_at);
    if (!start) continue;
    const end = (TERMINAL_STATES.includes(run.state) ? asDate(run.updated_at) : null) ?? now;
    if (end.getTime() <= start.getTime()) continue;
    ms += end.getTime() - start.getTime();
    counted++;
  }
  if (counted === 0) return null;
  return clampHours(ms / 3_600_000);
}

// ---------- model invocation ----------

/** Same ExecutionResult unwrapping as the planning endpoints in api.ts. */
function extractModelText(response: unknown): string {
  let payload = response;
  if (payload && typeof payload === 'object' && 'ok' in payload) {
    const wrapper = payload as { ok: boolean; data?: unknown; message?: string };
    if (!wrapper.ok) throw new Error(wrapper.message ?? 'model invocation failed');
    payload = wrapper.data;
  }
  const r = payload as { choices?: { message?: { content?: unknown } }[] };
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const part = c as { type?: string; text?: string };
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface EstimateInput {
  key: string;
  engagementId: string;
  title: string;
  description: string;
  ac: string[];
}

/**
 * Estimate a ticket's LLM hours via the serving endpoint and store the result:
 * updates the ticket's est/est_hours and appends an app.ticket_estimates row.
 * Failures log and return null — estimation is best-effort and must never
 * block ticket creation.
 */
export async function estimateTicket(
  q: Query,
  serving: Serving,
  input: EstimateInput,
  kind: 'initial' | 'revised'
): Promise<number | null> {
  try {
    const engagement = (await q('SELECT client, name, phase FROM app.engagements WHERE id = $1', [input.engagementId]))
      .rows[0];
    // Completed estimate-vs-actual pairs for this engagement: the newest few
    // ground the model as examples, the rest feed the calibration factor.
    const history = (
      await q(
        `SELECT e.est_hours, e.actual_hours, t.title
         FROM app.ticket_estimates e JOIN app.tickets t ON t.key = e.ticket_key
         WHERE e.engagement_id = $1 AND e.actual_hours IS NOT NULL AND e.est_hours > 0
         ORDER BY e.actual_recorded_at DESC NULLS LAST, e.id DESC LIMIT 20`,
        [input.engagementId]
      )
    ).rows;
    const ratios = history
      .map((h) => {
        const est = num(h.est_hours);
        const actual = num(h.actual_hours);
        return est && actual ? actual / est : NaN;
      })
      .filter((r) => Number.isFinite(r));
    const factor = calibrationFactor(ratios);
    const examples = history
      .slice(0, 6)
      .map((h) => `- "${txt(h.title)}" — estimated ${num(h.est_hours)}h, actually took ${num(h.actual_hours)}h`);

    const prompt = [
      'You are the delivery-estimation agent for a consulting delivery board. Tickets on this board are worked by autonomous LLM coding agents (Claude Code on devbox runners). Estimate how many hours of actual agent working time this ticket will take from claim to ready-for-review.',
      `Engagement: ${txt(engagement?.name) || input.engagementId} for ${txt(engagement?.client) || 'the client'}. Phase: ${txt(engagement?.phase) || 'n/a'}.`,
      `Ticket ${input.key}: ${input.title}`,
      input.description.trim()
        ? `Description:\n${input.description.trim()}`
        : 'No description — the title is the scope.',
      input.ac.length > 0 ? `Acceptance criteria:\n${input.ac.map((a) => `- ${a}`).join('\n')}` : '',
      examples.length > 0
        ? `Completed tickets on this engagement, estimated vs actual agent hours — weigh these heavily, they reflect this project's real velocity:\n${examples.join('\n')}`
        : 'No completed history for this engagement yet — estimate from the ticket scope alone.',
      'Agent working time is typically far less than human effort for the same scope: a small well-scoped change is often under an hour; multi-system work with tests and review rounds can take several.',
      'Respond with ONLY a JSON object, no code fences:',
      '{"hours": 1.5, "confidence": "low|medium|high", "rationale": "1-2 sentences on what drives the estimate"}',
      'hours is a decimal with at most one digit after the point, minimum 0.1.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await serving('default').invoke({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
    });
    const parsed = parseEstimateOutput(extractModelText(response));
    if (!parsed) {
      console.warn(`[estimate] ${input.key}: model response held no usable estimate`);
      return null;
    }
    const calibrated = clampHours(parsed.hours * factor);
    await q(
      `INSERT INTO app.ticket_estimates (ticket_key, engagement_id, kind, raw_hours, est_hours, calibration, confidence, rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.key, input.engagementId, kind, parsed.hours, calibrated, factor, parsed.confidence, parsed.rationale]
    );
    await q(`UPDATE app.tickets SET est = $2, est_hours = $3 WHERE key = $1`, [
      input.key,
      `${calibrated}h`,
      calibrated,
    ]);
    console.log(
      `[estimate] ${input.key} ${kind}: ${calibrated}h agent time (model ${parsed.hours}h × calibration ${factor}, ${parsed.confidence} confidence, ${ratios.length} samples)`
    );
    return calibrated;
  } catch (err) {
    console.warn(`[estimate] ${input.key} estimation failed:`, (err as Error).message);
    return null;
  }
}

/**
 * Log actual LLM time when a ticket is marked ready for review: sums the
 * ticket's agent run durations, stores the result on the ticket and on its
 * latest estimate row (closing the loop for calibration), and posts the
 * estimate-vs-actual comparison to the feed. Safe to call on every Review
 * transition — re-reviews simply refresh the recorded actual.
 */
export async function recordActualHours(q: Query, ticketKey: string, source: string): Promise<void> {
  try {
    const runs = (
      await q(
        `SELECT state, claimed_at, updated_at FROM app.agent_tasks WHERE ticket_key = $1 AND claimed_at IS NOT NULL`,
        [ticketKey]
      )
    ).rows as unknown as AgentRun[];
    const actual = agentHoursFromRuns(runs);
    if (actual == null) {
      console.log(`[estimate] ${ticketKey} moved to review with no claimed agent runs — no LLM time to log`);
      return;
    }
    const updated = (
      await q(`UPDATE app.tickets SET actual_hours = $2 WHERE key = $1 RETURNING engagement_id, est_hours`, [
        ticketKey,
        actual,
      ])
    ).rows[0];
    if (!updated) return;
    await q(
      `UPDATE app.ticket_estimates SET actual_hours = $2, actual_source = $3, actual_recorded_at = NOW()
       WHERE id = (SELECT id FROM app.ticket_estimates WHERE ticket_key = $1 ORDER BY id DESC LIMIT 1)`,
      [ticketKey, actual, source]
    );
    const est = num(updated.est_hours);
    const accuracy = est && est > 0 ? ` vs ${est}h estimated (${Math.round((actual / est) * 100)}%)` : '';
    console.log(`[estimate] ${ticketKey} actual agent time logged: ${actual}h${accuracy} (${source})`);
    await q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
       VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
      [String(updated.engagement_id), `Logged ${actual}h of actual agent time on ${ticketKey}${accuracy}.`]
    );
  } catch (err) {
    console.warn(`[estimate] recording actual hours for ${ticketKey} failed:`, (err as Error).message);
  }
}

// ---------- routes ----------

export function setupEstimateRoutes(app: express.Application, q: Query) {
  /**
   * Estimation accuracy for an engagement: every estimate with a recorded
   * actual, plus the summary stats and the calibration factor new estimates
   * are currently multiplied by.
   */
  app.get('/api/engagements/:id/estimate-accuracy', async (req, res) => {
    try {
      const engagementId = req.params.id;
      if ((await q('SELECT 1 FROM app.engagements WHERE id = $1', [engagementId])).rows.length === 0) {
        res.status(404).json({ error: 'Engagement not found' });
        return;
      }
      const rows = (
        await q(
          `SELECT e.ticket_key, t.title, e.kind, e.est_hours, e.actual_hours, e.confidence, e.rationale,
                  e.calibration, e.actual_recorded_at, e.created_at
           FROM app.ticket_estimates e JOIN app.tickets t ON t.key = e.ticket_key
           WHERE e.engagement_id = $1
           ORDER BY e.id DESC LIMIT 200`,
          [engagementId]
        )
      ).rows;
      const completed = rows
        .map((r) => ({ est: num(r.est_hours), actual: num(r.actual_hours) }))
        .filter((r): r is { est: number; actual: number } => r.est != null && r.est > 0 && r.actual != null);
      const ratios = completed.map((r) => r.actual / r.est);
      const meanAbsErrPct =
        completed.length > 0
          ? Math.round(
              (completed.reduce((sum, r) => sum + Math.abs(r.actual - r.est) / r.est, 0) / completed.length) * 100
            )
          : null;
      res.json({
        rows,
        summary: {
          estimates: rows.length,
          completed: completed.length,
          calibration: calibrationFactor(ratios),
          meanAbsErrPct,
        },
      });
    } catch (err) {
      console.error('estimate accuracy failed:', err);
      res.status(500).json({ error: 'Failed to load estimate accuracy' });
    }
  });
}
