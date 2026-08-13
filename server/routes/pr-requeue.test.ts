import { describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { TOP_PRIORITY } from './agent-work';
import {
  classifyReviewOutcome,
  conflictResolutionInstructions,
  countConflictRequeues,
  handleReviewedPr,
  MAX_CONFLICT_REQUEUES,
  mentionsMergeConflict,
  PR_REQUEUE_SCHEMA_SQL,
  verdictText,
  type RequeueContext,
} from './pr-requeue';
import { parseVerdict } from './pr-review';

/**
 * The merge-conflict requeue (DAT-200). Two halves are worth holding still:
 * the classification (a false positive requeues work that was fine; a false
 * negative leaves a conflicted PR sitting) and the queue effect (top priority
 * really does mean "claimed next", and the retry loop really does terminate).
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface MemPg {
  Pool: new () => { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
}

/** agent_tasks without the FKs (the columns the queue actually sorts and claims on). */
const TASKS_SQL = `CREATE TABLE app.agent_tasks (
  id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, engagement_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', priority INT NOT NULL DEFAULT 0,
  instructions TEXT NOT NULL DEFAULT '', queued_by TEXT NOT NULL DEFAULT '',
  agent TEXT, flag TEXT, last_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
const COMMENTS_SQL = `CREATE TABLE app.ticket_comments (
  id SERIAL PRIMARY KEY, ticket_key TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
const FEED_SQL = `CREATE TABLE app.feed_items (
  id SERIAL PRIMARY KEY, engagement_id TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL,
  time_label TEXT NOT NULL DEFAULT '', reversible BOOLEAN NOT NULL DEFAULT false)`;

async function memDb(): Promise<Query> {
  const db = newDb();
  const { Pool } = db.adapters.createPg() as MemPg;
  const pool = new Pool();
  const q: Query = (text: string, params?: unknown[]) => pool.query(text, params);
  await q('CREATE SCHEMA IF NOT EXISTS app');
  await q(TASKS_SQL);
  await q(COMMENTS_SQL);
  await q(FEED_SQL);
  for (const sql of PR_REQUEUE_SCHEMA_SQL) await q(sql);
  return q;
}

const CTX: RequeueContext = {
  engagementId: 'execution-console',
  ticketKey: 'DAT-200',
  prNumber: 12,
  prUrl: 'https://github.com/acme/repo/pull/12',
  branch: 'DAT-200-requeue',
  baseBranch: 'main',
  reviewId: 5,
};

/** The queue consumer's ordering, verbatim from agent-work's claim and poll. */
const nextUp = async (q: Query) =>
  (await q(`SELECT id, ticket_key, priority FROM app.agent_tasks WHERE state = 'queued' ORDER BY priority DESC, id`)).rows;

// ---------- classification ----------

describe('mentionsMergeConflict', () => {
  it('recognizes how a reviewer actually reports a conflict', () => {
    for (const text of [
      'This branch has merge conflicts with main.',
      'The PR conflicts with the base branch and cannot be merged.',
      'It cannot be automatically merged — resolve and re-push.',
      'server/routes/api.ts does not merge cleanly.',
      'The head is unmergeable as it stands.',
      'The diff still contains <<<<<<< HEAD markers.',
    ]) {
      expect(mentionsMergeConflict(text), text).toBe(true);
    }
  });

  it('does not fire on a review that says there is no conflict', () => {
    for (const text of [
      'There are no merge conflicts; the branch is up to date with main.',
      'This is not a merge conflict, just a failing test.',
      'The change merges without conflicts with the base branch.',
      'Rebased and merge conflict-free.',
    ]) {
      expect(mentionsMergeConflict(text), text).toBe(false);
    }
  });

  it('does not fire on the other reasons a review fails', () => {
    for (const text of [
      'Two unit tests fail on this head and lint reports an unused import.',
      'Acceptance criterion 3 is unmet: the runner never reads the flag.',
      'The migration conflicts with our ownership rule for dev-role tables.',
    ]) {
      expect(mentionsMergeConflict(text), text).toBe(false);
    }
  });
});

describe('classifyReviewOutcome', () => {
  it('takes the provider as authoritative, whatever the verdict said', () => {
    const c = classifyReviewOutcome({ verdict: 'approve', mergeState: 'conflicts' });
    expect(c.isMergeConflict).toBe(true);
    expect(c.source).toBe('provider');
  });

  it('never requeues a PR the provider says merges cleanly', () => {
    const c = classifyReviewOutcome({ verdict: 'request-changes', mergeState: 'clean', text: 'This branch has merge conflicts.' });
    expect(c.isMergeConflict).toBe(false);
  });

  it('falls back to the reviewer’s words when mergeability is not reported yet', () => {
    const c = classifyReviewOutcome({ verdict: 'request-changes', mergeState: 'unknown', text: 'Conflicts with the main branch.' });
    expect(c.isMergeConflict).toBe(true);
    expect(c.source).toBe('review-text');
  });

  it('leaves every other kind of failure alone', () => {
    expect(
      classifyReviewOutcome({ verdict: 'request-changes', mergeState: 'unknown', text: 'CI is red: three tests fail.' }).isMergeConflict,
    ).toBe(false);
    expect(classifyReviewOutcome({ verdict: 'escalate', mergeState: 'unknown', text: 'Touches auth — needs a human.' }).isMergeConflict).toBe(
      false,
    );
    // A failed review (no usable verdict) is an outage, not a conflict.
    expect(classifyReviewOutcome({ verdict: null, mergeState: 'unknown' }).isMergeConflict).toBe(false);
  });

  it('does not requeue on conflict prose alone when the review cleared the PR', () => {
    const c = classifyReviewOutcome({ verdict: 'approve-with-nits', mergeState: 'unknown', text: 'Watch out for merge conflicts later.' });
    expect(c.isMergeConflict).toBe(false);
  });
});

describe('verdictText', () => {
  it('flattens the findings so a conflict named only in a blocking note is seen', () => {
    const v = parseVerdict(
      JSON.stringify({
        verdict: 'request-changes',
        summary: 'Not mergeable yet.',
        blocking: [{ file: 'server/routes/api.ts', detail: 'The branch has merge conflicts with main.' }],
      }),
    );
    expect(mentionsMergeConflict(verdictText(v))).toBe(true);
    expect(verdictText(null)).toBe('');
  });
});

describe('conflictResolutionInstructions', () => {
  it('tells the runner which PR, which base and what not to do', () => {
    const text = conflictResolutionInstructions(CTX, 'the provider reports the PR does not merge', 1);
    expect(text).toContain('PR #12');
    expect(text).toContain('origin/main');
    expect(text).toContain('DAT-200-requeue');
    expect(text).toContain('do NOT open a second PR');
    expect(text).toContain(`attempt 1 of ${String(MAX_CONFLICT_REQUEUES)}`);
    expect(text).not.toContain('last automatic attempt');
  });

  it('warns on the final attempt that the next conflict goes to a developer', () => {
    expect(conflictResolutionInstructions(CTX, 'still conflicts', MAX_CONFLICT_REQUEUES)).toContain('last automatic attempt');
  });
});

// ---------- the queue effect ----------

describe('handleReviewedPr', () => {
  it('queues the ticket at top priority and logs the event', async () => {
    const q = await memDb();
    const result = await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });

    expect(result.outcome).toBe('requeued');
    expect(result.priority).toBe(TOP_PRIORITY);

    const task = (await q('SELECT * FROM app.agent_tasks')).rows[0];
    expect(task.ticket_key).toBe('DAT-200');
    expect(task.state).toBe('queued');
    expect(Number(task.priority)).toBe(TOP_PRIORITY);
    expect(String(task.instructions)).toContain('PR #12');

    // PR id, reason and timestamp, for traceability.
    const event = (await q('SELECT * FROM app.pr_requeues')).rows[0];
    expect(Number(event.pr_number)).toBe(12);
    expect(event.outcome).toBe('requeued');
    expect(event.source).toBe('provider');
    expect(String(event.reason)).toContain('does not merge');
    expect(Number(event.attempt)).toBe(1);
    expect(event.created_at).toBeTruthy();

    expect(String((await q('SELECT * FROM app.ticket_comments')).rows[0].body)).toContain('requeued at top priority');
    expect(String((await q('SELECT * FROM app.feed_items')).rows[0].text)).toContain('merge conflict');
  });

  it('is the next item the runner claims, ahead of everything already queued', async () => {
    const q = await memDb();
    await q(
      `INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority) VALUES
       ('DAT-300','execution-console',0), ('DAT-301','execution-console',9)`,
    );
    await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });

    const queue = await nextUp(q);
    expect(queue.map((r) => r.ticket_key)).toEqual(['DAT-200', 'DAT-301', 'DAT-300']);
  });

  it('keeps FIFO between two conflicts at the same rank', async () => {
    const q = await memDb();
    await handleReviewedPr(q, { ...CTX, ticketKey: 'DAT-210', prNumber: 21 }, { verdict: 'request-changes', mergeState: 'conflicts' });
    await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });

    const queue = await nextUp(q);
    expect(queue.map((r) => r.ticket_key)).toEqual(['DAT-210', 'DAT-200']);
  });

  it('does nothing at all for a failure that is not a merge conflict', async () => {
    const q = await memDb();
    const result = await handleReviewedPr(q, CTX, {
      verdict: 'request-changes',
      mergeState: 'clean',
      text: 'Two tests fail and criterion 2 is unmet.',
    });

    expect(result.outcome).toBe('skipped');
    expect((await q('SELECT * FROM app.agent_tasks')).rows).toHaveLength(0);
    expect((await q('SELECT * FROM app.pr_requeues')).rows).toHaveLength(0);
    expect((await q('SELECT * FROM app.ticket_comments')).rows).toHaveLength(0);
  });

  it('raises the ticket’s own queued task instead of queuing a second run', async () => {
    const q = await memDb();
    await q(`INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority, instructions) VALUES ('DAT-200','execution-console',2,'old')`);
    const result = await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });

    expect(result.outcome).toBe('bumped');
    const tasks = (await q('SELECT * FROM app.agent_tasks')).rows;
    expect(tasks).toHaveLength(1);
    expect(Number(tasks[0].priority)).toBe(TOP_PRIORITY);
    expect(String(tasks[0].instructions)).toContain('merge-conflict requeue');
  });

  it('leaves a run that a runner already has, and says why', async () => {
    const q = await memDb();
    await q(
      `INSERT INTO app.agent_tasks (ticket_key, engagement_id, priority, state, agent)
       VALUES ('DAT-200','execution-console',0,'working','local-runner-2')`,
    );
    const result = await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('already working');
    expect(Number((await q('SELECT * FROM app.agent_tasks')).rows[0].priority)).toBe(0);
    // Still recorded — a skipped requeue is part of the PR's history.
    expect((await q('SELECT * FROM app.pr_requeues')).rows).toHaveLength(1);
    // …but it does not burn a retry.
    expect(await countConflictRequeues(q, CTX.engagementId, CTX.prNumber)).toBe(0);
  });

  it('stops requeuing and flags a developer once the retries are spent', async () => {
    const q = await memDb();
    for (let i = 0; i < MAX_CONFLICT_REQUEUES; i++) {
      const r = await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });
      expect(r.outcome).toBe(i === 0 ? 'requeued' : 'bumped');
      expect(r.attempt).toBe(i + 1);
    }
    expect(await countConflictRequeues(q, CTX.engagementId, CTX.prNumber)).toBe(MAX_CONFLICT_REQUEUES);

    const final = await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });
    expect(final.outcome).toBe('escalated');
    expect(final.reason).toContain('a developer');

    const task = (await q('SELECT * FROM app.agent_tasks')).rows[0];
    expect(String(task.flag)).toContain('does not merge');
    // The escalation does not re-rank anything — the human decides now.
    expect(Number(task.priority)).toBe(TOP_PRIORITY);
    expect(String((await q('SELECT * FROM app.ticket_comments ORDER BY id DESC')).rows[0].body)).toContain('no longer auto-requeued');
  });

  it('counts retries per PR, not per ticket', async () => {
    const q = await memDb();
    await handleReviewedPr(q, CTX, { verdict: 'request-changes', mergeState: 'conflicts' });
    expect(await countConflictRequeues(q, CTX.engagementId, 99)).toBe(0);
  });
});
