import { z } from 'zod';
import type express from 'express';
import {
  adoApi,
  adoHeaders,
  connectionToken,
  findTicketKey,
  githubHeaders,
  githubPath,
  jsonFetch,
  loadConnection,
  syncConnection,
  type Connection,
} from './repos';

/**
 * PR merge-conflict handling for agent-raised PRs (runner-side endpoints).
 *
 * After a delivery agent opens a PR, the target branch may have diverged into
 * merge conflicts. The agent has the clone (so it computes the *conflicted
 * files* locally via `git merge-tree`), while the console has the provider
 * token and the PR↔ticket links — so the intelligence lives here:
 *
 *   POST /api/agent/work/:id/pr/:number/conflicts  — mergeability + which other
 *        open/recent PRs touch the same files, which tickets they belong to,
 *        and a safe-to-auto-resolve vs developer-review assessment.
 *   POST /api/agent/work/:id/pr/:number/escalate   — flag the PR for developer
 *        review: PR comment naming the conflicting PR(s)/ticket(s), a
 *        `merge-conflict` label, review requests to the developers who own the
 *        conflicting changes, a board flag on the agent task, and a comment on
 *        each impacted ticket.
 *   POST /api/agent/work/:id/pr/:number/comment    — plain PR comment, used by
 *        agents to document an auto-resolution on the PR itself.
 *
 * Risk threshold ("potential impact to other tickets"): a conflicted file that
 * an open PR also touches, or that a recently merged PR linked to a *different*
 * ticket touched, makes the conflict risky — the agent must not auto-resolve.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// ---------- pure analysis (unit-tested in pr-conflicts.test.ts) ----------

export interface RelatedPr {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'merged' | 'closed';
  branch: string;
  url: string;
  ticketKey: string | null;
  overlappingFiles: string[];
}

export interface ConflictAssessment {
  risky: boolean;
  recommendation: 'auto-resolve' | 'developer-review';
  reasons: string[];
  impactedTickets: string[];
}

export function overlappingFiles(ours: string[], theirs: string[]): string[] {
  const mine = new Set(ours);
  return [...new Set(theirs.filter((f) => mine.has(f)))];
}

/**
 * Classify a conflict as safe-to-attempt or needing a developer. `related`
 * carries only PRs that overlap the conflict basis; PRs linked to the same
 * ticket as ours (stacked/superseded agent branches) never count as risk.
 */
export function assessConflicts(ourTicket: string | null, related: RelatedPr[]): ConflictAssessment {
  const reasons: string[] = [];
  const impacted = new Set<string>();
  for (const pr of related) {
    if (pr.overlappingFiles.length === 0) continue;
    if (pr.ticketKey && ourTicket && pr.ticketKey === ourTicket) continue;
    const files = pr.overlappingFiles.slice(0, 5).join(', ');
    if (pr.state === 'open') {
      reasons.push(`Open PR #${pr.number}${pr.ticketKey ? ` (${pr.ticketKey})` : ''} touches the same files: ${files}`);
      if (pr.ticketKey) impacted.add(pr.ticketKey);
    } else if (pr.ticketKey) {
      reasons.push(`Merged PR #${pr.number} from ticket ${pr.ticketKey} changed the same files: ${files}`);
      impacted.add(pr.ticketKey);
    }
  }
  const risky = reasons.length > 0;
  return {
    risky,
    recommendation: risky ? 'developer-review' : 'auto-resolve',
    reasons,
    impactedTickets: [...impacted],
  };
}

// ---------- provider operations ----------

interface PrInfo {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'merged' | 'closed';
  baseBranch: string;
  headBranch: string;
  url: string;
  /** clean = provider says it merges; conflicts = provider says it does not; unknown = still computing / unsupported. */
  merge: 'clean' | 'conflicts' | 'unknown';
}

