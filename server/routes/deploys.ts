import { z } from 'zod';
import type express from 'express';
import { callerOf, resolveCaller } from './roles';
import { setTicketStatus } from './ticket-events';
import { createNotification } from './notifications';

/**
 * Local deployment queue + deploy events (DAT-236, phase B): merged tickets
 * deploy from the assignee's own machine — the desktop app runs the deploy
 * with the dev's identity and posts ticket-keyed events home (queued /
 * started / succeeded / failed / removed). The console renders everything
 * from those client-reported events:
 *
 *  - Done-on-green keeps working without a board Deploy column: a `succeeded`
 *    event settles the ticket to Done exactly like the CI watch does, and a
 *    `failed` event posts the ⚠ feed warning while the ticket holds in
 *    Deploying.
 *  - The web app's Deploys tab is a READ-ONLY mirror computed purely from the
 *    event trail (`computeDeployMirror`) — full PM visibility with no path
 *    from the web app into anyone's laptop. There is deliberately no endpoint
 *    that triggers, retries, or cancels a deploy.
 *
 * The desktop discovers what should queue locally via GET /api/deploys/queue:
 * merged linked PRs whose tickets are assigned to the caller (workspace
 * identity → roster name) and not yet deployed.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export const DEPLOY_EVENTS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS app.deploy_events (
    id SERIAL PRIMARY KEY,
    engagement_id TEXT NOT NULL REFERENCES app.engagements(id) ON DELETE CASCADE,
    ticket_key TEXT NOT NULL REFERENCES app.tickets(key) ON DELETE CASCADE,
    pr_number INT,
    agent TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS deploy_events_engagement_idx ON app.deploy_events (engagement_id, id)`,
  `CREATE INDEX IF NOT EXISTS deploy_events_ticket_idx ON app.deploy_events (ticket_key, id)`,
];

export const DEPLOY_EVENT_KINDS = ['queued', 'started', 'succeeded', 'failed', 'removed'] as const;
export type DeployEventKind = (typeof DEPLOY_EVENT_KINDS)[number];

export interface DeployEventRow {
  id: number;
  ticketKey: string;
  prNumber: number | null;
  agent: string;
  actor: string;
  event: DeployEventKind;
  detail: string;
  createdAt: string;
}

/** One ticket's place in the mirrored queue, folded from its event trail. */
export interface DeployMirrorEntry {
  ticketKey: string;
  prNumber: number | null;
  /** Machine that reported the events (desktop agent name). */
  agent: string;
  /** Dev identity the deploy runs as (workspace email). */
  actor: string;
  state: 'queued' | 'deploying' | 'succeeded' | 'failed';
  /** Failure detail (log tail) — empty unless state is 'failed'. */
  detail: string;
  queuedAt: string;
  updatedAt: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : '');

export function toDeployEventRow(row: Record<string, unknown>): DeployEventRow {
  const kind = str(row.event);
  return {
    id: Number(row.id),
    ticketKey: str(row.ticket_key),
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
    agent: str(row.agent),
    actor: str(row.actor),
    event: (DEPLOY_EVENT_KINDS as readonly string[]).includes(kind) ? (kind as DeployEventKind) : 'queued',
    detail: str(row.detail),
    createdAt: iso(row.created_at),
  };
}

/**
 * Fold an event trail (ascending id order) into the read-only queue the web
 * app mirrors. Latest event per ticket wins; 'removed' drops the entry; a
 * fresh 'queued' after a terminal state starts a new cycle (new queuedAt).
 * Order: deploying first, then queued FIFO, then failed, then succeeded —
 * the same order a PM would triage in.
 */
