import type express from 'express';
import { z } from 'zod';
import { invokeModel } from './llm-health';
import { resolveRole } from '../llm/config';
import { extractServingText } from '../llm/providers/databricks';
import { PR_REVIEW_TEMPLATE, ensurePrReviewSkill, loadPrReviewTemplate, renderTemplate } from './pr-review-skill';
import { checkAgentAction } from './agent-security';
import { prMergeInfo } from './pr-conflicts';
import { handleReviewedPr, verdictText, type MergeState } from './pr-requeue';
import { connectionToken, githubHeaders, githubPath, jsonFetch, loadConnection, onPrOpened, type Connection } from './repos';
import type { Caller } from './roles';
import type { ScopingToolDef } from './scoping-tools';

/**
 * The PR review gate (DAT-209). When a linked PR opens, the console assembles
 * the case — ticket, acceptance criteria, diff, CI status — renders the
 * reviewer prompt (the `pr-review` registry skill, seeded from
 * pr-review-skill.ts) and runs it through `invokeModel('review', …)` on the
 * provider the workspace mapped to the review role. A project that registered
 * an endpoint-backed `pr-reviewer` agent on the /agents page keeps it: when
 * the review role's provider is Databricks, that endpoint is the model.
 *
 * The reviewer never merges. Its output is a verdict plus findings, posted as
 * a PR comment and a ticket comment; `escalate` also raises the board flag.
 * Merging stays the human gate.
 *
 * Two ways a verdict arrives, because an AgentBricks agent may prefer either:
 *  - it returns the verdict JSON from the invoke, and the console posts it; or
 *  - it calls submit_pr_review over the delivery-console MCP server mid-turn,
 *    which posts immediately and marks the run submitted so the invoke-side
 *    parse does not post it twice.
 *
 * Degradation is deliberate: an unreachable endpoint, a timeout or unparseable
 * output records a failed review and a feed warning. A PR is never approved,
 * merged or moved because the reviewer could not be reached.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const PR_REVIEW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.pr_reviews (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL,
    ticket_key TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT,
    reviewer TEXT NOT NULL DEFAULT '',
    endpoint TEXT,
    trigger TEXT NOT NULL DEFAULT 'pr-opened',
    state TEXT NOT NULL DEFAULT 'running',
    verdict TEXT,
    summary TEXT,
    body TEXT,
    submitted_via TEXT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS pr_reviews_pr ON app.pr_reviews (engagement_id, pr_number)`,
  `CREATE INDEX IF NOT EXISTS pr_reviews_ticket ON app.pr_reviews (ticket_key)`,
];

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v ? v : null);

export const VERDICTS = ['approve', 'approve-with-nits', 'request-changes', 'escalate'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Diff budget for the prompt — beyond this the reviewer gets a truncation notice. */
export const DIFF_CHAR_LIMIT = 90_000;

export interface ReviewFinding {
  file?: string;
  line?: number;
  severity?: string;
  detail: string;
}

export interface ReviewVerdict {
  verdict: Verdict;
  summary: string;
  blocking: ReviewFinding[];
  nonBlocking: ReviewFinding[];
  acceptanceCriteria: { criterion: string; status: string; evidence?: string }[];
  validation: string;
  risk: string;
}

// ---------- case assembly ----------

export interface ReviewCase {
  ticketKey: string;
  ticketTitle: string;
  ticketDescription: string;
  acceptanceCriteria: string[];
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  prUrl: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  repoName: string;
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
  ciSummary: string;
  /** Provider mergeability — the reviewer must not guess at it from the diff. */
  mergeState: MergeState;
  reviewRunId: number;
  reviewerName: string;
}

const MERGE_LABEL: Record<MergeState, string> = {
  clean: 'merges cleanly',
  conflicts: 'HAS MERGE CONFLICTS — it cannot be merged as it stands',
  unknown: 'mergeability not reported yet',
};

