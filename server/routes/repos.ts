import { z } from 'zod';
import express from 'express';
import type { Identity } from './roles';
import { githubAppConfigured, installationToken, verifyWebhookSignature, WEBHOOK_SECRET } from './github-app';
import { setTicketStatus } from './ticket-events';
import { createNotification } from './notifications';
import { localDeployPending } from './deploys';

/**
 * Git repository integration: one repo per engagement, GitHub or Azure DevOps.
 * Synced commits and pull requests are linked to tickets by detecting ticket
 * keys (e.g. NAC-104) in branch names, PR titles and commit messages. Linked
 * PRs drive ticket automation: opening a PR moves the ticket to Review;
 * merging it (from the drawer's Merge button or externally) starts a deploy
 * watch — the ticket holds in Review while the CI pipeline for the merge
 * commit runs, and moves to Done only when the pipeline succeeds (or straight
 * to Done when no pipeline is configured). All transitions log to the feed.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const REPO_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.repo_connections (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL UNIQUE REFERENCES app.engagements(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'connected',
    last_error TEXT,
    last_sync_at TIMESTAMPTZ,
    created_by TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT 'pat',
    installation_id BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS app.repo_prs (
    id SERIAL PRIMARY KEY,
    connection_id INT NOT NULL REFERENCES app.repo_connections(id) ON DELETE CASCADE,
    number INT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    ticket_key TEXT,
    updated_at TIMESTAMPTZ,
    UNIQUE (connection_id, number)
  )`,
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS merge_sha TEXT`,
  // When the provider says the PR was opened — the start of the review SLA
  // clock (DAT-201). Never overwritten once recorded.
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ`,
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_state TEXT`,
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_url TEXT`,
  `ALTER TABLE app.repo_prs ADD COLUMN IF NOT EXISTS deploy_started_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS app.repo_commits (
    sha TEXT NOT NULL,
    connection_id INT NOT NULL REFERENCES app.repo_connections(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    committed_at TIMESTAMPTZ,
    url TEXT NOT NULL DEFAULT '',
    ticket_key TEXT,
    PRIMARY KEY (connection_id, sha)
  )`,
];

export interface Connection {
  id: number;
  engagement_id: string;
  provider: 'github' | 'ado';
  repo_url: string;
  repo_name: string;
  default_branch: string;
  token: string;
  auth_type: 'pat' | 'app';
  installation_id: number | null;
}

// Spreads the raw row so extra columns (status, last_sync_at, …) survive for
// publicConnection while the fields the providers rely on are properly typed.
function toConnection(row: Record<string, unknown>): Connection {
  return {
    ...row,
    id: Number(row.id),
    engagement_id: String(row.engagement_id),
    provider: row.provider === 'ado' ? 'ado' : 'github',
    repo_url: String(row.repo_url),
    repo_name: String(row.repo_name),
    default_branch: String(row.default_branch),
    token: String(row.token),
    auth_type: row.auth_type === 'app' ? 'app' : 'pat',
    installation_id: row.installation_id == null ? null : Number(row.installation_id),
  };
}

/** Resolve a usable API token: stored PAT, or a fresh installation token. */
export async function connectionToken(conn: Connection): Promise<string> {
  if (conn.auth_type === 'app' && conn.installation_id != null) {
    return (await installationToken(conn.installation_id)).token;
  }
  return conn.token;
}

/** Copy of the connection with `token` resolved for immediate API use. */
async function withLiveToken(conn: Connection): Promise<Connection> {
  return { ...conn, token: await connectionToken(conn) };
}

interface RepoInfo {
  name: string;
  defaultBranch: string;
}

interface CommitItem {
  sha: string;
  message: string;
  author: string;
  date: string | null;
  url: string;
}

interface PrItem {
  number: number;
  title: string;
  author: string;
  state: 'open' | 'merged' | 'closed';
  branch: string;
  url: string;
  updatedAt: string | null;
  mergeSha: string | null;
  /** When the PR was opened — starts the review SLA clock (DAT-201). */
  createdAt: string | null;
}

/** Aggregate CI status for one commit: 'none' = no pipeline triggered (yet). */
interface PipelineStatus {
  state: 'none' | 'running' | 'success' | 'failed';
  url: string | null;
}

interface Provider {
  detect(url: string): boolean;
  validate(url: string, token: string): Promise<RepoInfo>;
  commits(conn: Connection, sinceIso: string | null): Promise<CommitItem[]>;
  prs(conn: Connection): Promise<PrItem[]>;
  merge(conn: Connection, number: number): Promise<{ sha: string | null }>;
  pipeline(conn: Connection, sha: string): Promise<PipelineStatus>;
}

