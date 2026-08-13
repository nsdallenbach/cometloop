import { TOP_PRIORITY } from './agent-work';
import type { ReviewVerdict, Verdict } from './pr-review';

/**
 * Merge-conflict requeue (DAT-200).
 *
 * When the review gate leaves a PR unmergeable, the ticket goes straight back
 * to the *top* of the runner queue so the next pickup is the conflict, not
 * whatever else was waiting. Everything else a review can find — failing
 * tests, lint, unmet criteria — keeps the existing path: the verdict is
 * posted, a human decides. Only a merge conflict jumps the queue.
 *
 * Three things had to be true for that to work, and all three are asserted by
 * the tests next to this file:
 *  - the *classification* is conservative. The provider's mergeability is the
 *    authoritative signal; reviewer prose is only a fallback, and phrases like
 *    "no merge conflicts" must never trip it (a false positive requeues work
 *    that did not need requeuing, and looks like a loop).
 *  - the *rank* beats anything the board can produce. Claiming sorts
 *    `priority DESC, id`, so TOP_PRIORITY puts the conflict first while `id`
 *    keeps FIFO among several conflicts.
 *  - the loop *terminates*. After MAX_CONFLICT_REQUEUES attempts on the same
 *    PR the conflict stops being requeued and starts being escalated — the
 *    board flag is the same channel the runner's own /flag endpoint uses.
 *
 * Every decision (including the ones that decline to requeue) lands in
 * app.pr_requeues with the PR number, the reason and a timestamp, and is
 * mirrored to the console log, the engagement feed and the ticket thread.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const PR_REQUEUE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.pr_requeues (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL,
    ticket_key TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    review_id INTEGER,
    task_id INTEGER,
    attempt INTEGER NOT NULL DEFAULT 1,
    outcome TEXT NOT NULL DEFAULT 'requeued',
    source TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    priority INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS pr_requeues_pr ON app.pr_requeues (engagement_id, pr_number)`,
  `CREATE INDEX IF NOT EXISTS pr_requeues_ticket ON app.pr_requeues (ticket_key)`,
];

/** How many times the same PR may jump the queue before a human is asked instead. */
export const MAX_CONFLICT_REQUEUES = 3;

/** Stamped on the queued task so the board shows who put it there. */
export const REQUEUE_ACTOR = 'pr-review (merge conflict)';

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

// ---------- classification (pure, unit-tested) ----------

/** What the provider says about merging this PR into its base branch. */
export type MergeState = 'clean' | 'conflicts' | 'unknown';

/**
 * Phrases that mean "this branch does not merge". Deliberately narrow: a
 * reviewer complaining about a failing test or a lint rule must not match.
 */
