import type express from 'express';
import type { Caller } from './roles';
import { adoApi, adoHeaders, githubHeaders, githubPath, jsonFetch, loadConnection, connectionToken, type Connection } from './repos';
import { postPrComment } from './pr-conflicts';

/**
 * Review-SLA escalation for agent-raised PRs (DAT-201).
 *
 * A runner finishes a ticket by opening a PR and stops — humans merge. Nothing
 * used to chase the review, so a PR could sit untouched indefinitely while the
 * ticket held in Review. This module puts a clock on it:
 *
 *   PR opened (= runner completion, the runner's last act is the PR)
 *     → 24h unreviewed: ping the engagement lead in the notification centre
 *       (status-feed item + an @-tagged ticket comment — the same dispatch
 *       surface coordination messages and agent flags use).
 *     → 48h unreviewed: post a summary comment on the PR through the existing
 *       provider integration and set the `flagged` stage, which the board
 *       renders as a chip on the ticket card.
 *     → lead dismisses: both timers reset (the clock restarts from now, the
 *       flag and ping state clear) so the cycle can run again while the PR
 *       stays open.
 *     → PR reviewed, merged or closed (or the ticket leaves the board): the
 *       row is cleared and never escalates again.
 *
 * State lives in one row per (connection, PR) in `app.pr_review_escalations`.
 * Each stage transition is claimed with a conditional UPDATE on the stage the
 * transition expects, so repeated checks — a re-poll, two app replicas, a
 * manual sync — can never send the same ping or raise the same flag twice.
 *
 * Provider review status is only fetched once a threshold has actually been
 * crossed: a PR younger than 24h costs zero API calls.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const PR_ESCALATION_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.pr_review_escalations (
    id SERIAL PRIMARY KEY,
    connection_id INT NOT NULL REFERENCES app.repo_connections(id) ON DELETE CASCADE,
    pr_number INT NOT NULL,
    ticket_key TEXT NOT NULL,
    engagement_id TEXT NOT NULL,
    -- Start of the review clock: the PR's opened_at, reset to NOW() whenever a
    -- lead dismisses the escalation.
    timer_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stage TEXT NOT NULL DEFAULT 'waiting',
    pinged_at TIMESTAMPTZ,
    flagged_at TIMESTAMPTZ,
    cleared_at TIMESTAMPTZ,
    cleared_reason TEXT,
    dismissed_at TIMESTAMPTZ,
    dismissed_by TEXT,
    dismiss_count INT NOT NULL DEFAULT 0,
    lead_email TEXT,
    UNIQUE (connection_id, pr_number)
  )`,
  `CREATE INDEX IF NOT EXISTS pr_review_escalations_ticket ON app.pr_review_escalations (ticket_key)`,
  `CREATE INDEX IF NOT EXISTS pr_review_escalations_stage ON app.pr_review_escalations (stage)`,
];

/** waiting → pinged (24h) → flagged (48h); cleared = timers stopped for good. */
export type EscalationStage = 'waiting' | 'pinged' | 'flagged' | 'cleared';

/** What a check should do to one escalation row right now. */
export type EscalationAction = 'none' | 'ping' | 'flag' | 'clear';

export const PING_AFTER_MS = 24 * 60 * 60_000;
export const FLAG_AFTER_MS = 48 * 60 * 60_000;

export interface EscalationInput {
  stage: EscalationStage;
  /** Start of the current review clock, in epoch ms. */
  timerStartedMs: number;
  nowMs: number;
  prState: 'open' | 'merged' | 'closed';
  /** True once a human has reviewed the PR (approval, changes requested, or a review comment). */
  reviewed: boolean;
  /** False when the ticket has left the board (done/dismissed) — nothing left to chase. */
  ticketOpen: boolean;
}

/**
 * The single decision point for a review-SLA timer. Stage-driven rather than
 * elapsed-time-driven, so a threshold that is checked ten times in a row still
 * fires exactly one ping and one flag, and a dismissal (which rewinds
 * `timerStartedMs` and drops the stage back to `waiting`) starts the same
 * ladder over from the top.
 */
export function nextEscalationAction(input: EscalationInput): EscalationAction {
  if (input.stage === 'cleared') return 'none';
  // Reviewed / merged / closed / off the board — stop, whatever stage we're at.
  if (input.reviewed || input.prState !== 'open' || !input.ticketOpen) return 'clear';
  const elapsed = input.nowMs - input.timerStartedMs;
  if (input.stage === 'waiting') return elapsed >= PING_AFTER_MS ? 'ping' : 'none';
  if (input.stage === 'pinged') return elapsed >= FLAG_AFTER_MS ? 'flag' : 'none';
  return 'none'; // already flagged: the flag stands until review or dismissal
}