/** Provider API error that keeps the HTTP status so callers can tell auth/permission failures from transient ones. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function jsonFetch(
  url: string,
  headers: Record<string, string>,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const resp = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { message?: string } | null;
    // Provider messages ("Pull Request is not mergeable", …) beat generic text.
    const msg = body?.message && body.message !== 'Not Found' ? body.message : null;
    const detail =
      resp.status === 401 || resp.status === 403
        ? (msg ?? 'token rejected — check the token and its scopes')
        : resp.status === 404
          ? (msg ?? 'repository not found — check the URL (and that the token can see it)')
          : (msg ?? `provider returned ${resp.status}`);
    throw new ProviderHttpError(detail, resp.status);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

// ---------- GitHub ----------

const GITHUB_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git|\/)?$/;

export function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'delivery-console',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function githubPath(conn: Connection): string {
  const m = GITHUB_URL.exec(conn.repo_url);
  if (!m) throw new Error('invalid GitHub URL');
  return `${m[1]}/${m[2]}`;
}

const github: Provider = {
  detect: (url) => GITHUB_URL.test(url),
  async validate(url, token) {
    const m = GITHUB_URL.exec(url);
    if (!m) throw new Error('GitHub URLs look like https://github.com/owner/repo');
    const repo = (await jsonFetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, githubHeaders(token))) as {
      full_name: string;
      default_branch: string;
    };
    return { name: repo.full_name, defaultBranch: repo.default_branch || 'main' };
  },
  async commits(conn, sinceIso) {
    const since = sinceIso ? `&since=${encodeURIComponent(sinceIso)}` : '';
    const list = (await jsonFetch(
      `https://api.github.com/repos/${githubPath(conn)}/commits?sha=${encodeURIComponent(conn.default_branch)}&per_page=50${since}`,
      githubHeaders(conn.token)
    )) as { sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } } }[];
    return list.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? '',
      date: c.commit.author?.date ?? null,
      url: c.html_url,
    }));
  },
  async prs(conn) {
    const list = (await jsonFetch(
      `https://api.github.com/repos/${githubPath(conn)}/pulls?state=all&sort=updated&direction=desc&per_page=50`,
      githubHeaders(conn.token)
    )) as {
      number: number;
      title: string;
      state: string;
      merged_at: string | null;
      merge_commit_sha: string | null;
      created_at: string;
      updated_at: string;
      html_url: string;
      user?: { login?: string };
      head?: { ref?: string };
    }[];
    return list.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user?.login ?? '',
      state: p.merged_at ? ('merged' as const) : p.state === 'open' ? ('open' as const) : ('closed' as const),
      branch: p.head?.ref ?? '',
      url: p.html_url,
      updatedAt: p.updated_at ?? null,
      createdAt: p.created_at ?? null,
      // For unmerged PRs merge_commit_sha is a test-merge ref — only trust it once merged.
      mergeSha: p.merged_at ? (p.merge_commit_sha ?? null) : null,
    }));
  },
  async merge(conn, number) {
    const url = `https://api.github.com/repos/${githubPath(conn)}/pulls/${number}/merge`;
    const attempt = (method?: string) =>
      jsonFetch(url, githubHeaders(conn.token), {
        method: 'PUT',
        body: method ? { merge_method: method } : {},
      }) as Promise<{
        sha?: string;
        merged?: boolean;
      }>;
    let result: { sha?: string; merged?: boolean };
    try {
      result = await attempt();
    } catch (err) {
      // Repo may forbid plain merge commits (squash-only settings).
      if (/not allowed/i.test((err as Error).message)) result = await attempt('squash');
      else throw err;
    }
    if (!result?.merged) throw new Error('GitHub did not confirm the merge');
    return { sha: result.sha ?? null };
  },
  async pipeline(conn, sha) {
    const data = (await jsonFetch(
      `https://api.github.com/repos/${githubPath(conn)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`,
      githubHeaders(conn.token)
    )) as { workflow_runs?: { status: string; conclusion: string | null; html_url?: string }[] };
    const runs = data.workflow_runs ?? [];
    if (runs.length === 0) return { state: 'none', url: null };
    const url = runs[0].html_url ?? null;
    if (runs.some((r) => r.status !== 'completed')) return { state: 'running', url };
    const bad = runs.find((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion ?? ''));
    return bad ? { state: 'failed', url: bad.html_url ?? url } : { state: 'success', url };
  },
};

// ---------- Azure DevOps ----------

const ADO_URL = /^https:\/\/dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s]+?)\/?$/;

export function adoHeaders(token: string) {
  return {
    Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
    Accept: 'application/json',
  };
}

function adoParts(url: string): { org: string; project: string; repo: string } {
  const m = ADO_URL.exec(url);
  if (!m) throw new Error('Azure DevOps URLs look like https://dev.azure.com/org/project/_git/repo');
  return { org: m[1], project: m[2], repo: m[3] };
}

export function adoApi(url: string): string {
  const { org, project, repo } = adoParts(url);
  return `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
}

function adoProjectApi(url: string): string {
  const { org, project } = adoParts(url);
  return `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis`;
}

const ado: Provider = {
  detect: (url) => ADO_URL.test(url),
  async validate(url, token) {
    const { project, repo } = adoParts(url);
    const info = (await jsonFetch(`${adoApi(url)}?api-version=7.1`, adoHeaders(token))) as {
      name?: string;
      defaultBranch?: string;
    };
    return {
      name: `${project}/${info.name ?? repo}`,
      defaultBranch: (info.defaultBranch ?? 'refs/heads/main').replace(/^refs\/heads\//, ''),
    };
  },
  async commits(conn, sinceIso) {
    const since = sinceIso ? `&searchCriteria.fromDate=${encodeURIComponent(sinceIso)}` : '';
    const data = (await jsonFetch(
      `${adoApi(conn.repo_url)}/commits?searchCriteria.itemVersion.version=${encodeURIComponent(conn.default_branch)}&searchCriteria.$top=50${since}&api-version=7.1`,
      adoHeaders(conn.token)
    )) as {
      value?: { commitId: string; comment: string; author?: { name?: string; date?: string }; remoteUrl?: string }[];
    };
    return (data.value ?? []).map((c) => ({
      sha: c.commitId,
      message: c.comment,
      author: c.author?.name ?? '',
      date: c.author?.date ?? null,
      url: c.remoteUrl ?? `${conn.repo_url}/commit/${c.commitId}`,
    }));
  },
  async prs(conn) {
    const data = (await jsonFetch(
      `${adoApi(conn.repo_url)}/pullrequests?searchCriteria.status=all&$top=50&api-version=7.1`,
      adoHeaders(conn.token)
    )) as {
      value?: {
        pullRequestId: number;
        title: string;
        status: string;
        sourceRefName?: string;
        createdBy?: { displayName?: string };
        closedDate?: string;
        creationDate?: string;
        lastMergeCommit?: { commitId?: string };
      }[];
    };
    return (data.value ?? []).map((p) => ({
      number: p.pullRequestId,
      title: p.title,
      author: p.createdBy?.displayName ?? '',
      state:
        p.status === 'active'
          ? ('open' as const)
          : p.status === 'completed'
            ? ('merged' as const)
            : ('closed' as const),
      branch: (p.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      url: `${conn.repo_url}/pullrequest/${p.pullRequestId}`,
      updatedAt: p.closedDate ?? p.creationDate ?? null,
      createdAt: p.creationDate ?? null,
      mergeSha: p.status === 'completed' ? (p.lastMergeCommit?.commitId ?? null) : null,
    }));
  },
  async merge(conn, number) {
    const base = adoApi(conn.repo_url);
    const pr = (await jsonFetch(`${base}/pullrequests/${number}?api-version=7.1`, adoHeaders(conn.token))) as {
      lastMergeSourceCommit?: { commitId?: string };
    };
    if (!pr.lastMergeSourceCommit?.commitId) throw new Error('could not resolve the PR head commit');
    const done = (await jsonFetch(`${base}/pullrequests/${number}?api-version=7.1`, adoHeaders(conn.token), {
      method: 'PATCH',
      body: {
        status: 'completed',
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
        completionOptions: { deleteSourceBranch: false },
      },
    })) as { status?: string; mergeStatus?: string; lastMergeCommit?: { commitId?: string } };
    // ADO completes merges asynchronously; 'completed' or a queued merge both count.
    if (done.status !== 'completed' && done.mergeStatus !== 'queued') {
      throw new Error(`Azure DevOps did not complete the merge (status: ${done.status ?? 'unknown'})`);
    }
    return { sha: done.lastMergeCommit?.commitId ?? null };
  },
  async pipeline(conn, sha) {
    const data = (await jsonFetch(
      `${adoProjectApi(conn.repo_url)}/build/builds?$top=50&queryOrder=queueTimeDescending&api-version=7.1`,
      adoHeaders(conn.token)
    )) as {
      value?: { sourceVersion?: string; status?: string; result?: string; _links?: { web?: { href?: string } } }[];
    };
    const builds = (data.value ?? []).filter((b) => b.sourceVersion === sha);
    if (builds.length === 0) return { state: 'none', url: null };
    const url = builds[0]._links?.web?.href ?? null;
    if (builds.some((b) => b.status !== 'completed')) return { state: 'running', url };
    const bad = builds.find((b) => b.result !== 'succeeded' && b.result !== 'partiallySucceeded');
    return bad ? { state: 'failed', url: bad._links?.web?.href ?? url } : { state: 'success', url };
  },
};

function providerFor(url: string): { key: 'github' | 'ado'; impl: Provider } | null {
  if (github.detect(url)) return { key: 'github', impl: github };
  if (ado.detect(url)) return { key: 'ado', impl: ado };
  return null;
}

// ---------- ticket linking & automation ----------

const TICKET_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,5}\b/;

export function findTicketKey(...texts: string[]): string | null {
  for (const t of texts) {
    const m = TICKET_KEY.exec(t);
    if (m) return m[0];
  }
  return null;
}

/**
 * Pull requests referenced by URL in free text. Completion comments commonly
 * contain only the PR URL, so this gives a later repository sync a durable
 * fallback when the PR was not linkable when it was first observed.
 */