const CONFLICT_PATTERNS = [
  /merge conflicts?/,
  /conflicts? with (?:the )?(?:base|target|main|master|default)\b/,
  /conflicting changes/,
  /cannot be (?:automatically |auto[- ])?merged/,
  /can(?:'|no)?t be merged/,
  /does not merge cleanly/,
  /unmergeable/,
  /<{7} /, // conflict markers pasted into a finding
];

/**
 * A negation in the same sentence, immediately before the phrase — "there are
 * no merge conflicts", "not a merge conflict", "merges without conflicts with
 * main". These are the sentences a *clean* PR's review contains, and matching
 * them would requeue perfectly good work.
 */
const NEGATION = /\b(?:no|not|never|without|free of|zero)\b[^.;!?]{0,30}$/;

/** True when the text asserts a merge conflict (rather than denying one). */
export function mentionsMergeConflict(text: string): boolean {
  const t = ` ${text.toLowerCase().replace(/\s+/g, ' ')}`;
  for (const pattern of CONFLICT_PATTERNS) {
    const scan = new RegExp(pattern.source, 'g');
    for (let m = scan.exec(t); m !== null; m = scan.exec(t)) {
      const before = t.slice(Math.max(0, m.index - 60), m.index);
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (NEGATION.test(before)) continue;
      if (/^s?[- ]free/.test(after)) continue; // "merge conflict-free"
      return true;
    }
  }
  return false;
}

/** Everything a reviewer wrote, flattened into one blob for phrase matching. */
export function verdictText(v: ReviewVerdict | null): string {
  if (!v) return '';
  return [
    v.summary,
    v.validation,
    v.risk,
    ...v.blocking.map((f) => f.detail),
    ...v.nonBlocking.map((f) => f.detail),
    ...v.acceptanceCriteria.map((a) => `${a.criterion} ${a.status}`),
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ConflictClassification {
  isMergeConflict: boolean;
  /** Which signal decided it — the provider is authoritative, prose is a fallback. */
  source: 'provider' | 'review-text' | 'none';
  /** One line, logged and stored verbatim. */
  reason: string;
}

/** Verdicts that leave the PR needing more work from the author. */
const NON_CLEARING: readonly Verdict[] = ['request-changes', 'escalate'];

/**
 * Decide whether a published review means "merge conflict". The provider wins
 * when it has an answer: an approved PR that still cannot merge is exactly the
 * case the ticket describes ("jump back into the queue … to resolve merge
 * conflicts"), and a PR the provider says merges cleanly is never requeued no
 * matter how the reviewer phrased its findings.
 */
export function classifyReviewOutcome(input: { verdict: Verdict | null; mergeState: MergeState; text?: string }): ConflictClassification {
  const { verdict, mergeState } = input;
  if (mergeState === 'conflicts') {
    return {
      isMergeConflict: true,
      source: 'provider',
      reason: 'the provider reports the PR does not merge into its base branch',
    };
  }
  if (mergeState === 'clean') {
    return { isMergeConflict: false, source: 'none', reason: 'the PR merges cleanly into its base branch' };
  }
  if (verdict && NON_CLEARING.includes(verdict) && mentionsMergeConflict(input.text ?? '')) {
    return { isMergeConflict: true, source: 'review-text', reason: `the "${verdict}" review cites a merge conflict` };
  }
  return {
    isMergeConflict: false,
    source: 'none',
    reason: verdict ? `the "${verdict}" review is not a merge-conflict failure` : 'no usable verdict and no conflict reported',
  };
}

// ---------- the instructions the requeued runner picks up ----------

export interface RequeueContext {
  engagementId: string;
  ticketKey: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  baseBranch: string;
  reviewId?: number | null;
}

/**
 * Rendered into the work package's instructions, which the runner prompt
 * carries verbatim. Self-labelled, because the prompt files it under the
 * lead-instructions heading and this was nobody's manual request.
 */
export function conflictResolutionInstructions(ctx: RequeueContext, reason: string, attempt: number): string {
  const base = ctx.baseBranch || 'the base branch';
  return [
    `**Automated merge-conflict requeue — attempt ${String(attempt)} of ${String(MAX_CONFLICT_REQUEUES)}.**`,
    '',
    `This ticket is back at the top of the queue because PR #${String(ctx.prNumber)} cannot merge into \`${base}\` — ${reason}. Resolving that conflict is the whole job; do it before anything else, and do not start new feature work.`,
    '',
    `1. In \`./repo\`, check out the existing branch \`${ctx.branch || `${ctx.ticketKey}-…`}\` — do NOT open a second PR for this ticket.`,
    `2. \`git fetch origin\`, then \`git merge-tree $(git merge-base HEAD origin/${base}) HEAD origin/${base}\` to list the conflicted files.`,
    `3. Report them with check_pr_conflicts (POST /api/agent/work/<task id>/pr/${String(ctx.prNumber)}/conflicts) and follow the report: auto-resolve ONLY when it recommends auto-resolve and the hunks are trivially mergeable.`,
    `4. If you resolve: merge \`origin/${base}\`, fix the conflicts, re-run \`npm run typecheck && npm run lint && npm run build\`, push, and document the resolution with a PR comment.`,
    `5. If resolution is not safe — overlapping logic, or a conflicting PR on another ticket — leave the branch untouched and escalate with escalate_pr_conflict.`,
    '',
    `PR: ${ctx.prUrl || `#${String(ctx.prNumber)}`}`,
    ...(attempt >= MAX_CONFLICT_REQUEUES
      ? ['', `This is the last automatic attempt — a further conflict on this PR will be flagged for a developer instead of requeued.`]
      : []),
  ].join('\n');
}

// ---------- the requeue itself ----------

export interface RequeueResult {
  /** requeued = new queued task; bumped = existing queued task raised; skipped/escalated = no queue change. */
  outcome: 'requeued' | 'bumped' | 'skipped' | 'escalated';
  reason: string;
  taskId?: number;
  attempt?: number;
  priority?: number;
}

/** Conflict requeues already spent on this PR — the loop-prevention counter. */
export async function countConflictRequeues(q: Query, engagementId: string, prNumber: number): Promise<number> {
  const row = (
    await q(
      `SELECT COUNT(*) AS n FROM app.pr_requeues
       WHERE engagement_id = $1 AND pr_number = $2 AND outcome IN ('requeued','bumped')`,
      [engagementId, prNumber],
    )
  ).rows[0];
  return num(row?.n);
}

async function record(
  q: Query,
  ctx: RequeueContext,
  fields: { attempt: number; outcome: RequeueResult['outcome']; source: string; reason: string; taskId?: number; priority?: number },
): Promise<void> {
  await q(
    `INSERT INTO app.pr_requeues (engagement_id, ticket_key, pr_number, review_id, task_id, attempt, outcome, source, reason, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      ctx.engagementId,
      ctx.ticketKey,
      ctx.prNumber,
      ctx.reviewId ?? null,
      fields.taskId ?? null,
      fields.attempt,
      fields.outcome,
      fields.source,
      fields.reason.slice(0, 2000),
      fields.priority ?? null,
    ],
  ).catch((err: unknown) => console.warn('[pr-requeue] could not record the requeue event:', (err as Error).message));
  // PR id, reason and timestamp, on one line, for anyone reading the app log.
  console.log(
    `[pr-requeue] ${new Date().toISOString()} ${ctx.ticketKey} PR #${String(ctx.prNumber)} → ${fields.outcome} (attempt ${String(fields.attempt)}/${String(MAX_CONFLICT_REQUEUES)}, ${fields.source}): ${fields.reason}`,
  );
}

const feed = (q: Query, engagementId: string, text: string) =>
  q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
    [engagementId, text],
  ).catch((err: unknown) => console.warn('[pr-requeue] feed write failed:', (err as Error).message));

const comment = (q: Query, ticketKey: string, body: string) =>
  q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [ticketKey, 'PR Review', body]).catch((err: unknown) =>
    console.warn('[pr-requeue] ticket comment failed:', (err as Error).message),
  );

/**
 * Put the ticket back on the queue at top priority, or explain why not.
 *
 * The queue carries one active run per ticket (a partial unique index), so
 * there are exactly three shapes: nothing active → insert; a queued task that
 * has not been picked up → raise its rank and swap in the conflict
 * instructions; a claimed/working task → a runner already has it, leave it
 * alone and say so.
 */
export async function requeueForMergeConflict(
  q: Query,
  ctx: RequeueContext,
  classification: ConflictClassification,
): Promise<RequeueResult> {
  const spent = await countConflictRequeues(q, ctx.engagementId, ctx.prNumber);
  const attempt = spent + 1;

  if (attempt > MAX_CONFLICT_REQUEUES) {
    const reason = `PR #${String(ctx.prNumber)} has hit ${String(MAX_CONFLICT_REQUEUES)} automatic merge-conflict requeues and still does not merge into ${ctx.baseBranch || 'its base branch'} — a developer needs to resolve it.`;
    await record(q, ctx, { attempt, outcome: 'escalated', source: classification.source, reason });
    await q(
      `UPDATE app.agent_tasks SET flag = $2, updated_at = NOW()
       WHERE id = (SELECT id FROM app.agent_tasks WHERE ticket_key = $1 ORDER BY id DESC LIMIT 1)`,
      [ctx.ticketKey, reason.slice(0, 2000)],
    ).catch((err: unknown) => console.warn('[pr-requeue] flag failed:', (err as Error).message));
    await comment(q, ctx.ticketKey, `⚠ **Merge conflict — no longer auto-requeued**\n\n${reason}\n\n${ctx.prUrl}`);
    await feed(q, ctx.engagementId, `⚠ ${ctx.ticketKey} PR #${String(ctx.prNumber)} still conflicts after ${String(MAX_CONFLICT_REQUEUES)} automatic retries — needs a developer.`);
    return { outcome: 'escalated', reason, attempt };
  }

  const active = (
    await q(`SELECT id, state FROM app.agent_tasks WHERE ticket_key = $1 AND state IN ('queued','claimed','working') ORDER BY id DESC LIMIT 1`, [
      ctx.ticketKey,
    ])
  ).rows[0];

  if (active && txt(active.state) !== 'queued') {
    const reason = `a runner is already working ${ctx.ticketKey} (task ${String(num(active.id))}, state '${txt(active.state)}') — the conflict rides along with that run`;
    await record(q, ctx, { attempt, outcome: 'skipped', source: classification.source, reason, taskId: num(active.id) });
    return { outcome: 'skipped', reason, taskId: num(active.id), attempt };
  }

  const instructions = conflictResolutionInstructions(ctx, classification.reason, attempt);
  const taskId = active
    ? num(
        (
          await q(
            `UPDATE app.agent_tasks SET priority = $2, instructions = $3, flag = NULL, updated_at = NOW() WHERE id = $1 RETURNING id`,
            [num(active.id), TOP_PRIORITY, instructions],
          )
        ).rows[0]?.id,
      )
    : num(
        (
          await q(
            `INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority, instructions, queued_by)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [ctx.ticketKey, ctx.engagementId, TOP_PRIORITY, instructions, REQUEUE_ACTOR],
          )
        ).rows[0]?.id,
      );

  const outcome: RequeueResult['outcome'] = active ? 'bumped' : 'requeued';
  const reason = `${classification.reason} — ${active ? 'raised the queued task' : 'queued a new run'} to top priority for conflict resolution`;
  await record(q, ctx, { attempt, outcome, source: classification.source, reason, taskId, priority: TOP_PRIORITY });
  await comment(
    q,
    ctx.ticketKey,
    [
      `**Merge conflict — requeued at top priority** (attempt ${String(attempt)} of ${String(MAX_CONFLICT_REQUEUES)})`,
      '',
      `PR #${String(ctx.prNumber)} cannot merge into \`${ctx.baseBranch || 'the base branch'}\` — ${classification.reason}. The ticket is back at the front of the runner queue so the conflict is resolved on the next pickup.`,
      '',
      ctx.prUrl,
    ].join('\n'),
  );
  await feed(
    q,
    ctx.engagementId,
    `⤴ ${ctx.ticketKey} PR #${String(ctx.prNumber)} hit a merge conflict — requeued at top priority for the runner to resolve (attempt ${String(attempt)} of ${String(MAX_CONFLICT_REQUEUES)}).`,
  );
  return { outcome, reason, taskId, attempt, priority: TOP_PRIORITY };
}

/**
 * The single entry point the review gate calls: classify, then act. A review
 * that is not a merge-conflict failure returns 'skipped' and changes nothing —
 * that is the guarantee behind "non-merge-conflict failures do not requeue".
 */
export async function handleReviewedPr(
  q: Query,
  ctx: RequeueContext,
  input: { verdict: Verdict | null; mergeState: MergeState; text?: string },
): Promise<RequeueResult> {
  const classification = classifyReviewOutcome(input);
  if (!classification.isMergeConflict) {
    return { outcome: 'skipped', reason: classification.reason };
  }
  return await requeueForMergeConflict(q, ctx, classification);
}