/** Whole hours a clock has been running, for human-readable copy. */
export function hoursSince(startMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startMs) / 3_600_000));
}

// ---------- row helpers ----------

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
const asStage = (v: unknown): EscalationStage =>
  v === 'pinged' || v === 'flagged' || v === 'cleared' ? v : 'waiting';

/** Postgres timestamps arrive as Date or string depending on the driver path. */
export function toMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && v) {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const toIso = (v: unknown): string | null => {
  const ms = toMs(v);
  return ms === null ? null : new Date(ms).toISOString();
};

/** Client-facing shape of an escalation row (drawer banner + dismiss action). */
export function publicEscalation(row: Record<string, unknown>, nowMs: number) {
  const stage = asStage(row.stage);
  const startedMs = toMs(row.timer_started_at) ?? nowMs;
  const elapsedH = hoursSince(startedMs, nowMs);
  const nextThresholdH = stage === 'waiting' ? 24 : stage === 'pinged' ? 48 : null;
  return {
    prNumber: Number(row.pr_number),
    prUrl: asText(row.pr_url),
    ticketKey: asText(row.ticket_key),
    stage,
    hoursUnreviewed: elapsedH,
    hoursUntilNextStage: nextThresholdH === null ? null : Math.max(0, nextThresholdH - elapsedH),
    timerStartedAt: toIso(row.timer_started_at),
    pingedAt: toIso(row.pinged_at),
    flaggedAt: toIso(row.flagged_at),
    dismissedAt: toIso(row.dismissed_at),
    dismissedBy: row.dismissed_by == null ? null : asText(row.dismissed_by),
    dismissCount: Number(row.dismiss_count ?? 0),
    leadEmail: row.lead_email == null ? null : asText(row.lead_email),
  };
}

// ---------- provider review status ----------

/**
 * Has a human reviewed this PR? GitHub: any submitted review (approval,
 * changes requested, or a review comment) — a pending or dismissed review does
 * not count. Azure DevOps: any reviewer with a non-zero vote.
 */
export async function prIsReviewed(conn: Connection, prNumber: number): Promise<boolean> {
  const live = { ...conn, token: await connectionToken(conn) };
  if (conn.provider === 'github') {
    const reviews = (await jsonFetch(
      `https://api.github.com/repos/${githubPath(live)}/pulls/${prNumber}/reviews?per_page=100`,
      githubHeaders(live.token),
    )) as { state?: string }[];
    return reviews.some((r) => ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes((r.state ?? '').toUpperCase()));
  }
  const data = (await jsonFetch(`${adoApi(live.repo_url)}/pullrequests/${prNumber}/reviewers?api-version=7.1`, adoHeaders(live.token))) as {
    value?: { vote?: number }[];
  };
  return (data.value ?? []).some((r) => (r.vote ?? 0) !== 0);
}

// ---------- notification centre dispatch ----------

/**
 * Who gets pinged: the engagement's leads (`app.engagement_leads` — the same
 * list `requireLead` gates lead-only actions on), falling back to the ticket's
 * assignee when the engagement has no lead recorded.
 */
export async function resolveLeads(q: Query, engagementId: string, ticketKey: string): Promise<string[]> {
  const leads = (await q('SELECT email FROM app.engagement_leads WHERE engagement_id = $1 ORDER BY email', [engagementId])).rows
    .map((r) => asText(r.email).trim())
    .filter(Boolean);
  if (leads.length > 0) return leads;
  const assignee = asText((await q('SELECT assignee FROM app.tickets WHERE key = $1', [ticketKey])).rows[0]?.assignee).trim();
  return assignee && assignee !== '—' ? [assignee] : [];
}

const ESCALATION_AUTHOR = 'Delivery Console';

/** Ticket comment + status-feed item — the console's notification centre. */
async function notify(
  q: Query,
  args: { ticketKey: string; engagementId: string; comment: string; feedText: string; source: string | null },
): Promise<void> {
  await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
    args.ticketKey,
    ESCALATION_AUTHOR,
    args.comment,
  ]);
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
    [args.engagementId, args.feedText, args.source],
  );
}