export function extractPullRequestNumbers(text: string, conn: Pick<Connection, 'provider' | 'repo_url'>): number[] {
  const out = new Set<number>();
  const expected = new URL(conn.repo_url);
  const expectedPath = expected.pathname.replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase();
  for (const match of text.matchAll(/https?:\/\/[^\s<>()\]]+/gi)) {
    const candidate = match[0].replace(/[.,;:!?`'"}]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.host.toLowerCase() !== expected.host.toLowerCase()) continue;
      const path = url.pathname.replace(/\/$/, '');
      const suffix = conn.provider === 'github' ? '/pull/' : '/pullrequest/';
      if (!path.toLowerCase().startsWith(`${expectedPath}${suffix}`)) continue;
      const number = Number(path.slice(expectedPath.length + suffix.length).split('/')[0]);
      if (Number.isSafeInteger(number) && number > 0) out.add(number);
    } catch {
      // Ignore malformed prose URLs; repository sync must remain best-effort.
    }
  }
  return [...out];
}

export function matchPullRequestTicket(
  pr: Pick<PrItem, 'number' | 'branch' | 'title'>,
  knownTickets: ReadonlySet<string>,
  commentPrTickets: ReadonlyMap<number, ReadonlySet<string>>,
): string | null {
  const direct = findTicketKey(pr.branch, pr.title);
  if (direct && knownTickets.has(direct)) return direct;
  const mentionedBy = commentPrTickets.get(pr.number);
  if (mentionedBy?.size !== 1) return null;
  const [commentTicket] = mentionedBy;
  return knownTickets.has(commentTicket) ? commentTicket : null;
}

function maskToken(token: string): string {
  return token.length <= 8 ? '····' : `${token.slice(0, 4)}····${token.slice(-4)}`;
}

export function publicConnection(row: Record<string, unknown> | Connection) {
  const { token, ...rest } = row as { token: string } & Record<string, unknown>;
  return { ...rest, token_hint: rest.auth_type === 'app' ? 'GitHub App' : maskToken(token) };
}

/**
 * Called when a linked PR is first seen open. pr-review.ts registers here so a
 * PR opening can kick off the review gate; the hook is one-directional on
 * purpose (repos.ts must not import the reviewer) and is a no-op until
 * something registers, which keeps sync working in tests and in consoles with
 * no reviewer agent.
 */
type PrOpenedHook = (engagementId: string, ticketKey: string, prNumber: number) => void;
let prOpenedHook: PrOpenedHook | null = null;

export function onPrOpened(hook: PrOpenedHook | null): void {
  prOpenedHook = hook;
}

export async function syncConnection(q: Query, rawConn: Connection): Promise<{ commits: number; prs: number }> {
  const conn = await withLiveToken(rawConn);
  const impl = conn.provider === 'github' ? github : ado;

  // Only tickets of this engagement are linkable.
  const ticketRows = (
    await q('SELECT key, status, assignee, title FROM app.tickets WHERE engagement_id = $1', [conn.engagement_id])
  ).rows;
  const ticketStatus = new Map(ticketRows.map((r) => [String(r.key), String(r.status)]));
  const knownTickets = new Set(ticketStatus.keys());

  // A completion comment can be written before the provider has exposed the
  // PR (or while a webhook/sync is failing). Re-read those durable references
  // on every sync so the association is eventually backfilled.
  const commentRows = (
    await q(
      `SELECT c.ticket_key, c.body FROM app.ticket_comments c
       JOIN app.tickets t ON t.key = c.ticket_key WHERE t.engagement_id = $1`,
      [conn.engagement_id],
    )
  ).rows;
  const commentPrTickets = new Map<number, Set<string>>();
  for (const row of commentRows) {
    const ticketKey = String(row.ticket_key);
    const body = typeof row.body === 'string' ? row.body : '';
    for (const number of extractPullRequestNumbers(body, conn)) {
      const keys = commentPrTickets.get(number) ?? new Set<string>();
      keys.add(ticketKey);
      commentPrTickets.set(number, keys);
    }
  }
  const ticketsByKey = new Map(ticketRows.map((r) => [String(r.key), r]));

  const lastSync = (await q('SELECT last_sync_at FROM app.repo_connections WHERE id = $1', [conn.id])).rows[0];
  const rawSince = lastSync?.last_sync_at;
  const sinceIso =
    rawSince instanceof Date
      ? rawSince.toISOString()
      : typeof rawSince === 'string' && rawSince
        ? new Date(rawSince).toISOString()
        : null;

  const [commits, prs] = await Promise.all([impl.commits(conn, sinceIso), impl.prs(conn)]);

  let newCommits = 0;
  for (const c of commits) {
    const key = findTicketKey(c.message);
    const ticketKey = key && ticketStatus.has(key) ? key : null;
    const inserted = await q(
      `INSERT INTO app.repo_commits (sha, connection_id, message, author, committed_at, url, ticket_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (connection_id, sha) DO NOTHING RETURNING sha`,
      [c.sha, conn.id, c.message.slice(0, 4000), c.author, c.date, c.url, ticketKey]
    );
    if (inserted.rows.length > 0) newCommits++;
  }

  let changedPrs = 0;
  for (const p of prs) {
    const ticketKey = matchPullRequestTicket(p, knownTickets, commentPrTickets);
    const prev = (
      await q('SELECT state FROM app.repo_prs WHERE connection_id = $1 AND number = $2', [conn.id, p.number])
    ).rows[0];
    await q(
      `INSERT INTO app.repo_prs (connection_id, number, title, author, state, branch, url, ticket_key, updated_at, merge_sha, opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (connection_id, number)
       DO UPDATE SET title = $3, author = $4, state = $5, branch = $6, url = $7, ticket_key = $8, updated_at = $9,
                     merge_sha = COALESCE(EXCLUDED.merge_sha, app.repo_prs.merge_sha),
                     opened_at = COALESCE(app.repo_prs.opened_at, EXCLUDED.opened_at)`,
      [
        conn.id,
        p.number,
        p.title.slice(0, 500),
        p.author,
        p.state,
        p.branch,
        p.url,
        ticketKey,
        p.updatedAt,
        p.mergeSha,
        p.createdAt,
      ]
    );
    const prevState = prev ? String(prev.state) : null;
    if (prevState === p.state) continue;
    changedPrs++;

    // Automation: linked PR opened → ticket to Review; linked PR merged →
    // deploy watch (Done comes once the pipeline succeeds, see checkDeployments).
    if (!ticketKey) continue;
    const status = ticketStatus.get(ticketKey);
    if (p.state === 'open' && (status === 'backlog' || status === 'progress')) {
      await setTicketStatus(q, ticketKey, 'review');
      ticketStatus.set(ticketKey, 'review');
      const ticket = ticketsByKey.get(ticketKey);
      if (ticket)
        await createNotification(q, {
          recipient: String(ticket.assignee),
          type: 'repo_status',
          title: `${ticketKey} moved to Review`,
          message: `PR #${p.number} opened — ${String(ticket.title)}`,
          ticketKey,
          engagementId: conn.engagement_id,
        });
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
        [conn.engagement_id, `PR #${p.number} opened for ${ticketKey} — moved to Review.`, conn.repo_name]
      );
      // Review gate: fire-and-forget so a slow or unhappy reviewer never
      // stalls (or fails) the sync pass that moved the ticket.
      prOpenedHook?.(conn.engagement_id, ticketKey, p.number);
    } else if (p.state === 'merged' && status && status !== 'done' && status !== 'dismissed') {
      if (prev) {
        // Live merge transition: the ticket parks in Deploying while the
        // pipeline runs (DAT-222) — the merge is the sign-off, whether or not
        // a reviewer pressed Approve first, and Done still waits for green.
        await q(
          `UPDATE app.repo_prs SET deploy_state = 'pending', deploy_started_at = NOW()
           WHERE connection_id = $1 AND number = $2 AND deploy_state IS NULL`,
          [conn.id, p.number]
        );
        if (status !== 'deploying') {
          await setTicketStatus(q, ticketKey, 'deploying');
          ticketStatus.set(ticketKey, 'deploying');
          const ticket = ticketsByKey.get(ticketKey);
          if (ticket)
            await createNotification(q, {
              recipient: String(ticket.assignee),
              type: 'repo_status',
              title: `${ticketKey} moved to Deploying`,
              message: `PR #${p.number} merged and the pipeline is running`,
              ticketKey,
              engagementId: conn.engagement_id,
            });
        }
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
           VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
          [conn.engagement_id, `PR #${p.number} merged — ${ticketKey} moved to Deploying while the pipeline runs.`, conn.repo_name],
        );
      } else {
        // First sight of an already-merged PR (initial sync of a connection):
        // history, not a live event — keep the old straight-to-Done behavior.
        await setTicketStatus(q, ticketKey, 'done');
        ticketStatus.set(ticketKey, 'done');
        const ticket = ticketsByKey.get(ticketKey);
        if (ticket)
          await createNotification(q, {
            recipient: String(ticket.assignee),
            type: 'repo_status',
            title: `${ticketKey} moved to Done`,
            message: `PR #${p.number} was merged`,
            ticketKey,
            engagementId: conn.engagement_id,
          });
        await q(
          `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
           VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
          [conn.engagement_id, `PR #${p.number} merged — ${ticketKey} moved to Done.`, conn.repo_name]
        );
      }
    }
  }

  await q(
    `UPDATE app.repo_connections SET status = 'connected', last_error = NULL, last_sync_at = NOW() WHERE id = $1`,
    [conn.id]
  );
  await checkDeployments(q, conn);
  return { commits: newCommits, prs: changedPrs };
}