export function computeDeployMirror(events: DeployEventRow[]): DeployMirrorEntry[] {
  const entries = new Map<string, DeployMirrorEntry>();
  for (const ev of events) {
    if (ev.event === 'removed') {
      entries.delete(ev.ticketKey);
      continue;
    }
    const prev = entries.get(ev.ticketKey);
    const terminal = prev?.state === 'succeeded' || prev?.state === 'failed';
    entries.set(ev.ticketKey, {
      ticketKey: ev.ticketKey,
      prNumber: ev.prNumber ?? prev?.prNumber ?? null,
      agent: ev.agent || prev?.agent || '',
      actor: ev.actor || prev?.actor || '',
      state: ev.event === 'queued' ? 'queued' : ev.event === 'started' ? 'deploying' : ev.event,
      detail: ev.event === 'failed' ? ev.detail : '',
      queuedAt: ev.event === 'queued' && (prev == null || terminal) ? ev.createdAt : (prev?.queuedAt ?? ev.createdAt),
      updatedAt: ev.createdAt,
    });
  }
  const rank: Record<DeployMirrorEntry['state'], number> = { deploying: 0, queued: 1, failed: 2, succeeded: 3 };
  return [...entries.values()].sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    return a.state === 'queued' ? a.queuedAt.localeCompare(b.queuedAt) : b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * Is a local (client-run) deploy the mechanism of record for this ticket?
 * True when any deploy event exists and the latest is not 'removed'. The CI
 * deploy watch consults this before its "no pipeline appeared → settle Done"
 * grace path — an engagement that deploys from laptops has no CI run for the
 * merge commit, and settling there would mark work Done that never deployed.
 * Table-missing/transient errors return false so the CI watch (and its tests)
 * behave exactly as before this feature.
 */
export async function localDeployPending(q: Query, ticketKey: string | null): Promise<boolean> {
  if (!ticketKey) return false;
  try {
    const { rows } = await q(`SELECT event FROM app.deploy_events WHERE ticket_key = $1 ORDER BY id DESC LIMIT 1`, [
      ticketKey,
    ]);
    return rows.length > 0 && str(rows[0].event) !== 'removed';
  } catch {
    return false;
  }
}

export interface DeployEventInput {
  agent: string;
  /** Workspace identity of the reporting client (the dev the deploy runs as). */
  actor: string;
  event: DeployEventKind;
  prNumber: number | null;
  detail: string;
  ticket: { key: string; engagementId: string; status: string; assignee: string; title: string };
}

/**
 * Persist one client-reported event and apply its board side effects. Returns
 * false when the event was dropped as a duplicate ('queued' while the ticket
 * is already queued or deploying — desktop clients re-announce their queue on
 * every poll, so this is the normal idempotent path).
 */
export async function recordDeployEvent(q: Query, input: DeployEventInput): Promise<boolean> {
  const { ticket } = input;
  if (input.event === 'queued') {
    const latest = (
      await q(`SELECT event FROM app.deploy_events WHERE ticket_key = $1 ORDER BY id DESC LIMIT 1`, [ticket.key])
    ).rows[0];
    if (latest && ['queued', 'started'].includes(str(latest.event))) return false;
  }

  await q(
    `INSERT INTO app.deploy_events (engagement_id, ticket_key, pr_number, agent, actor, event, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ticket.engagementId, ticket.key, input.prNumber, input.agent, input.actor, input.event, input.detail],
  );

  const feed = (text: string) =>
    q(
      `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, source, reversible)
       VALUES ($1, 'AGENT', $2, 'JUST NOW', 'deploys', false)`,
      [ticket.engagementId, text],
    );
  const pr = input.prNumber === null ? '' : ` (PR #${String(input.prNumber)})`;
  const open = !['done', 'dismissed'].includes(ticket.status);

  if (input.event === 'started') {
    // The local deploy parks the ticket in Deploying, exactly where a CI
    // merge would put it — the lane keeps meaning "shipping, not shipped".
    if (open && ticket.status !== 'deploying') await setTicketStatus(q, ticket.key, 'deploying');
    await feed(`Local deploy started for ${ticket.key}${pr} on ${input.agent} — running as ${input.actor}.`);
  } else if (input.event === 'succeeded') {
    // Settle the linked merged PR so the deploy gate and the CI watch agree
    // that this ticket has shipped (and the watch stops polling for it).
    const prFilter = input.prNumber === null ? '' : ' AND number = $2';
    await q(
      `UPDATE app.repo_prs SET deploy_state = 'success'
       WHERE ticket_key = $1 AND state = 'merged'
         AND (deploy_state IS NULL OR deploy_state <> 'success')${prFilter}`,
      input.prNumber === null ? [ticket.key] : [ticket.key, input.prNumber],
    );
    const text = `Local deploy succeeded for ${ticket.key}${pr} on ${input.agent} — moved to Done.`;
    if (open) {
      await setTicketStatus(q, ticket.key, 'done');
      await createNotification(q, {
        recipient: ticket.assignee,
        type: 'repo_status',
        title: `${ticket.key} moved to Done`,
        message: text,
        ticketKey: ticket.key,
        engagementId: ticket.engagementId,
      });
    }
    await feed(text);
  } else if (input.event === 'failed') {
    if (open && ticket.status !== 'deploying') await setTicketStatus(q, ticket.key, 'deploying');
    const reason = input.detail.split('\n').find((l) => l.trim()) ?? '';
    const text = `⚠ Local deploy failed for ${ticket.key}${pr} on ${input.agent}${reason ? ` — ${reason.trim().slice(0, 300)}` : ''}. The ticket stays in Deploying until a passing deploy.`;
    await createNotification(q, {
      recipient: ticket.assignee,
      type: 'repo_status',
      title: `Deploy failed for ${ticket.key}`,
      message: text,
      ticketKey: ticket.key,
      engagementId: ticket.engagementId,
    });
    await feed(text);
  }
  // 'queued' and 'removed' are queue bookkeeping — mirrored, never fed.
  return true;
}

/**
 * What should queue on THIS dev's machine: merged linked PRs whose tickets
 * are assigned to the caller (matched workspace email → roster name via the
 * engagement roster) and whose deploy has not settled. Ordered oldest merge
 * first — the queue deploys in the order work landed.
 */
export async function listLocalDeployQueue(q: Query, email: string): Promise<Record<string, unknown>[]> {
  // Roster first (identity email → member name per engagement), then a
  // join-only main query filtered here — semantically the correlated EXISTS
  // this replaces, split up because pg-mem cannot correlate an outer alias
  // into a subquery that itself joins.
  const memberRows = (
    await q(
      `SELECT m.name, em.engagement_id FROM app.team_members m
       JOIN app.engagement_members em ON em.member_id = m.id
       WHERE LOWER(m.email) = LOWER($1)`,
      [email],
    )
  ).rows;
  if (memberRows.length === 0) return [];
  const nameByEngagement = new Map<string, Set<string>>();
  for (const row of memberRows) {
    const eng = str(row.engagement_id);
    if (!nameByEngagement.has(eng)) nameByEngagement.set(eng, new Set());
    if (typeof row.name === 'string') nameByEngagement.get(eng)?.add(row.name);
  }

  const { rows } = await q(
    `SELECT t.key AS ticket_key, t.title, t.engagement_id, t.assignee, pr.number AS pr_number, pr.branch, pr.merge_sha,
            c.repo_name, c.repo_url, c.default_branch
     FROM app.repo_prs pr
     JOIN app.repo_connections c ON c.id = pr.connection_id
     JOIN app.tickets t ON t.key = pr.ticket_key
     WHERE t.engagement_id = c.engagement_id
       AND pr.state = 'merged'
       AND t.status NOT IN ('done','dismissed')
       AND COALESCE(pr.deploy_state, 'pending') IN ('pending','running','failed')
     ORDER BY pr.updated_at ASC
     LIMIT 200`,
    [],
  );
  return rows
    .filter((row) => nameByEngagement.get(str(row.engagement_id))?.has(str(row.assignee)) ?? false)
    .slice(0, 50);
}

const EventBody = z.object({
  agent: z.string().min(1).max(80),
  ticket: z.string().min(1).max(40),
  event: z.enum(DEPLOY_EVENT_KINDS),
  prNumber: z.number().int().positive().optional(),
  detail: z.string().max(4000).optional(),
});

export function setupDeployRoutes(app: express.Application, q: Query): void {
  // Desktop clients report their local queue and deploy outcomes here. The
  // actor is the caller's workspace identity, never a body field — events are
  // attributed to whoever actually authenticated, ticket-keyed by the body.
  app.post('/api/agent/deploys/events', async (req, res) => {
    const parsed = EventBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'agent, ticket and a valid event are required' });
      return;
    }
    try {
      const ticket = (
        await q('SELECT key, engagement_id, status, assignee, title FROM app.tickets WHERE key = $1', [
          parsed.data.ticket,
        ])
      ).rows[0];
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      const caller = await resolveCaller(req);
      const recorded = await recordDeployEvent(q, {
        agent: parsed.data.agent,
        actor: caller?.email ?? '',
        event: parsed.data.event,
        prNumber: parsed.data.prNumber ?? null,
        detail: parsed.data.detail ?? '',
        ticket: {
          key: str(ticket.key),
          engagementId: str(ticket.engagement_id),
          status: str(ticket.status),
          assignee: str(ticket.assignee),
          title: str(ticket.title),
        },
      });
      res.json({ ok: true, recorded });
    } catch (err) {
      console.error('deploy event failed:', err);
      res.status(500).json({ error: 'Failed to record deploy event' });
    }
  });

  // The dev's local queue (desktop polls this as the signed-in dev).
  app.get('/api/deploys/queue', async (req, res) => {
    try {
      const identity = await callerOf(req);
      const items = await listLocalDeployQueue(q, identity.email);
      res.json({ items });
    } catch (err) {
      console.error('deploy queue failed:', err);
      res.status(500).json({ error: 'Failed to load the deploy queue' });
    }
  });

  // Read-only mirror for the web app: the queue and recent trail, computed
  // purely from client-reported events. No mutations live under this path.
  app.get('/api/engagements/:id/deploys', async (req, res) => {
    try {
      const { rows } = await q(
        `SELECT id, ticket_key, pr_number, agent, actor, event, detail, created_at
         FROM app.deploy_events WHERE engagement_id = $1 ORDER BY id DESC LIMIT 400`,
        [req.params.id],
      );
      const events = rows.map(toDeployEventRow).reverse();
      const queue = computeDeployMirror(events);
      const titles = new Map<string, string>();
      if (queue.length > 0) {
        const keyRows = (
          await q('SELECT key, title FROM app.tickets WHERE key = ANY($1)', [queue.map((e) => e.ticketKey)])
        ).rows;
        for (const r of keyRows) titles.set(str(r.key), str(r.title));
      }
      res.json({
        queue: queue.map((e) => ({ ...e, title: titles.get(e.ticketKey) ?? '' })),
        events: events.slice(-60).reverse(),
      });
    } catch (err) {
      console.error('deploy mirror failed:', err);
      res.status(500).json({ error: 'Failed to load deployments' });
    }
  });
}