/** The 48h summary comment posted on the PR itself. */
export function escalationSummaryComment(args: {
  ticketKey: string;
  ticketTitle: string;
  prNumber: number;
  hoursUnreviewed: number;
  leads: string[];
  pingedAtIso: string | null;
}): string {
  return [
    '## ⏰ Review SLA breached — 48h unreviewed',
    '',
    `This PR implements **${args.ticketKey} — ${args.ticketTitle}** and has been open without a review for **${args.hoursUnreviewed}h**.`,
    '',
    `- 24h: ${args.pingedAtIso ? `the engagement lead was pinged in Cometloop (${args.pingedAtIso})` : 'the engagement lead was pinged in Cometloop'}`,
    `- 48h: this comment, and **${args.ticketKey} is flagged on the board**`,
    args.leads.length > 0 ? `- Waiting on: ${args.leads.join(', ')}` : '- Waiting on: the engagement lead (none recorded for this engagement)',
    '',
    'Review or merge the PR to stop the escalation. A lead can also dismiss it from the ticket in Cometloop — that resets both timers and clears the flag, and the cycle restarts if the PR is still unreviewed 24h later.',
    '',
    '<sub>Posted automatically by the Cometloop review-SLA watch.</sub>',
  ].join('\n');
}

// ---------- the escalation check ----------

export interface EscalationDeps {
  /** Provider lookup for "has anyone reviewed this PR". */
  reviewed(conn: Connection, prNumber: number): Promise<boolean>;
  /** Provider call that posts the 48h summary comment on the PR. */
  comment(conn: Connection, prNumber: number, body: string): Promise<void>;
  now(): number;
}

const LIVE_DEPS: EscalationDeps = { reviewed: prIsReviewed, comment: postPrComment, now: () => Date.now() };

export interface EscalationRun {
  tracked: number;
  pinged: number;
  flagged: number;
  cleared: number;
}

/**
 * One pass over a connection's open, ticket-linked PRs: start clocks for PRs
 * that don't have one, stop clocks that no longer apply, and fire the 24h/48h
 * stages that are due. Safe to call as often as you like — the stage claim is
 * what prevents duplicates, not the caller's cadence.
 */