// ---------- deployment pipeline tracking ----------

/** If no CI run appears for the merge commit within this window, assume the repo has no pipeline. */
const NO_PIPELINE_GRACE_MS = 5 * 60_000;

/**
 * Advance tracked deployments: for every merged PR with an in-flight deploy
 * watch, poll the provider's CI status for the merge commit and settle the
 * linked ticket — Done on success (or when no pipeline exists), stays in
 * Review with a feed warning on failure.
 */
export async function checkDeployments(q: Query, rawConn: Connection): Promise<void> {
  // 'failed' deploys stay watched while their ticket is still open, so a
  // re-run pipeline that passes still completes the ticket.
  const pending = (
    await q(
      `SELECT pr.number, pr.ticket_key, pr.merge_sha, pr.deploy_started_at, pr.deploy_state FROM app.repo_prs pr
       JOIN app.tickets t ON t.key = pr.ticket_key
       WHERE pr.connection_id = $1 AND pr.deploy_state IN ('pending','running','failed')
         AND t.status NOT IN ('done','dismissed')`,
      [rawConn.id]
    )
  ).rows;
  if (pending.length === 0) return;
  const conn = await withLiveToken(rawConn); // no-op for PATs; app tokens are cached
  const impl = conn.provider === 'github' ? github : ado;
  for (const row of pending) {
    const number = Number(row.number);
    const ticketKey = typeof row.ticket_key === 'string' && row.ticket_key ? row.ticket_key : null;
    const sha = typeof row.merge_sha === 'string' && row.merge_sha ? row.merge_sha : null;
    const prevDeploy = typeof row.deploy_state === 'string' ? row.deploy_state : '';
    if (!sha) continue; // the next sync pass backfills the merge commit
    const rawStarted = row.deploy_started_at;
    const started =
      rawStarted instanceof Date
        ? rawStarted.getTime()
        : typeof rawStarted === 'string' && rawStarted
          ? new Date(rawStarted).getTime()
          : 0;
    const graceOver = Date.now() - started > NO_PIPELINE_GRACE_MS;
    try {
      const p = await impl.pipeline(conn, sha);
      if (p.state === 'running') {
        await q(
          `UPDATE app.repo_prs SET deploy_state = 'running', deploy_url = COALESCE($3, deploy_url)
           WHERE connection_id = $1 AND number = $2`,
          [conn.id, number, p.url]
        );
      } else if (p.state === 'success' || p.state === 'failed') {
        await q(
          `UPDATE app.repo_prs SET deploy_state = $3, deploy_url = COALESCE($4, deploy_url)
           WHERE connection_id = $1 AND number = $2`,
          [conn.id, number, p.state, p.url]
        );
        // Feed the failure once, not on every re-check of a still-failed run.
        if (p.state !== prevDeploy) await settleDeploy(q, conn, number, ticketKey, p.state);
      } else {
        // No CI run for the merge commit. When a local deploy (DAT-236) is in
        // flight for the ticket, that absence is expected — the deploy runs on
        // the dev's machine and its client-reported events settle the ticket,
        // so the grace path must not declare "no pipeline" and jump to Done.
        if (graceOver && !(await localDeployPending(q, ticketKey))) {
          await q(`UPDATE app.repo_prs SET deploy_state = 'none' WHERE connection_id = $1 AND number = $2`, [
            conn.id,
            number,
          ]);
          await settleDeploy(q, conn, number, ticketKey, 'none');
        }
      }
    } catch (err) {
      console.warn(`[repos] deploy check failed for PR #${number} (${conn.repo_name}):`, (err as Error).message);
      // A permission error is not transient: the token simply can't read CI
      // status (e.g. a GitHub App without Actions: Read, or an ADO PAT without
      // Build: Read). Left alone the watch would spin forever with the board
      // stuck on DEPLOYING — settle the ticket instead and say why in the feed.
      const status = err instanceof ProviderHttpError ? err.status : null;
      if ((status === 401 || status === 403) && graceOver && !(await localDeployPending(q, ticketKey))) {
        await q(`UPDATE app.repo_prs SET deploy_state = 'none' WHERE connection_id = $1 AND number = $2`, [
          conn.id,
          number,
        ]);
        await settleDeploy(q, conn, number, ticketKey, 'unreadable');
      }
    }
  }
}