/**
 * The reviewer prompt: the `pr-review` skill template with the case's data
 * blocks filled in. The built-in template ships with the app (prompts are
 * deploys, per the development standards) and is what a workspace starts
 * from; pass the workspace's or project's edited copy to render that instead.
 */
export function renderReviewPrompt(c: ReviewCase, template: string = PR_REVIEW_TEMPLATE): string {
  return renderTemplate(template, {
    pr_number: String(c.prNumber),
    pr_title: c.prTitle,
    repo_name: c.repoName,
    pr_author: c.prAuthor,
    ticket_key: c.ticketKey,
    ticket_title: c.ticketTitle,
    ticket_description: c.ticketDescription.trim() || '(no description — the title is the scope)',
    acceptance_criteria:
      c.acceptanceCriteria.length > 0
        ? ['', 'Acceptance criteria:', ...c.acceptanceCriteria.map((a, i) => `${String(i + 1)}. ${a}`)].join('\n')
        : '\n(no acceptance criteria recorded — say so and treat the title as the contract)',
    branch: c.branch,
    base_branch: c.baseBranch,
    head_sha: c.headSha.slice(0, 8),
    pr_url: c.prUrl,
    ci_summary: c.ciSummary,
    merge_state: MERGE_LABEL[c.mergeState],
    changed_count: String(c.changedFiles.length),
    changed_files: `${c.changedFiles.slice(0, 60).join(', ')}${c.changedFiles.length > 60 ? ', …' : ''}`,
    diff: c.diff,
    truncation_note: c.diffTruncated
      ? `\nNOTE: the diff was truncated at ${String(DIFF_CHAR_LIMIT)} characters. Review what you can see and say in your summary that the tail was not reviewed.`
      : '',
    review_run_id: String(c.reviewRunId),
  });
}

// ---------- response parsing ----------

/** Pull the assistant text out of the shapes serving endpoints actually return (lives with the Databricks adapter). */
export const extractText = extractServingText;

const findings = (v: unknown): ReviewFinding[] => {
  if (!Array.isArray(v)) return [];
  const out: ReviewFinding[] = [];
  for (const item of v.slice(0, 30)) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ detail: item.trim() });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const detail = txt(o.detail) || txt(o.summary) || txt(o.description) || txt(o.message);
    if (!detail.trim()) continue;
    out.push({
      file: txt(o.file) || undefined,
      line: typeof o.line === 'number' && o.line > 0 ? o.line : undefined,
      severity: txt(o.severity) || undefined,
      detail: detail.trim(),
    });
  }
  return out;
};

/**
 * Parse the reviewer's JSON verdict. Defensive by contract: the first {...}
 * block wins, every field is type-checked, and an unrecognized verdict is not
 * coerced into an approval — null means "no usable review", which the caller
 * records as a failure.
 */
export function parseVerdict(text: string): ReviewVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const raw = txt(o.verdict).trim().toLowerCase().replace(/\s+/g, '-');
  const verdict = (VERDICTS as readonly string[]).includes(raw) ? (raw as Verdict) : null;
  if (!verdict) return null;
  const acRaw = Array.isArray(o.acceptance_criteria) ? o.acceptance_criteria : [];
  return {
    verdict,
    summary: txt(o.summary).trim() || '(no summary returned)',
    blocking: findings(o.blocking),
    nonBlocking: findings(o.non_blocking ?? o.nonBlocking),
    acceptanceCriteria: acRaw.slice(0, 40).flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const a = item as Record<string, unknown>;
      const criterion = txt(a.criterion).trim();
      if (!criterion) return [];
      return [{ criterion, status: txt(a.status).trim() || 'unstated', evidence: txt(a.evidence).trim() || undefined }];
    }),
    validation: txt(o.validation).trim(),
    risk: txt(o.risk).trim(),
  };
}

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: '✅ Approve',
  'approve-with-nits': '✅ Approve with nits',
  'request-changes': '⛔ Request changes',
  escalate: '⚠ Escalate — needs a human decision',
};

