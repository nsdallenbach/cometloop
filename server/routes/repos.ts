import { z } from 'zod';
import type express from 'express';
import type { Identity } from './roles';

/**
 * Git repository integration: one repo per engagement, GitHub or Azure DevOps.
 * Synced commits and pull requests are linked to tickets by detecting ticket
 * keys (e.g. NAC-104) in branch names, PR titles and commit messages. Linked
 * PRs drive ticket automation: opening a PR moves the ticket to Review,
 * merging it moves the ticket to Done (both logged to the feed).
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
    created_by TEXT NOT NULL DEFAULT ''
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

interface Connection {
  id: number;
  engagement_id: string;
  provider: 'github' | 'ado';
  repo_url: string;
  repo_name: string;
  default_branch: string;
  token: string;
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
  };
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
}

interface Provider {
  detect(url: string): boolean;
  validate(url: string, token: string): Promise<RepoInfo>;
  commits(conn: Connection, sinceIso: string | null): Promise<CommitItem[]>;
  prs(conn: Connection): Promise<PrItem[]>;
}

async function jsonFetch(url: string, headers: Record<string, string>): Promise<unknown> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) {
    const detail =
      resp.status === 401 || resp.status === 403
        ? 'token rejected — check the token and its scopes'
        : resp.status === 404
          ? 'repository not found — check the URL (and that the token can see it)'
          : `provider returned ${resp.status}`;
    throw new Error(detail);
  }
  return resp.json();
}

// ---------- GitHub ----------

const GITHUB_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git|\/)?$/;

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'delivery-console',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function githubPath(conn: Connection): string {
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
      githubHeaders(conn.token),
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
      githubHeaders(conn.token),
    )) as {
      number: number;
      title: string;
      state: string;
      merged_at: string | null;
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
    }));
  },
};

// ---------- Azure DevOps ----------

const ADO_URL = /^https:\/\/dev\.azure\.com\/([^/\s]+)\/([^/\s]+)\/_git\/([^/\s]+?)\/?$/;

function adoHeaders(token: string) {
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

function adoApi(url: string): string {
  const { org, project, repo } = adoParts(url);
  return `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
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
      adoHeaders(conn.token),
    )) as { value?: { commitId: string; comment: string; author?: { name?: string; date?: string }; remoteUrl?: string }[] };
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
      adoHeaders(conn.token),
    )) as {
      value?: {
        pullRequestId: number;
        title: string;
        status: string;
        sourceRefName?: string;
        createdBy?: { displayName?: string };
        closedDate?: string;
        creationDate?: string;
      }[];
    };
    return (data.value ?? []).map((p) => ({
      number: p.pullRequestId,
      title: p.title,
      author: p.createdBy?.displayName ?? '',
      state: p.status === 'active' ? ('open' as const) : p.status === 'completed' ? ('merged' as const) : ('closed' as const),
      branch: (p.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      url: `${conn.repo_url}/pullrequest/${p.pullRequestId}`,
      updatedAt: p.closedDate ?? p.creationDate ?? null,
    }));
  },
};

function providerFor(url: string): { key: 'github' | 'ado'; impl: Provider } | null {
  if (github.detect(url)) return { key: 'github', impl: github };
  if (ado.detect(url)) return { key: 'ado', impl: ado };
  return null;
}

// ---------- ticket linking & automation ----------

const TICKET_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,5}\b/;

function findTicketKey(...texts: string[]): string | null {
  for (const t of texts) {
    const m = TICKET_KEY.exec(t);
    if (m) return m[0];
  }
  return null;
}

function maskToken(token: string): string {
  return token.length <= 8 ? '····' : `${token.slice(0, 4)}····${token.slice(-4)}`;
}

export function publicConnection(row: Record<string, unknown> | Connection) {
  const { token, ...rest } = row as { token: string } & Record<string, unknown>;
  return { ...rest, token_hint: maskToken(token) };
}

async function syncConnection(q: Query, conn: Connection): Promise<{ commits: number; prs: number }> {
  const impl = conn.provider === 'github' ? github : ado;

  // Only tickets of this engagement are linkable.
  const ticketRows = (await q('SELECT key, status FROM app.tickets WHERE engagement_id = $1', [conn.engagement_id])).rows;
  const ticketStatus = new Map(ticketRows.map((r) => [String(r.key), String(r.status)]));

  const lastSync = (await q('SELECT last_sync_at FROM app.repo_connections WHERE id = $1', [conn.id])).rows[0];
  const rawSince = lastSync?.last_sync_at;
  const sinceIso =
    rawSince instanceof Date ? rawSince.toISOString() : typeof rawSince === 'string' && rawSince ? new Date(rawSince).toISOString() : null;

  const [commits, prs] = await Promise.all([impl.commits(conn, sinceIso), impl.prs(conn)]);

  let newCommits = 0;
  for (const c of commits) {
    const key = findTicketKey(c.message);
    const ticketKey = key && ticketStatus.has(key) ? key : null;
    const inserted = await q(
      `INSERT INTO app.repo_commits (sha, connection_id, message, author, committed_at, url, ticket_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (connection_id, sha) DO NOTHING RETURNING sha`,
      [c.sha, conn.id, c.message.slice(0, 4000), c.author, c.date, c.url, ticketKey],
    );
    if (inserted.rows.length > 0) newCommits++;
  }

  let changedPrs = 0;
  for (const p of prs) {
    const key = findTicketKey(p.branch, p.title);
    const ticketKey = key && ticketStatus.has(key) ? key : null;
    const prev = (
      await q('SELECT state FROM app.repo_prs WHERE connection_id = $1 AND number = $2', [conn.id, p.number])
    ).rows[0];
    await q(
      `INSERT INTO app.repo_prs (connection_id, number, title, author, state, branch, url, ticket_key, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (connection_id, number)
       DO UPDATE SET title = $3, author = $4, state = $5, branch = $6, url = $7, ticket_key = $8, updated_at = $9`,
      [conn.id, p.number, p.title.slice(0, 500), p.author, p.state, p.branch, p.url, ticketKey, p.updatedAt],
    );
    const prevState = prev ? String(prev.state) : null;
    if (prevState === p.state) continue;
    changedPrs++;

    // Automation: linked PR opened → ticket to Review; linked PR merged → Done.
    if (!ticketKey) continue;
    const status = ticketStatus.get(ticketKey);
    if (p.state === 'open' && (status === 'backlog' || status === 'progress')) {
      await q('UPDATE app.tickets SET status = $2 WHERE key = $1', [ticketKey, 'review']);
      ticketStatus.set(ticketKey, 'review');
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
        [conn.engagement_id, `PR #${p.number} opened for ${ticketKey} — moved to Review.`, conn.repo_name],
      );
    } else if (p.state === 'merged' && status && status !== 'done' && status !== 'dismissed') {
      await q('UPDATE app.tickets SET status = $2 WHERE key = $1', [ticketKey, 'done']);
      ticketStatus.set(ticketKey, 'done');
      await q(
        `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
         VALUES ($1, 'AGENT', $2, 'JUST NOW', $3, false)`,
        [conn.engagement_id, `PR #${p.number} merged — ${ticketKey} moved to Done.`, conn.repo_name],
      );
    }
  }

  await q(`UPDATE app.repo_connections SET status = 'connected', last_error = NULL, last_sync_at = NOW() WHERE id = $1`, [conn.id]);
  return { commits: newCommits, prs: changedPrs };
}

async function loadConnection(q: Query, engagementId: string): Promise<Connection | null> {
  const { rows } = await q('SELECT * FROM app.repo_connections WHERE engagement_id = $1', [engagementId]);
  return rows.length > 0 ? toConnection(rows[0]) : null;
}

const ConnectBody = z.object({
  url: z.string().url().max(500),
  token: z.string().min(8).max(500),
});

export function setupRepoRoutes(
  app: express.Application,
  q: Query,
  requireLead: (req: express.Request, res: express.Response, engagementId: string | null) => Promise<Identity | null>,
) {
  app.post('/api/engagements/:id/repo', async (req, res) => {
    const parsed = ConnectBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A repository URL and an access token are required' });
      return;
    }
    try {
      const engagementId = req.params.id;
      const lead = await requireLead(req, res, engagementId);
      if (!lead) return;
      const url = parsed.data.url.replace(/\/+$/, '');
      const provider = providerFor(url);
      if (!provider) {
        res.status(400).json({
          error: 'Unsupported repository URL — use https://github.com/owner/repo or https://dev.azure.com/org/project/_git/repo',
        });
        return;
      }
      if (await loadConnection(q, engagementId)) {
        res.status(409).json({ error: 'A repository is already connected — disconnect it first' });
        return;
      }
      const info = await provider.impl.validate(url, parsed.data.token);
      const inserted = await q(
        `INSERT INTO app.repo_connections (engagement_id, provider, repo_url, repo_name, default_branch, token, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [engagementId, provider.key, url, info.name, info.defaultBranch, parsed.data.token, lead.email],
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
        [engagementId, `Connected ${provider.key === 'github' ? 'GitHub' : 'Azure DevOps'} repository ${info.name}.`, info.name],
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
        await q('SELECT number, title, author, state, branch, url, ticket_key, updated_at FROM app.repo_prs WHERE connection_id = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 25', [conn.id])
      ).rows;
      const commits = (
        await q(
          'SELECT sha, message, author, committed_at, url, ticket_key FROM app.repo_commits WHERE connection_id = $1 ORDER BY committed_at DESC NULLS LAST LIMIT 25',
          [conn.id],
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

  app.get('/api/tickets/:key/dev', async (req, res) => {
    try {
      const prs = (
        await q('SELECT number, title, author, state, branch, url FROM app.repo_prs WHERE ticket_key = $1 ORDER BY updated_at DESC NULLS LAST', [
          req.params.key,
        ])
      ).rows;
      const commits = (
        await q('SELECT sha, message, author, committed_at, url FROM app.repo_commits WHERE ticket_key = $1 ORDER BY committed_at DESC NULLS LAST LIMIT 15', [
          req.params.key,
        ])
      ).rows;
      res.json({ prs, commits });
    } catch (err) {
      console.error('ticket dev failed:', err);
      res.status(500).json({ error: 'Failed to load development activity' });
    }
  });
}

/** Poll all connected repositories; failures are recorded per connection. */
export function startRepoPolling(q: Query, intervalMs = 10 * 60_000): void {
  const tick = async () => {
    try {
      const { rows } = await q('SELECT * FROM app.repo_connections');
      for (const row of rows) {
        const conn = toConnection(row);
        try {
          await syncConnection(q, conn);
        } catch (err) {
          const msg = (err as Error).message;
          console.warn(`[repos] poll sync failed for ${conn.repo_name}:`, msg);
          await q(`UPDATE app.repo_connections SET status = 'error', last_error = $2 WHERE id = $1`, [conn.id, msg.slice(0, 500)]).catch(
            () => {},
          );
        }
      }
    } catch (err) {
      console.warn('[repos] poll failed:', (err as Error).message);
    }
  };
  setInterval(() => void tick(), intervalMs).unref?.();
}