async function settleDeploy(
  q: Query,
  conn: Connection,
  prNumber: number,
  ticketKey: string | null,
  outcome: 'success' | 'failed' | 'none' | 'unreadable'
): Promise<void> {
  if (!ticketKey) return;
  const ticket = (await q('SELECT status, assignee, title FROM app.tickets WHERE key = $1', [ticketKey])).rows[0];
  if (!ticket) return;
  const status = String(ticket.status);
  if (status === 'done' || status === 'dismissed') return;
  if (outcome === 'failed') {
    await q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
       VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
      [conn.engagement_id, `⚠ Deploy pipeline failed for PR #${prNumber} — ${ticketKey} stays in Deploying until a passing run.`, conn.repo_name],
    );
    return;
  }
  await setTicketStatus(q, ticketKey, 'done');
  const text =
    outcome === 'success'
      ? `Deploy pipeline succeeded for PR #${prNumber} — ${ticketKey} moved to Done.`
      : outcome === 'unreadable'
        ? `⚠ Pipeline status for PR #${prNumber} is not readable with the connected credentials — ${ticketKey} moved to Done without deploy verification. Grant the GitHub App "Actions: Read" (or the ADO PAT "Build: Read") to enable deploy tracking.`
        : `PR #${prNumber} merged (no deploy pipeline detected) — ${ticketKey} moved to Done.`;
  await createNotification(q, {
    recipient: String(ticket.assignee),
    type: 'repo_status',
    title: `${ticketKey} moved to Done`,
    message: text,
    ticketKey,
    engagementId: conn.engagement_id,
  });
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
     VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
    [conn.engagement_id, text, conn.repo_name]
  );
}