const findingLines = (list: ReviewFinding[]): string[] =>
  list.map((f, i) => {
    const where = f.file ? `\`${f.file}${f.line ? `:${String(f.line)}` : ''}\` — ` : '';
    return `${String(i + 1)}. ${where}${f.detail}`;
  });

/** The review as it appears on the PR: fixed sections, blank ones omitted. */
export function formatReviewComment(v: ReviewVerdict, c: { reviewerName: string; ticketKey: string }): string {
  const out = [`## ${VERDICT_LABEL[v.verdict]}`, '', v.summary, ''];
  if (v.validation) out.push(`**Validation** — ${v.validation}`, '');
  if (v.acceptanceCriteria.length > 0) {
    out.push('**Acceptance criteria**');
    for (const a of v.acceptanceCriteria) {
      const mark = a.status === 'met' ? '✓' : a.status === 'unmet' ? '✗' : '?';
      out.push(`- ${mark} ${a.criterion}${a.evidence ? ` — \`${a.evidence}\`` : ''}`);
    }
    out.push('');
  }
  if (v.blocking.length > 0) out.push('**Blocking**', ...findingLines(v.blocking), '');
  if (v.nonBlocking.length > 0) out.push('**Non-blocking**', ...findingLines(v.nonBlocking.slice(0, 5)), '');
  if (v.risk) out.push(`**Risk** — ${v.risk}`, '');
  out.push(
    '---',
    `First-pass review by **${c.reviewerName}** for ${c.ticketKey}. The reviewer never merges — merging is the human gate.`,
  );
  return out.join('\n');
}

/** The board-side version: short, because the drawer is not the place for the full diff review. */
export function formatTicketComment(v: ReviewVerdict, c: { prNumber: number; prUrl: string }): string {
  const counts = [
    v.blocking.length > 0 ? `${String(v.blocking.length)} blocking` : '',
    v.nonBlocking.length > 0 ? `${String(v.nonBlocking.length)} nit${v.nonBlocking.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return [
    `**PR review — ${VERDICT_LABEL[v.verdict]}**`,
    '',
    v.summary,
    ...(counts.length > 0 ? ['', counts.join(' · ')] : []),
    '',
    `PR #${String(c.prNumber)}: ${c.prUrl}`,
  ].join('\n');
}

// ---------- GitHub case material ----------

interface PrDetail {
  title: string;
  author: string;
  url: string;
  branch: string;
  base: string;
  headSha: string;
  state: string;
  draft: boolean;
  merge: MergeState;
}

async function fetchPrDetail(conn: Connection, token: string, number: number): Promise<PrDetail> {
  const d = (await jsonFetch(`https://api.github.com/repos/${githubPath(conn)}/pulls/${String(number)}`, githubHeaders(token))) as {
    title?: string;
    html_url?: string;
    state?: string;
    draft?: boolean;
    mergeable?: boolean | null;
    user?: { login?: string };
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
  };
  return {
    title: d.title ?? '',
    author: d.user?.login ?? '',
    url: d.html_url ?? '',
    branch: d.head?.ref ?? '',
    base: d.base?.ref ?? conn.default_branch,
    headSha: d.head?.sha ?? '',
    state: d.state ?? '',
    draft: d.draft === true,
    // GitHub computes mergeability lazily, so null here means "not yet" — the
    // requeue path re-asks with polling rather than treating it as clean.
    merge: d.mergeable == null ? 'unknown' : d.mergeable ? 'clean' : 'conflicts',
  };
}

/** Raw unified diff; GitHub serves it as text under a media-type Accept header. */
async function fetchDiff(conn: Connection, token: string, number: number): Promise<string> {
  const resp = await fetch(`https://api.github.com/repos/${githubPath(conn)}/pulls/${String(number)}`, {
    headers: { ...githubHeaders(token), Accept: 'application/vnd.github.v3.diff' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`could not read the diff (GitHub returned ${String(resp.status)})`);
  return await resp.text();
}

async function fetchChangedFiles(conn: Connection, token: string, number: number): Promise<string[]> {
  const list = (await jsonFetch(
    `https://api.github.com/repos/${githubPath(conn)}/pulls/${String(number)}/files?per_page=100`,
    githubHeaders(token),
  )) as { filename?: string }[];
  return list.map((f) => f.filename ?? '').filter(Boolean);
}

/** CI as the reviewer should report it: the console never re-runs the build itself. */
async function fetchCiSummary(conn: Connection, token: string, sha: string): Promise<string> {
  if (!sha) return 'unknown — no head commit resolved';
  try {
    const d = (await jsonFetch(
      `https://api.github.com/repos/${githubPath(conn)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`,
      githubHeaders(token),
    )) as { workflow_runs?: { name?: string; status?: string; conclusion?: string | null }[] };
    const runs = d.workflow_runs ?? [];
    if (runs.length === 0) return 'no CI run has reported on this commit yet';
    return runs
      .map((r) => `${r.name ?? 'workflow'}: ${r.status === 'completed' ? (r.conclusion ?? 'completed') : (r.status ?? 'unknown')}`)
      .join(' · ');
  } catch (err) {
    return `could not be read (${(err as Error).message})`;
  }
}

async function postPrComment(conn: Connection, token: string, number: number, body: string): Promise<void> {
  await jsonFetch(`https://api.github.com/repos/${githubPath(conn)}/issues/${String(number)}/comments`, githubHeaders(token), {
    method: 'POST',
    body: { body },
  });
}

// ---------- running a review ----------

export interface ReviewerAgent {
  name: string;
  endpoint: string;
  agentType: string;
}

/** The reviewer's name when a project registered no endpoint agent — the workspace's review model does the pass. */
export const DEFAULT_REVIEWER_NAME = 'PR Reviewer';

/** The engagement's review gate, if one is registered and endpoint-backed. */
export async function findReviewer(q: Query, engagementId: string): Promise<ReviewerAgent | null> {
  const row = (
    await q(
      `SELECT name, endpoint_name, agent_type FROM app.project_agents
       WHERE engagement_id = $1 AND role = 'pr-reviewer' AND endpoint_name IS NOT NULL AND endpoint_name <> ''
       ORDER BY id LIMIT 1`,
      [engagementId],
    )
  ).rows[0];
  if (!row) return null;
  return { name: txt(row.name), endpoint: txt(row.endpoint_name), agentType: txt(row.agent_type) };
}

const feed = (q: Query, engagementId: string, text: string) =>
  q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', false)`,
    [engagementId, text],
  ).catch((err: unknown) => console.warn('[pr-review] feed write failed:', (err as Error).message));

/** Raise the existing board flag channel so an escalation shows on the card. */
async function flagTicket(q: Query, ticketKey: string, reason: string): Promise<void> {
  await q(
    `UPDATE app.agent_tasks SET flag = $2, updated_at = NOW()
     WHERE id = (SELECT id FROM app.agent_tasks WHERE ticket_key = $1 ORDER BY id DESC LIMIT 1)`,
    [ticketKey, reason.slice(0, 2000)],
  );
}

export interface RunReviewResult {
  state: 'posted' | 'failed' | 'skipped';
  reason?: string;
  verdict?: Verdict;
  reviewId?: number;
}

/**
 * Assemble the case, invoke the reviewer, publish the verdict. Every failure
 * path lands in app.pr_reviews with state 'failed' and a feed warning — the PR
 * is left untouched for the human.
 */
export async function runPrReview(
  q: Query,
  engagementId: string,
  ticketKey: string,
  prNumber: number,
  trigger: 'pr-opened' | 'manual',
): Promise<RunReviewResult> {
  // The review role decides the provider; a project's registered endpoint
  // agent (Agent Bricks / model serving) pins the model when that provider is
  // Databricks, which keeps every pre-phase-3 deployment reviewing exactly as
  // it did.
  const reviewRole = await resolveRole(q, 'review');
  if (!reviewRole) return { state: 'skipped', reason: 'no model is mapped to the review role for this workspace' };
  const registered = await findReviewer(q, engagementId);
  const reviewer: ReviewerAgent = registered ?? { name: DEFAULT_REVIEWER_NAME, endpoint: '', agentType: 'control-plane' };
  const modelOverride = registered && reviewRole.config.kind === 'databricks' ? registered.endpoint : undefined;
  const modelLabel = `${reviewRole.config.kind}:${modelOverride ?? reviewRole.model}`;

  // Security gate (DAT-212): a disabled reviewer, or one without the pr_review
  // scope, is skipped before the model is invoked. Skipped (not failed) —
  // this is a deliberate configuration, and the PR is left for a human either
  // way; the denial is already logged and on the engagement feed.
  const gate = await checkAgentAction(q, { engagementId, agent: reviewer.name, action: 'pr_review', detail: `${ticketKey} PR #${String(prNumber)}` });
  if (!gate.allowed) return { state: 'skipped', reason: gate.reason };

  const conn = await loadConnection(q, engagementId);
  if (!conn) return { state: 'skipped', reason: 'no repository connection' };
  if (conn.provider !== 'github') {
    return { state: 'skipped', reason: 'automated review supports GitHub connections today' };
  }

  const ticket = (await q('SELECT key, title, description, ac FROM app.tickets WHERE key = $1', [ticketKey])).rows[0];
  if (!ticket) return { state: 'skipped', reason: `ticket ${ticketKey} not found` };

  const inserted = await q(
    `INSERT INTO app.pr_reviews (engagement_id, ticket_key, pr_number, reviewer, endpoint, trigger, state)
     VALUES ($1,$2,$3,$4,$5,$6,'running') RETURNING id`,
    [engagementId, ticketKey, prNumber, reviewer.name, modelLabel, trigger],
  );
  const reviewId = num(inserted.rows[0]?.id);

  const fail = async (message: string): Promise<RunReviewResult> => {
    await q(`UPDATE app.pr_reviews SET state = 'failed', error = $2, completed_at = NOW() WHERE id = $1`, [reviewId, message.slice(0, 2000)]);
    console.warn(`[pr-review] ${ticketKey} PR #${String(prNumber)} review failed: ${message}`);
    await feed(
      q,
      engagementId,
      `⚠ PR review of #${String(prNumber)} (${ticketKey}) could not complete — ${message.slice(0, 200)}. The PR is unreviewed; it needs a human.`,
    );
    return { state: 'failed', reason: message, reviewId };
  };

  try {
    const token = await connectionToken(conn);
    const pr = await fetchPrDetail(conn, token, prNumber);
    if (pr.draft) {
      await q(`UPDATE app.pr_reviews SET state = 'skipped', error = 'draft PR', completed_at = NOW() WHERE id = $1`, [reviewId]);
      return { state: 'skipped', reason: 'PR is a draft', reviewId };
    }
    const [rawDiff, changedFiles, ciSummary] = await Promise.all([
      fetchDiff(conn, token, prNumber),
      fetchChangedFiles(conn, token, prNumber).catch(() => [] as string[]),
      fetchCiSummary(conn, token, pr.headSha),
    ]);
    const diffTruncated = rawDiff.length > DIFF_CHAR_LIMIT;
    await q(`UPDATE app.pr_reviews SET head_sha = $2 WHERE id = $1`, [reviewId, pr.headSha]);

    const ac = (() => {
      try {
        const arr: unknown = typeof ticket.ac === 'string' ? JSON.parse(ticket.ac) : ticket.ac;
        return Array.isArray(arr) ? arr.map(txt).filter(Boolean) : [];
      } catch {
        return [];
      }
    })();

    await ensurePrReviewSkill(q).catch((err: unknown) => console.warn('[pr-review] could not seed the pr-review skill:', (err as Error).message));
    const template = await loadPrReviewTemplate(q, engagementId);
    const prompt = renderReviewPrompt({
      ticketKey,
      ticketTitle: txt(ticket.title),
      ticketDescription: txt(ticket.description),
      acceptanceCriteria: ac,
      prNumber,
      prTitle: pr.title,
      prAuthor: pr.author,
      prUrl: pr.url,
      branch: pr.branch,
      baseBranch: pr.base,
      headSha: pr.headSha,
      repoName: conn.repo_name,
      changedFiles,
      diff: diffTruncated ? rawDiff.slice(0, DIFF_CHAR_LIMIT) : rawDiff,
      diffTruncated,
      ciSummary,
      mergeState: pr.merge,
      reviewRunId: reviewId,
      reviewerName: reviewer.name,
    }, template);

    console.log(
      `[pr-review] ${ticketKey} PR #${String(prNumber)} → ${reviewer.name} (${modelLabel}), ${String(changedFiles.length)} files, ${String(prompt.length)} prompt chars`,
    );
    const response = await invokeModel(
      'review',
      { messages: [{ role: 'user', content: prompt }], maxTokens: 4000, json: true },
      { flow: 'pr-review', engagementId, ticketKey, modelOverride },
    );

    // The agent may already have posted through the MCP tool mid-turn.
    const current = (await q('SELECT state, verdict FROM app.pr_reviews WHERE id = $1', [reviewId])).rows[0];
    if (txt(current?.state) === 'posted') {
      return { state: 'posted', verdict: txt(current?.verdict) as Verdict, reviewId };
    }

    const verdict = parseVerdict(response.text);
    if (!verdict) return await fail('the reviewer did not return a usable verdict (no parseable JSON in the response)');

    await publishReview(q, { reviewId, engagementId, ticketKey, prNumber, prUrl: pr.url, reviewerName: reviewer.name, verdict, via: 'invoke' }, conn, token);
    return { state: 'posted', verdict: verdict.verdict, reviewId };
  } catch (err) {
    return await fail((err as Error).message);
  }
}

/** Post a parsed verdict everywhere it belongs and close out the review row. */
async function publishReview(
  q: Query,
  ctx: {
    reviewId: number;
    engagementId: string;
    ticketKey: string;
    prNumber: number;
    prUrl: string;
    reviewerName: string;
    verdict: ReviewVerdict;
    via: 'invoke' | 'mcp';
  },
  conn: Connection | null,
  token: string | null,
): Promise<void> {
  const body = formatReviewComment(ctx.verdict, { reviewerName: ctx.reviewerName, ticketKey: ctx.ticketKey });
  if (conn && token) {
    try {
      await postPrComment(conn, token, ctx.prNumber, body);
    } catch (err) {
      console.warn(`[pr-review] could not comment on PR #${String(ctx.prNumber)}:`, (err as Error).message);
    }
  }
  await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
    ctx.ticketKey,
    ctx.reviewerName,
    formatTicketComment(ctx.verdict, { prNumber: ctx.prNumber, prUrl: ctx.prUrl }),
  ]);
  if (ctx.verdict.verdict === 'escalate') {
    await flagTicket(q, ctx.ticketKey, `PR review escalated on #${String(ctx.prNumber)} — ${ctx.verdict.summary}`).catch((err: unknown) =>
      console.warn('[pr-review] flag failed:', (err as Error).message),
    );
  }
  await feed(
    q,
    ctx.engagementId,
    `${VERDICT_LABEL[ctx.verdict.verdict]} — ${ctx.reviewerName} reviewed PR #${String(ctx.prNumber)} for ${ctx.ticketKey}. ${ctx.verdict.summary.slice(0, 180)}`,
  );
  await q(
    `UPDATE app.pr_reviews SET state = 'posted', verdict = $2, summary = $3, body = $4, submitted_via = $5, completed_at = NOW() WHERE id = $1`,
    [ctx.reviewId, ctx.verdict.verdict, ctx.verdict.summary.slice(0, 2000), body, ctx.via],
  );
  await requeueIfConflicted(q, ctx, conn);
}

/**
 * DAT-200: a review that leaves the PR unable to merge sends the ticket back
 * to the top of the runner queue to resolve the conflict. Hung off the single
 * publish point so both routes in — the invoke-side parse and the agent's own
 * submit_pr_review — get the same treatment, and best-effort throughout: a
 * requeue that cannot happen must never unpublish a review that already did.
 */
async function requeueIfConflicted(
  q: Query,
  ctx: { reviewId: number; engagementId: string; ticketKey: string; prNumber: number; prUrl: string; verdict: ReviewVerdict },
  conn: Connection | null,
): Promise<void> {
  try {
    if (!conn) return;
    const info = await prMergeInfo(conn, ctx.prNumber);
    const result = await handleReviewedPr(
      q,
      {
        engagementId: ctx.engagementId,
        ticketKey: ctx.ticketKey,
        prNumber: ctx.prNumber,
        prUrl: ctx.prUrl || info.url,
        branch: info.headBranch,
        baseBranch: info.baseBranch,
        reviewId: ctx.reviewId,
      },
      { verdict: ctx.verdict.verdict, mergeState: info.merge, text: verdictText(ctx.verdict) },
    );
    if (result.outcome === 'skipped') {
      console.log(`[pr-review] PR #${String(ctx.prNumber)} (${ctx.ticketKey}) not requeued — ${result.reason}`);
    }
  } catch (err) {
    console.warn(`[pr-review] merge-conflict requeue check failed for PR #${String(ctx.prNumber)}:`, (err as Error).message);
  }
}

// ---------- MCP tool: let the agent post its own review ----------

export function reviewToolDefs(): ScopingToolDef[] {
  return [
    {
      name: 'submit_pr_review',
      description:
        'Publish a PR review verdict from the review gate: posts the review as a comment on the pull request and a summary on the ticket, and flags the ticket when the verdict is escalate. Never merges. Use the review_run_id you were given in the review prompt.',
      parameters: {
        type: 'object',
        properties: {
          review_run_id: { type: 'integer', description: 'The review run id from the review prompt' },
          verdict: { type: 'string', enum: [...VERDICTS] },
          summary: { type: 'string', description: 'One or two sentences a human reads before clicking merge' },
          validation: { type: 'string', description: 'What the CI status shows, in one line' },
          acceptance_criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                criterion: { type: 'string' },
                status: { type: 'string', enum: ['met', 'unmet', 'unverifiable'] },
                evidence: { type: 'string', description: 'file.ts:line that satisfies it' },
              },
              required: ['criterion', 'status'],
            },
          },
          blocking: {
            type: 'array',
            items: {
              type: 'object',
              properties: { file: { type: 'string' }, line: { type: 'integer' }, detail: { type: 'string' } },
              required: ['detail'],
            },
          },
          non_blocking: {
            type: 'array',
            items: {
              type: 'object',
              properties: { file: { type: 'string' }, line: { type: 'integer' }, detail: { type: 'string' } },
              required: ['detail'],
            },
          },
          risk: { type: 'string', description: 'Blast radius and reversibility' },
        },
        required: ['review_run_id', 'verdict', 'summary'],
      },
    },
  ];
}