export async function checkReviewEscalations(q: Query, conn: Connection, overrides: Partial<EscalationDeps> = {}): Promise<EscalationRun> {
  const deps: EscalationDeps = { ...LIVE_DEPS, ...overrides };
  const run: EscalationRun = { tracked: 0, pinged: 0, flagged: 0, cleared: 0 };

  // 1. Start a clock for every open PR linked to a live ticket. The PR's own
  //    opened_at is the start (a runner opens its PR as the last step of the
  //    ticket, so that is "runner completion"); NOW() covers PRs synced before
  //    the column existed.
  const open = (
    await q(
      `SELECT pr.number, pr.ticket_key, pr.opened_at, t.engagement_id
       FROM app.repo_prs pr
       JOIN app.tickets t ON t.key = pr.ticket_key
       WHERE pr.connection_id = $1 AND pr.state = 'open' AND pr.ticket_key IS NOT NULL
         AND t.status NOT IN ('done','dismissed')`,
      [conn.id],
    )
  ).rows;
  for (const row of open) {
    await q(
      `INSERT INTO app.pr_review_escalations (connection_id, pr_number, ticket_key, engagement_id, timer_started_at)
       VALUES ($1,$2,$3,$4,COALESCE($5, NOW()))
       ON CONFLICT (connection_id, pr_number) DO NOTHING`,
      [conn.id, Number(row.number), asText(row.ticket_key), asText(row.engagement_id), toIso(row.opened_at)],
    );
  }

  // 2. Advance every live clock on this connection.
  const rows = (
    await q(
      `SELECT e.*, pr.state AS pr_state, pr.url AS pr_url, t.title AS ticket_title, t.status AS ticket_status
       FROM app.pr_review_escalations e
       JOIN app.repo_prs pr ON pr.connection_id = e.connection_id AND pr.number = e.pr_number
       LEFT JOIN app.tickets t ON t.key = e.ticket_key
       WHERE e.connection_id = $1 AND e.stage <> 'cleared'
       ORDER BY e.id`,
      [conn.id],
    )
  ).rows;
  run.tracked = rows.length;

  for (const row of rows) {
    const id = Number(row.id);
    const stage = asStage(row.stage);
    const prNumber = Number(row.pr_number);
    const ticketKey = asText(row.ticket_key);
    const engagementId = asText(row.engagement_id);
    const prState = row.pr_state === 'open' ? 'open' : row.pr_state === 'merged' ? 'merged' : 'closed';
    const ticketStatus = asText(row.ticket_status);
    const ticketOpen = ticketStatus !== '' && !['done', 'dismissed'].includes(ticketStatus);
    const nowMs = deps.now();
    const timerStartedMs = toMs(row.timer_started_at) ?? nowMs;
    const elapsed = nowMs - timerStartedMs;

    // Cheap exits first: nothing that needs a provider call.
    if (prState !== 'open' || !ticketOpen) {
      await clearEscalation(q, id, prState === 'merged' ? 'merged' : !ticketOpen ? 'ticket closed' : 'closed');
      run.cleared++;
      continue;
    }
    if (elapsed < PING_AFTER_MS) continue;

    // A threshold is due — now it is worth asking the provider about reviews.
    let reviewed: boolean;
    try {
      reviewed = await deps.reviewed(conn, prNumber);
    } catch (err) {
      console.warn(`[pr-escalation] review lookup failed for PR #${prNumber} (${conn.repo_name}):`, (err as Error).message);
      continue; // never escalate on an unknown review state
    }

    const action = nextEscalationAction({ stage, timerStartedMs, nowMs, prState, reviewed, ticketOpen });
    if (action === 'clear') {
      await clearEscalation(q, id, 'reviewed');
      run.cleared++;
      continue;
    }
    if (action === 'none') continue;

    const hours = hoursSince(timerStartedMs, nowMs);
    const prUrl = asText(row.pr_url);
    const ticketTitle = asText(row.ticket_title);
    const leads = await resolveLeads(q, engagementId, ticketKey);

    if (action === 'ping') {
      // Claim the transition before dispatching: a second checker racing this
      // one finds the stage already moved and sends nothing (AC: no duplicates).
      const claimed = (
        await q(
          `UPDATE app.pr_review_escalations SET stage = 'pinged', pinged_at = NOW(), lead_email = $2
           WHERE id = $1 AND stage = 'waiting' RETURNING id`,
          [id, leads[0] ?? null],
        )
      ).rows;
      if (claimed.length === 0) continue;
      const mention = leads.length > 0 ? leads.map((l) => `@${l}`).join(' ') : 'Engagement lead';
      await notify(q, {
        ticketKey,
        engagementId,
        comment: [
          `${mention} — ⏰ PR #${prNumber} for ${ticketKey} has been open **${hours}h without a review**.`,
          '',
          prUrl ? `${prUrl}` : '',
          '',
          'If it is still unreviewed at 48h the console will post a summary comment on the PR and flag this ticket on the board. Dismiss the escalation from this ticket to reset both timers.',
        ]
          .filter((l) => l !== '')
          .join('\n'),
        feedText: `⏰ PR #${prNumber} for ${ticketKey} unreviewed for ${hours}h — pinged ${leads.length > 0 ? leads.join(', ') : 'the engagement lead'}.`,
        source: conn.repo_name,
      });
      console.log(`[pr-escalation] 24h ping sent for ${ticketKey} (PR #${prNumber}, ${hours}h unreviewed)`);
      run.pinged++;
      continue;
    }

    // action === 'flag': 48h. Claim first, then post the PR comment and flag.
    const claimed = (
      await q(`UPDATE app.pr_review_escalations SET stage = 'flagged', flagged_at = NOW() WHERE id = $1 AND stage = 'pinged' RETURNING id`, [
        id,
      ])
    ).rows;
    if (claimed.length === 0) continue;
    const body = escalationSummaryComment({
      ticketKey,
      ticketTitle,
      prNumber,
      hoursUnreviewed: hours,
      leads,
      pingedAtIso: toIso(row.pinged_at),
    });
    try {
      await deps.comment(conn, prNumber, body);
    } catch (err) {
      // The board flag and the feed item still land — a provider outage must
      // not swallow the escalation itself.
      console.warn(`[pr-escalation] PR comment failed for #${prNumber} (${conn.repo_name}):`, (err as Error).message);
    }
    await notify(q, {
      ticketKey,
      engagementId,
      comment: [
        `⚠ **Review SLA breached** — PR #${prNumber} has been unreviewed for ${hours}h.`,
        '',
        `A summary comment was posted on the PR and ${ticketKey} is flagged on the board.`,
        prUrl ? `\n${prUrl}` : '',
        '',
        'Dismissing the escalation from this ticket clears the flag and resets both timers.',
      ]
        .filter((l) => l !== '')
        .join('\n'),
      feedText: `⚠ PR #${prNumber} for ${ticketKey} still unreviewed after ${hours}h — summary posted on the PR, ticket flagged.`,
      source: conn.repo_name,
    });
    console.log(`[pr-escalation] 48h escalation raised for ${ticketKey} (PR #${prNumber}, ${hours}h unreviewed)`);
    run.flagged++;
  }

  return run;
}