interface ConflictOps {
  prInfo(conn: Connection, number: number): Promise<PrInfo>;
  changedFiles(conn: Connection, number: number): Promise<string[]>;
  comment(conn: Connection, number: number, body: string): Promise<void>;
  addLabels(conn: Connection, number: number, labels: string[]): Promise<string[]>;
  requestReviewers(conn: Connection, number: number, reviewers: string[]): Promise<string[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const githubOps: ConflictOps = {
  async prInfo(conn, number) {
    // GitHub computes `mergeable` lazily — the first GET after a push often
    // returns null; poll briefly before reporting unknown.
    for (let attempt = 0; ; attempt++) {
      const p = (await jsonFetch(`https://api.github.com/repos/${githubPath(conn)}/pulls/${number}`, githubHeaders(conn.token))) as {
        title: string;
        state: string;
        merged_at: string | null;
        mergeable: boolean | null;
        base?: { ref?: string };
        head?: { ref?: string };
        html_url: string;
        user?: { login?: string };
      };
      const open = p.state === 'open' && !p.merged_at;
      if (!open || p.mergeable !== null || attempt >= 3) {
        return {
          number,
          title: p.title,
          author: p.user?.login ?? '',
          state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed',
          baseBranch: p.base?.ref ?? conn.default_branch,
          headBranch: p.head?.ref ?? '',
          url: p.html_url,
          merge: p.mergeable === null ? 'unknown' : p.mergeable ? 'clean' : 'conflicts',
        };
      }
      await sleep(1500);
    }
  },
  async changedFiles(conn, number) {
    const files: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const list = (await jsonFetch(
        `https://api.github.com/repos/${githubPath(conn)}/pulls/${number}/files?per_page=100&page=${page}`,
        githubHeaders(conn.token),
      )) as { filename: string; previous_filename?: string }[];
      for (const f of list) {
        files.push(f.filename);
        if (f.previous_filename) files.push(f.previous_filename); // renames conflict on both paths
      }
      if (list.length < 100) break;
    }
    return files;
  },
  async comment(conn, number, body) {
    await jsonFetch(`https://api.github.com/repos/${githubPath(conn)}/issues/${number}/comments`, githubHeaders(conn.token), {
      method: 'POST',
      body: { body },
    });
  },
  async addLabels(conn, number, labels) {
    await jsonFetch(`https://api.github.com/repos/${githubPath(conn)}/issues/${number}/labels`, githubHeaders(conn.token), {
      method: 'POST',
      body: { labels },
    });
    return labels;
  },
  async requestReviewers(conn, number, reviewers) {
    // One at a time: GitHub 422s the whole request if any login is the PR
    // author or not a collaborator, and we want the valid ones to stick.
    const added: string[] = [];
    for (const login of reviewers) {
      try {
        await jsonFetch(`https://api.github.com/repos/${githubPath(conn)}/pulls/${number}/requested_reviewers`, githubHeaders(conn.token), {
          method: 'POST',
          body: { reviewers: [login] },
        });
        added.push(login);
      } catch {
        /* not a collaborator / PR author — the @mention in the comment still notifies them */
      }
    }
    return added;
  },
};

const adoOps: ConflictOps = {
  async prInfo(conn, number) {
    const p = (await jsonFetch(`${adoApi(conn.repo_url)}/pullrequests/${number}?api-version=7.1`, adoHeaders(conn.token))) as {
      title?: string;
      status?: string;
      mergeStatus?: string;
      targetRefName?: string;
      sourceRefName?: string;
      createdBy?: { displayName?: string };
    };
    return {
      number,
      title: p.title ?? '',
      author: p.createdBy?.displayName ?? '',
      state: p.status === 'active' ? 'open' : p.status === 'completed' ? 'merged' : 'closed',
      baseBranch: (p.targetRefName ?? '').replace(/^refs\/heads\//, '') || conn.default_branch,
      headBranch: (p.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      url: `${conn.repo_url}/pullrequest/${number}`,
      merge: p.mergeStatus === 'conflicts' ? 'conflicts' : p.mergeStatus === 'succeeded' ? 'clean' : 'unknown',
    };
  },
  async changedFiles(conn, number) {
    const base = adoApi(conn.repo_url);
    const iters = (await jsonFetch(`${base}/pullrequests/${number}/iterations?api-version=7.1`, adoHeaders(conn.token))) as {
      value?: { id: number }[];
    };
    const last = iters.value?.[iters.value.length - 1]?.id;
    if (!last) return [];
    const changes = (await jsonFetch(
      `${base}/pullrequests/${number}/iterations/${last}/changes?$top=300&$compareTo=0&api-version=7.1`,
      adoHeaders(conn.token),
    )) as { changeEntries?: { item?: { path?: string } }[] };
    return (changes.changeEntries ?? []).map((c) => (c.item?.path ?? '').replace(/^\//, '')).filter(Boolean);
  },
  async comment(conn, number, body) {
    await jsonFetch(`${adoApi(conn.repo_url)}/pullrequests/${number}/threads?api-version=7.1`, adoHeaders(conn.token), {
      method: 'POST',
      body: { comments: [{ parentCommentId: 0, content: body, commentType: 'text' }], status: 'active' },
    });
  },
  async addLabels(conn, number, labels) {
    const added: string[] = [];
    for (const name of labels) {
      try {
        await jsonFetch(`${adoApi(conn.repo_url)}/pullrequests/${number}/labels?api-version=7.1-preview.1`, adoHeaders(conn.token), {
          method: 'POST',
          body: { name },
        });
        added.push(name);
      } catch {
        /* labels are optional decoration — carry on */
      }
    }
    return added;
  },
  requestReviewers() {
    // ADO reviewer assignment needs identity ids — the comment mention is the notification.
    return Promise.resolve([]);
  },
};

const opsFor = (conn: Connection): ConflictOps => (conn.provider === 'github' ? githubOps : adoOps);

// ---------- shared analysis ----------

interface ConflictReport {
  pr: PrInfo;
  ticketKey: string | null;
  overlapBasis: 'conflict_files' | 'all_pr_files';
  conflictFiles: string[];
  relatedPrs: RelatedPr[];
  assessment: ConflictAssessment;
}

/** How far back a merged PR still counts as "recent" conflict context. */
const MERGED_LOOKBACK = `14 days`;
/** Cap on how many candidate PRs get a per-PR file listing (one API call each). */
const MAX_RELATED = 15;

async function analyzeConflicts(
  q: Query,
  conn: Connection,
  ourTicket: string | null,
  prNumber: number,
  conflictFiles: string[] | undefined,
): Promise<ConflictReport> {
  const live = { ...conn, token: await connectionToken(conn) };
  const ops = opsFor(conn);
  const pr = await ops.prInfo(live, prNumber);
  const basis = conflictFiles?.length ? [...new Set(conflictFiles)] : await ops.changedFiles(live, prNumber);

  // Freshen repo_prs so just-opened PRs and their ticket links are visible.
  await syncConnection(q, conn).catch((err) => console.warn('[pr-conflicts] pre-analysis sync failed:', (err as Error).message));

  const candidates = (
    await q(
      `SELECT number, title, author, state, branch, url, ticket_key FROM app.repo_prs
       WHERE connection_id = $1 AND number <> $2
         AND (state = 'open' OR (state = 'merged' AND updated_at > NOW() - INTERVAL '${MERGED_LOOKBACK}'))
       ORDER BY (state = 'open') DESC, updated_at DESC NULLS LAST LIMIT ${MAX_RELATED}`,
      [conn.id, prNumber],
    )
  ).rows;

  const related: RelatedPr[] = [];
  for (const row of candidates) {
    const number = Number(row.number);
    const files = await ops.changedFiles(live, number).catch(() => [] as string[]);
    const overlap = overlappingFiles(basis, files);
    if (overlap.length === 0) continue;
    const branch = typeof row.branch === 'string' ? row.branch : '';
    const title = typeof row.title === 'string' ? row.title : '';
    related.push({
      number,
      title,
      author: typeof row.author === 'string' ? row.author : '',
      state: row.state === 'open' ? 'open' : row.state === 'merged' ? 'merged' : 'closed',
      branch,
      url: typeof row.url === 'string' ? row.url : '',
      ticketKey: typeof row.ticket_key === 'string' && row.ticket_key ? row.ticket_key : findTicketKey(branch, title),
      overlappingFiles: overlap,
    });
  }

  return {
    pr,
    ticketKey: ourTicket,
    overlapBasis: conflictFiles?.length ? 'conflict_files' : 'all_pr_files',
    conflictFiles: basis,
    relatedPrs: related,
    assessment: assessConflicts(ourTicket, related),
  };
}

// ---------- routes ----------

const ConflictsBody = z.object({
  agent: z.string().min(1).max(80),
  conflict_files: z.array(z.string().min(1).max(500)).max(500).optional(),
});

const EscalateBody = z.object({
  agent: z.string().min(1).max(80),
  reason: z.string().min(1).max(2000),
  conflicting_prs: z.array(z.number().int().positive()).max(20).optional(),
});

const PrCommentBody = z.object({
  agent: z.string().min(1).max(80),
  body: z.string().min(1).max(8000),
});

export function setupPrConflictRoutes(app: express.Application, q: Query) {
  /** Resolve an active task claimed by this agent, or answer 4xx and return null. */
  const activeTask = async (req: express.Request, res: express.Response, agent: string): Promise<Record<string, unknown> | null> => {
    const task = (
      await q(`SELECT * FROM app.agent_tasks WHERE id = $1 AND state IN ('claimed','working')`, [Number(req.params.id)])
    ).rows[0];
    if (!task) {
      res.status(404).json({ error: 'No active task with this id' });
      return null;
    }
    if (String(task.agent) !== agent) {
      res.status(409).json({ error: `Task is claimed by ${String(task.agent)}` });
      return null;
    }
    return task;
  };

  const prNumber = (req: express.Request, res: express.Response): number | null => {
    const n = Number(req.params.number);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ error: 'Invalid PR number' });
      return null;
    }
    return n;
  };

  app.post('/api/agent/work/:id/pr/:number/conflicts', async (req, res) => {
    const parsed = ConflictsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent (runner name) is required' });
      return;
    }
    try {
      const task = await activeTask(req, res, parsed.data.agent);
      if (!task) return;
      const number = prNumber(req, res);
      if (number === null) return;
      const conn = await loadConnection(q, String(task.engagement_id));
      if (!conn) {
        res.status(404).json({ error: 'No repository connected to this engagement' });
        return;
      }
      const report = await analyzeConflicts(q, conn, String(task.ticket_key), number, parsed.data.conflict_files);
      res.json(report);
    } catch (err) {
      console.warn('pr conflict analysis failed:', (err as Error).message);
      res.status(502).json({ error: `Conflict analysis failed — ${(err as Error).message}` });
    }
  });

  app.post('/api/agent/work/:id/pr/:number/escalate', async (req, res) => {
    const parsed = EscalateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent and reason are required' });
      return;
    }
    try {
      const task = await activeTask(req, res, parsed.data.agent);
      if (!task) return;
      const number = prNumber(req, res);
      if (number === null) return;
      const conn = await loadConnection(q, String(task.engagement_id));
      if (!conn) {
        res.status(404).json({ error: 'No repository connected to this engagement' });
        return;
      }
      const { agent, reason, conflicting_prs } = parsed.data;
      const ticketKey = String(task.ticket_key);
      const live = { ...conn, token: await connectionToken(conn) };
      const ops = opsFor(conn);
      const ourPr = await ops.prInfo(live, number);

      // Resolve the conflicting PRs' coordinates (live, so brand-new PRs work too).
      const conflicting: PrInfo[] = [];
      for (const n of [...new Set(conflicting_prs ?? [])].filter((n) => n !== number)) {
        try {
          conflicting.push(await ops.prInfo(live, n));
        } catch {
          /* deleted/inaccessible PR — the reason text still tells the story */
        }
      }
      const linkRows = (
        await q(`SELECT number, ticket_key FROM app.repo_prs WHERE connection_id = $1 AND number = ANY($2)`, [
          conn.id,
          conflicting.map((p) => p.number),
        ])
      ).rows;
      const linkByNumber = new Map(linkRows.map((r) => [Number(r.number), typeof r.ticket_key === 'string' ? r.ticket_key : null]));
      const prTicket = (p: PrInfo): string | null => linkByNumber.get(p.number) ?? findTicketKey(p.headBranch, p.title);
      const impactedTickets = [...new Set(conflicting.map(prTicket).filter((k): k is string => Boolean(k) && k !== ticketKey))];

      // 1. PR comment referencing the conflicting PR(s) and ticket(s).
      const mention = (login: string) => (conn.provider === 'github' && login ? `@${login}` : login);
      const commentBody = [
        `## ⚠ Merge conflict — flagged for developer review`,
        '',
        `This PR (ticket **${ticketKey}**) conflicts with \`${ourPr.baseBranch}\` and was **not** auto-resolved by the delivery agent.`,
        '',
        `**Why:** ${reason}`,
        ...(conflicting.length > 0
          ? [
              '',
              '**Potentially impacted work:**',
              ...conflicting.map(
                (p) =>
                  `- ${p.url ? `[#${p.number}](${p.url})` : `#${p.number}`} — ${p.title}${prTicket(p) ? ` (ticket ${prTicket(p)})` : ''}${p.author ? `, by ${mention(p.author)}` : ''} [${p.state}]`,
              ),
            ]
          : []),
        '',
        `Please resolve the conflict manually (or coordinate with the owners above) — the agent has left the branch untouched.`,
        '',
        `<sub>Posted automatically by delivery agent \`${agent}\` via the Delivery Console.</sub>`,
      ].join('\n');
      await ops.comment(live, number, commentBody);

      // 2. Label + reviewer assignment (best-effort; comment mentions are the fallback).
      const labels = await ops.addLabels(live, number, ['merge-conflict']).catch(() => [] as string[]);
      const owners = [...new Set(conflicting.map((p) => p.author).filter(Boolean))];
      const reviewers = await ops.requestReviewers(live, number, owners).catch(() => [] as string[]);

      // 3. Board flag on the agent task (same treatment as /api/agent/work/:id/flag).
      const flagText = `Merge conflict on PR #${number} needs developer review — ${reason}${
        impactedTickets.length > 0 ? ` (impacts ${impactedTickets.join(', ')})` : ''
      }`;
      await q(`UPDATE app.agent_tasks SET flag = $2, last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`, [
        task.id,
        flagText.slice(0, 2000),
      ]);
      await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
        ticketKey,
        agent,
        `⚠ Flagged: ${flagText}\n${ourPr.url}`,
      ]);
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
        [String(task.engagement_id), `⚠ ${agent} flagged ${ticketKey} — ${flagText.slice(0, 140)}`, conn.repo_name],
      );

      // 4. Tell the impacted tickets' threads what is bearing down on them.
      for (const impacted of impactedTickets) {
        const exists = (await q('SELECT 1 FROM app.tickets WHERE key = $1', [impacted])).rows[0];
        if (!exists) continue;
        const via = conflicting.filter((p) => prTicket(p) === impacted).map((p) => `#${p.number}`);
        await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
          impacted,
          agent,
          `⚠ Heads up: PR #${number} for ${ticketKey} has merge conflicts overlapping this ticket's PR${via.length > 1 ? 's' : ''} ${via.join(', ')} — flagged for developer review.\n${ourPr.url}`,
        ]);
      }

      res.json({
        ok: true,
        commented: true,
        labels,
        reviewersRequested: reviewers,
        flagged: true,
        impactedTickets,
        prUrl: ourPr.url,
      });
    } catch (err) {
      console.warn('pr conflict escalation failed:', (err as Error).message);
      res.status(502).json({ error: `Escalation failed — ${(err as Error).message}` });
    }
  });

  app.post('/api/agent/work/:id/pr/:number/comment', async (req, res) => {
    const parsed = PrCommentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent and body are required' });
      return;
    }
    try {
      const task = await activeTask(req, res, parsed.data.agent);
      if (!task) return;
      const number = prNumber(req, res);
      if (number === null) return;
      const conn = await loadConnection(q, String(task.engagement_id));
      if (!conn) {
        res.status(404).json({ error: 'No repository connected to this engagement' });
        return;
      }
      const live = { ...conn, token: await connectionToken(conn) };
      await opsFor(conn).comment(live, number, parsed.data.body);
      res.json({ ok: true });
    } catch (err) {
      console.warn('pr comment failed:', (err as Error).message);
      res.status(502).json({ error: `PR comment failed — ${(err as Error).message}` });
    }
  });
}