export type ReviewToolResult = { ok: true; summary: string; data: unknown } | { ok: false; summary: string; error: string };

export async function executeReviewTool(q: Query, name: string, args: Record<string, unknown>): Promise<ReviewToolResult> {
  if (name !== 'submit_pr_review') return { ok: false, summary: name, error: `Unknown tool: ${name}` };
  try {
    const runId = typeof args.review_run_id === 'number' ? args.review_run_id : Number(txt(args.review_run_id));
    if (!runId || Number.isNaN(runId)) return { ok: false, summary: name, error: 'review_run_id is required' };
    const row = (await q('SELECT * FROM app.pr_reviews WHERE id = $1', [runId])).rows[0];
    if (!row) return { ok: false, summary: name, error: `No review run ${String(runId)}` };
    if (txt(row.state) === 'posted') return { ok: false, summary: name, error: 'This review has already been published' };
    const verdict = parseVerdict(JSON.stringify(args));
    if (!verdict) return { ok: false, summary: name, error: `verdict must be one of ${VERDICTS.join(', ')}` };

    const engagementId = txt(row.engagement_id);
    const ticketKey = txt(row.ticket_key);
    const prNumber = num(row.pr_number);
    const conn = await loadConnection(q, engagementId);
    const token = conn ? await connectionToken(conn) : null;
    const prUrl = conn ? `https://github.com/${githubPath(conn)}/pull/${String(prNumber)}` : '';
    await publishReview(
      q,
      { reviewId: runId, engagementId, ticketKey, prNumber, prUrl, reviewerName: txt(row.reviewer) || 'PR Reviewer', verdict, via: 'mcp' },
      conn,
      token,
    );
    return { ok: true, summary: `submit_pr_review(${String(runId)}) → ${verdict.verdict}`, data: { published: true, verdict: verdict.verdict } };
  } catch (err) {
    return { ok: false, summary: name, error: (err as Error).message };
  }
}