export async function loadConnection(q: Query, engagementId: string): Promise<Connection | null> {
  const { rows } = await q('SELECT * FROM app.repo_connections WHERE engagement_id = $1', [engagementId]);
  return rows.length > 0 ? toConnection(rows[0]) : null;
}

/**
 * Webhook idempotency: GitHub retries deliveries and each retry carries the
 * same X-GitHub-Delivery GUID. Remember recently seen ids so a redelivery
 * acks immediately instead of racing a second sync (concurrent syncs read
 * prev-state before the other's write and can double-post feed items).
 */
const DELIVERY_TTL_MS = 15 * 60_000;
const seenDeliveries = new Map<string, number>();

export function rememberDelivery(id: string, now = Date.now()): boolean {
  for (const [k, at] of seenDeliveries) {
    if (now - at > DELIVERY_TTL_MS) seenDeliveries.delete(k);
  }
  if (seenDeliveries.has(id)) return false;
  seenDeliveries.set(id, now);
  return true;
}

const ConnectBody = z.object({
  url: z.string().url().max(500),
  token: z.string().min(8).max(500),
});

const AppConnectBody = z.object({
  installationId: z.number().int().positive(),
  fullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
});

export function setupRepoRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>
) {
  app.post('/api/engagements/:id/repo', async (req, res) => {
    // Two connect modes: GitHub App (installation pick, no stored secret) or
    // a pasted PAT (GitHub or Azure DevOps fallback).
    const viaApp = AppConnectBody.safeParse(req.body);
    const viaPat = ConnectBody.safeParse(req.body);
    if (!viaApp.success && !viaPat.success) {
      res.status(400).json({ error: 'A repository URL and an access token (or a GitHub App repo pick) are required' });
      return;
    }
    try {
      const engagementId = req.params.id;
      const lead = await requireLead(req, res, engagementId);
      if (!lead) return;
      if (await loadConnection(q, engagementId)) {
        res.status(409).json({ error: 'A repository is already connected — disconnect it first' });
        return;
      }

      let providerKey: 'github' | 'ado';
      let url: string;
      let info: RepoInfo;
      let stored: { token: string; authType: 'pat' | 'app'; installationId: number | null };
      if (viaApp.success) {
        if (!githubAppConfigured()) {
          res.status(409).json({ error: 'GitHub App is not configured on this deployment' });
          return;
        }
        providerKey = 'github';
        url = `https://github.com/${viaApp.data.fullName}`;
        const { token } = await installationToken(viaApp.data.installationId);
        info = await github.validate(url, token);
        stored = { token: '', authType: 'app', installationId: viaApp.data.installationId };
      } else if (viaPat.success) {
        url = viaPat.data.url.replace(/\/+$/, '');
        const provider = providerFor(url);
        if (!provider) {
          res.status(400).json({
            error:
              'Unsupported repository URL — use https://github.com/owner/repo or https://dev.azure.com/org/project/_git/repo',
          });
          return;
        }
        providerKey = provider.key;
        info = await provider.impl.validate(url, viaPat.data.token);
        stored = { token: viaPat.data.token, authType: 'pat', installationId: null };
      } else {
        return; // unreachable — guarded above
      }

      const inserted = await q(
        `INSERT INTO app.repo_connections (engagement_id, provider, repo_url, repo_name, default_branch, token, auth_type, installation_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          engagementId,
          providerKey,
          url,
          info.name,
          info.defaultBranch,
          stored.token,
          stored.authType,
          stored.installationId,
          lead.email,
        ]
      );
      const conn = toConnection(inserted.rows[0]);
      let sync = { commits: 0, prs: 0 };
      try {
        sync = await syncConnection(q, conn);
      } catch (err) {
        console.warn('[repos] initial sync failed:', (err as Error).message);
      }
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', $3, false)`,
        [
          engagementId,
          `Connected ${providerKey === 'github' ? 'GitHub' : 'Azure DevOps'} repository ${info.name}${stored.authType === 'app' ? ' via GitHub App' : ''}.`,
          info.name,
        ]
      );
      res.status(201).json({ connection: publicConnection(inserted.rows[0]), sync });
    } catch (err) {
      console.warn('repo connect failed:', (err as Error).message);
      res.status(502).json({ error: `Could not connect repository — ${(err as Error).message}` });
    }
  });

  app.delete('/api/engagements/:id/repo', async (req, res) => {
    try {
      const engagementId = req.params.id;
      if (!(await requireLead(req, res, engagementId))) return;
      const conn = await loadConnection(q, engagementId);
      if (!conn) {
        res.status(404).json({ error: 'No repository connected' });
        return;
      }
      await q('DELETE FROM app.repo_connections WHERE id = $1', [conn.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error('repo disconnect failed:', err);
      res.status(500).json({ error: 'Failed to disconnect repository' });
    }
  });

  app.get('/api/engagements/:id/repo', async (req, res) => {
    try {
      const conn = await loadConnection(q, req.params.id);
      if (!conn) {
        res.json({ connection: null });
        return;
      }
      const prs = (
        await q(
          'SELECT number, title, author, state, branch, url, ticket_key, deploy_state, deploy_url, updated_at FROM app.repo_prs WHERE connection_id = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 25',
          [conn.id]
        )
      ).rows;
      const commits = (
        await q(
          'SELECT sha, message, author, committed_at, url, ticket_key FROM app.repo_commits WHERE connection_id = $1 ORDER BY committed_at DESC NULLS LAST LIMIT 25',
          [conn.id]
        )
      ).rows;
      res.json({ connection: publicConnection(conn), prs, commits });
    } catch (err) {
      console.error('repo detail failed:', err);
      res.status(500).json({ error: 'Failed to load repository' });
    }
  });

  app.post('/api/engagements/:id/repo/sync', async (req, res) => {
    try {
      const conn = await loadConnection(q, req.params.id);
      if (!conn) {
        res.status(404).json({ error: 'No repository connected' });
        return;
      }
      const sync = await syncConnection(q, conn);
      res.json({ ok: true, ...sync });
    } catch (err) {
      const msg = (err as Error).message;
      console.warn('repo sync failed:', msg);
      await q(`UPDATE app.repo_connections SET status = 'error', last_error = $2 WHERE engagement_id = $1`, [
        req.params.id,
        msg.slice(0, 500),
      ]).catch(() => {});
      res.status(502).json({ error: `Sync failed — ${msg}` });
    }
  });

  // GitHub webhook receiver: push / pull_request events trigger an immediate
  // re-sync of the matching connection. NOTE: Databricks Apps sit behind the
  // workspace OAuth proxy, so direct GitHub deliveries are blocked today —
  // this endpoint is HMAC-gated and ready for unauthenticated ingress or a
  // relay; until then the poller (see startRepoPolling) keeps things fresh.
  app.post('/api/webhooks/github', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    try {
      if (!WEBHOOK_SECRET) {
        res.status(404).json({ error: 'Webhooks are not configured' });
        return;
      }
      // Prefer raw bytes for the HMAC; a parsed body (upstream json parser)
      // falls back to re-serialization, which round-trips GitHub's compact JSON.
      const raw: Buffer | string = Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body ?? {});
      if (!verifyWebhookSignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) {
        res.status(401).json({ error: 'Signature verification failed' });
        return;
      }
      const event = String(req.headers['x-github-event'] ?? '');
      const payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) as {
        repository?: { full_name?: string };
      };
      const fullName = payload.repository?.full_name;
      if (!fullName || !['push', 'pull_request'].includes(event)) {
        res.json({ ok: true, ignored: true });
        return;
      }
      const deliveryId = String(req.headers['x-github-delivery'] ?? '');
      if (deliveryId && !rememberDelivery(deliveryId)) {
        res.json({ ok: true, duplicate: true });
        return;
      }
      const { rows } = await q(`SELECT * FROM app.repo_connections WHERE provider = 'github' AND repo_name = $1`, [
        fullName,
      ]);
      for (const row of rows) {
        await syncConnection(q, toConnection(row)).catch((err) =>
          console.warn('[repos] webhook sync failed:', (err as Error).message)
        );
      }
      res.json({ ok: true, synced: rows.length });
    } catch (err) {
      console.warn('[repos] webhook failed:', (err as Error).message);
      res.status(400).json({ error: 'Bad webhook payload' });
    }
  });

  // Merge a linked PR straight from the ticket drawer (leads only). Kicks off
  // the deploy watch: the ticket holds in Review until the pipeline succeeds.
  app.post('/api/tickets/:key/prs/:number/merge', async (req, res) => {
    try {
      const key = req.params.key;
      const number = Number(req.params.number);
      if (!Number.isInteger(number) || number <= 0) {
        res.status(400).json({ error: 'Invalid PR number' });
        return;
      }
      const ticket = (await q('SELECT engagement_id, status FROM app.tickets WHERE key = $1', [key])).rows[0];
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const engagementId = String(ticket.engagement_id);
      const lead = await requireLead(req, res, engagementId);
      if (!lead) return;
      const conn = await loadConnection(q, engagementId);
      if (!conn) {
        res.status(404).json({ error: 'No repository connected' });
        return;
      }
      const prRow = (
        await q('SELECT state, ticket_key FROM app.repo_prs WHERE connection_id = $1 AND number = $2', [
          conn.id,
          number,
        ])
      ).rows[0];
      if (!prRow || String(prRow.ticket_key) !== key) {
        res.status(404).json({ error: 'That PR is not linked to this ticket' });
        return;
      }
      if (String(prRow.state) !== 'open') {
        res.status(409).json({ error: 'PR is not open' });
        return;
      }
      const live = await withLiveToken(conn);
      const impl = conn.provider === 'github' ? github : ado;
      const { sha } = await impl.merge(live, number);
      await q(
        `UPDATE app.repo_prs
         SET state = 'merged', merge_sha = COALESCE($3, merge_sha), deploy_state = 'pending', deploy_started_at = NOW(), updated_at = NOW()
         WHERE connection_id = $1 AND number = $2`,
        [conn.id, number, sha]
      );
      // Merging from the drawer is the sign-off: the ticket lands in Deploying
      // and stays there until the pipeline goes green (DAT-222).
      if (!['deploying', 'done', 'dismissed'].includes(String(ticket.status))) {
        await setTicketStatus(q, key, 'deploying');
        await createNotification(q, {
          recipient: String(ticket.assignee),
          type: 'repo_status',
          title: `${key} moved to Deploying`,
          message: `PR #${number} merged and the pipeline is running`,
          ticketKey: key,
          engagementId,
        });
      }
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'YOU', $2, 'JUST NOW', $3, false)`,
        [engagementId, `Merged PR #${number} for ${key} — Deploying until the pipeline succeeds.`, conn.repo_name],
      );
      // Immediate first check so fast pipelines register without waiting for the poller.
      await checkDeployments(q, conn).catch(() => {});
      const updated = (
        await q(
          'SELECT number, title, author, state, branch, url, ticket_key, deploy_state, deploy_url FROM app.repo_prs WHERE connection_id = $1 AND number = $2',
          [conn.id, number]
        )
      ).rows[0];
      res.json({ ok: true, pr: updated });
    } catch (err) {
      const msg = (err as Error).message;
      console.warn('PR merge failed:', msg);
      res.status(502).json({ error: `Merge failed — ${msg}` });
    }
  });

  // Drawer polls this while a deploy is in flight; throttle live provider checks.
  const lastDeployPoll = new Map<number, number>();
  app.get('/api/tickets/:key/dev', async (req, res) => {
    try {
      const inflight = (
        await q(
          `SELECT DISTINCT connection_id FROM app.repo_prs WHERE ticket_key = $1 AND deploy_state IN ('pending','running','failed')`,
          [req.params.key]
        )
      ).rows;
      for (const r of inflight) {
        const connId = Number(r.connection_id);
        if (Date.now() - (lastDeployPoll.get(connId) ?? 0) < 12_000) continue;
        lastDeployPoll.set(connId, Date.now());
        const row = (await q('SELECT * FROM app.repo_connections WHERE id = $1', [connId])).rows[0];
        if (row) await checkDeployments(q, toConnection(row)).catch(() => {});
      }
      const prs = (
        await q(
          'SELECT number, title, author, state, branch, url, ticket_key, deploy_state, deploy_url FROM app.repo_prs WHERE ticket_key = $1 ORDER BY updated_at DESC NULLS LAST',
          [req.params.key]
        )
      ).rows;
      const commits = (
        await q(
          'SELECT sha, message, author, committed_at, url FROM app.repo_commits WHERE ticket_key = $1 ORDER BY committed_at DESC NULLS LAST LIMIT 15',
          [req.params.key]
        )
      ).rows;
      res.json({ prs, commits });
    } catch (err) {
      console.error('ticket dev failed:', err);
      res.status(500).json({ error: 'Failed to load development activity' });
    }
  });
}