async function clearEscalation(q: Query, id: number, reason: string): Promise<void> {
  await q(`UPDATE app.pr_review_escalations SET stage = 'cleared', cleared_at = NOW(), cleared_reason = $2 WHERE id = $1`, [id, reason]);
}

/**
 * Reset both timers for a ticket's escalation: the clock restarts from now and
 * the ping/flag state clears, so the ladder runs again from the top if the PR
 * is still unreviewed 24h later.
 */
export async function dismissEscalation(q: Query, ticketKey: string, by: string): Promise<Record<string, unknown> | null> {
  const row = (
    await q(
      `UPDATE app.pr_review_escalations
       SET stage = 'waiting', timer_started_at = NOW(), pinged_at = NULL, flagged_at = NULL,
           dismissed_at = NOW(), dismissed_by = $2, dismiss_count = dismiss_count + 1
       WHERE id = (SELECT id FROM app.pr_review_escalations WHERE ticket_key = $1 AND stage <> 'cleared' ORDER BY id DESC LIMIT 1)
       RETURNING *`,
      [ticketKey, by],
    )
  ).rows[0];
  return row ?? null;
}

// ---------- routes ----------

export function setupPrEscalationRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
): void {
  /** Current escalation for a ticket (null once cleared) — drawer banner. */
  app.get('/api/tickets/:key/escalation', async (req, res) => {
    try {
      const row = (
        await q(
          `SELECT e.*, pr.url AS pr_url FROM app.pr_review_escalations e
           LEFT JOIN app.repo_prs pr ON pr.connection_id = e.connection_id AND pr.number = e.pr_number
           WHERE e.ticket_key = $1 AND e.stage <> 'cleared' ORDER BY e.id DESC LIMIT 1`,
          [req.params.key],
        )
      ).rows[0];
      res.json({ escalation: row ? publicEscalation(row, Date.now()) : null });
    } catch (err) {
      console.error('escalation lookup failed:', err);
      res.status(500).json({ error: 'Failed to load review escalation' });
    }
  });

  /** Lead-only: dismiss the escalation and reset the 24h and 48h timers.
   *  Takes no body — the ticket key in the path is the whole request. */
  app.post('/api/tickets/:key/escalation/dismiss', async (req, res) => {
    try {
      const key = req.params.key;
      const ticket = (await q('SELECT engagement_id FROM app.tickets WHERE key = $1', [key])).rows[0];
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const engagementId = asText(ticket.engagement_id);
      const lead = await requireLead(req, res, engagementId);
      if (!lead) return;
      const row = await dismissEscalation(q, key, lead.email);
      if (!row) {
        res.status(404).json({ error: 'No active review escalation on this ticket' });
        return;
      }
      await notify(q, {
        ticketKey: key,
        engagementId,
        comment: `Review escalation dismissed by ${lead.email} — the 24h and 48h timers are reset and the board flag is cleared.`,
        feedText: `Review escalation for ${key} (PR #${Number(row.pr_number)}) dismissed by ${lead.email} — timers reset.`,
        source: null,
      });
      console.log(`[pr-escalation] ${key} escalation dismissed by ${lead.email} — timers reset`);
      res.json({ escalation: publicEscalation(row, Date.now()) });
    } catch (err) {
      console.error('escalation dismiss failed:', err);
      res.status(500).json({ error: 'Failed to dismiss the review escalation' });
    }
  });
}

/**
 * Background watch over every connected repository. The thresholds are hours
 * apart, so a slow cadence is plenty — and PRs younger than 24h cost no
 * provider calls at all.
 */
export function startEscalationPolling(q: Query, intervalMs = 5 * 60_000): void {
  const tick = async () => {
    try {
      const engagements = (await q('SELECT engagement_id FROM app.repo_connections')).rows.map((r) => asText(r.engagement_id));
      for (const engagementId of engagements) {
        const conn = await loadConnection(q, engagementId);
        if (!conn) continue;
        try {
          const run = await checkReviewEscalations(q, conn);
          if (run.pinged > 0 || run.flagged > 0 || run.cleared > 0) {
            console.log(
              `[pr-escalation] ${conn.repo_name}: ${run.tracked} tracked, ${run.pinged} pinged, ${run.flagged} flagged, ${run.cleared} cleared`,
            );
          }
        } catch (err) {
          console.warn(`[pr-escalation] check failed for ${conn.repo_name}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.warn('[pr-escalation] poll failed:', (err as Error).message);
    }
  };
  setInterval(() => void tick(), intervalMs).unref?.();
}