// ---------- routes ----------

const ReviewBody = z.object({ ticketKey: z.string().trim().min(1).optional() });

export function setupPrReviewRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Caller | null>,
): void {
  // PR opened → review, in the background. Never awaited by the sync pass.
  onPrOpened((engagementId, ticketKey, prNumber) => {
    void runPrReview(q, engagementId, ticketKey, prNumber, 'pr-opened')
      .then((r) => {
        if (r.state === 'skipped') console.log(`[pr-review] ${ticketKey} PR #${String(prNumber)} not reviewed — ${r.reason ?? ''}`);
      })
      .catch((err: unknown) => console.warn('[pr-review] trigger failed:', (err as Error).message));
  });

  /** Latest review for a PR — what the ticket drawer shows next to the PR row. */
  app.get('/api/tickets/:key/prs/:number/review', async (req, res) => {
    try {
      const rows = (
        await q('SELECT * FROM app.pr_reviews WHERE ticket_key = $1 AND pr_number = $2 ORDER BY id DESC LIMIT 1', [
          req.params.key,
          Number(req.params.number),
        ])
      ).rows;
      const r = rows[0];
      if (!r) {
        res.json({ review: null });
        return;
      }
      res.json({
        review: {
          id: num(r.id),
          state: txt(r.state),
          verdict: r.verdict == null ? null : txt(r.verdict),
          summary: r.summary == null ? null : txt(r.summary),
          reviewer: txt(r.reviewer),
          error: r.error == null ? null : txt(r.error),
          createdAt: iso(r.created_at),
          completedAt: iso(r.completed_at),
        },
      });
    } catch (err) {
      console.error('load pr review failed:', err);
      res.status(500).json({ error: 'Failed to load the review' });
    }
  });

  /** Manual re-run: the same gate a PR-opened event triggers. Lead-only. */
  app.post('/api/tickets/:key/prs/:number/review', async (req, res) => {
    const parsed = ReviewBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid review request' });
      return;
    }
    try {
      const key = req.params.key;
      const ticket = (await q('SELECT engagement_id FROM app.tickets WHERE key = $1', [key])).rows[0];
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const engagementId = txt(ticket.engagement_id);
      const lead = await requireLead(req, res, engagementId);
      if (!lead) return;
      const result = await runPrReview(q, engagementId, key, Number(req.params.number), 'manual');
      if (result.state === 'skipped') {
        res.status(409).json({ error: `No review ran — ${result.reason ?? 'nothing to review'}` });
        return;
      }
      if (result.state === 'failed') {
        res.status(502).json({ error: `The reviewer could not complete — ${result.reason ?? 'unknown error'}` });
        return;
      }
      res.json({ ok: true, verdict: result.verdict, reviewId: result.reviewId });
    } catch (err) {
      console.error('pr review failed:', err);
      res.status(500).json({ error: 'Failed to run the review' });
    }
  });
}