/**
 * Poll all connected repositories; failures are recorded per connection.
 *
 * Adaptive cadence: every connection syncs at least every `intervalMs`, but a
 * "hot" connection — one with an open PR linked to an active ticket, or a
 * deploy watch in flight — syncs every `hotIntervalMs` so an external merge
 * lands on the board well inside a minute without hammering the provider API
 * for idle repos.
 */
export function startRepoPolling(q: Query, intervalMs = 90_000, hotIntervalMs = 30_000): void {
  const lastSynced = new Map<number, number>();
  const tick = async () => {
    try {
      const { rows } = await q('SELECT * FROM app.repo_connections');
      const hot = new Set(
        (
          await q(
            `SELECT DISTINCT pr.connection_id FROM app.repo_prs pr
             JOIN app.tickets t ON t.key = pr.ticket_key
             WHERE t.status NOT IN ('done','dismissed')
               AND (pr.state = 'open' OR pr.deploy_state IN ('pending','running','failed'))`
          )
        ).rows.map((r) => Number(r.connection_id))
      );
      for (const row of rows) {
        const conn = toConnection(row);
        const due = Date.now() - (lastSynced.get(conn.id) ?? 0) >= (hot.has(conn.id) ? hotIntervalMs : intervalMs);
        if (!due) continue;
        lastSynced.set(conn.id, Date.now());
        try {
          await syncConnection(q, conn);
        } catch (err) {
          const msg = (err as Error).message;
          console.warn(`[repos] poll sync failed for ${conn.repo_name}:`, msg);
          await q(`UPDATE app.repo_connections SET status = 'error', last_error = $2 WHERE id = $1`, [
            conn.id,
            msg.slice(0, 500),
          ]).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[repos] poll failed:', (err as Error).message);
    }
  };
  setInterval(() => void tick(), hotIntervalMs).unref?.();
}
