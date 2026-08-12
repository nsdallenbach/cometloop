import { z } from 'zod';
import type express from 'express';
import { recordTicketEvent } from './ticket-events';

/**
 * Ticket consolidation (DAT-173): merge duplicate/overlapping tickets into a
 * surviving target. Source descriptions and acceptance criteria fold into the
 * target (each under a "## Consolidated from" section so nothing human-written
 * is lost), stored links repoint to the target, and the sources leave the
 * board as dismissed with a comment naming where their scope went. Used by the
 * lead-gated REST route, the scoping agent's consolidate_tickets tool and the
 * MCP endpoint.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const txt = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `$n,$n+1,…` placeholder list for an IN clause (pg-mem can't bind `= ANY($1)` arrays). */
const placeholders = (count: number, from = 1): string => Array.from({ length: count }, (_, i) => `$${from + i}`).join(',');

/** Statuses a source ticket may be in — done work and dismissed tickets never merge. */
const SOURCE_STATUSES = ['backlog', 'proposed', 'progress'];

const MAX_MERGED_AC = 20;

export type ConsolidateResult =
  | { ok: true; targetKey: string; merged: { key: string; title: string }[]; acCount: number }
  | { ok: false; status: number; error: string };

function parseAc(raw: unknown): string[] {
  try {
    const arr: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.map(txt).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * The "## Consolidated from …" tail of a description, if any. Refinement flows
 * that rewrite a description use this to carry the merged sections across the
 * rewrite instead of silently dropping them.
 */
export function consolidatedTail(description: string): string {
  const m = /^## Consolidated from /m.exec(description);
  return m ? description.slice(m.index).trim() : '';
}

/** Union of AC lists, first occurrence wins (case/whitespace-insensitive). */
export function mergeAcceptanceCriteria(...lists: string[][]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list) {
      const norm = item.trim().toLowerCase();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push(item.trim());
      if (out.length >= MAX_MERGED_AC) return out;
    }
  }
  return out;
}

export async function consolidateTickets(
  q: Query,
  targetKey: string,
  sourceKeys: string[],
  author: string,
  feedActor = 'YOU',
): Promise<ConsolidateResult> {
  const sources = [...new Set(sourceKeys)].filter((k) => k && k !== targetKey);
  if (sources.length === 0) return { ok: false, status: 400, error: 'At least one source ticket (other than the target) is required' };

  const target = (await q('SELECT * FROM app.tickets WHERE key = $1', [targetKey])).rows[0];
  if (!target) return { ok: false, status: 404, error: `Target ticket ${targetKey} not found` };
  if (['done', 'dismissed'].includes(txt(target.status))) {
    return { ok: false, status: 409, error: `Target ${targetKey} is ${txt(target.status)} — consolidate into an active ticket` };
  }

  const rows = (await q(`SELECT * FROM app.tickets WHERE key IN (${placeholders(sources.length)})`, sources)).rows;
  for (const key of sources) {
    const row = rows.find((r) => txt(r.key) === key);
    if (!row) return { ok: false, status: 404, error: `Source ticket ${key} not found` };
    if (txt(row.engagement_id) !== txt(target.engagement_id)) {
      return { ok: false, status: 400, error: `${key} belongs to another engagement` };
    }
    if (!SOURCE_STATUSES.includes(txt(row.status))) {
      return { ok: false, status: 409, error: `${key} is ${txt(row.status)} — only backlog/proposed/in-progress tickets can be consolidated` };
    }
  }
  // A ticket a runner is actively working (or that is queued for one) keeps
  // its own life — consolidating it out from under the agent orphans the run.
  const active = (
    await q(
      `SELECT DISTINCT ticket_key FROM app.agent_tasks WHERE ticket_key IN (${placeholders(sources.length)}) AND state IN ('queued','claimed','working')`,
      sources,
    )
  ).rows.map((r) => txt(r.ticket_key));
  if (active.length > 0) {
    return { ok: false, status: 409, error: `${active.join(', ')} ${active.length === 1 ? 'has' : 'have'} active agent work — cancel it before consolidating` };
  }

  // Fold each source into the target description; merge AC with dedupe.
  let description = txt(target.description).trim();
  let ac = parseAc(target.ac);
  const merged: { key: string; title: string }[] = [];
  for (const key of sources) {
    const row = rows.find((r) => txt(r.key) === key);
    if (!row) continue;
    const body = txt(row.description).trim() || '_(no description)_';
    description = `${description}\n\n## Consolidated from ${key} — ${txt(row.title)}\n\n${body}`.trim();
    ac = mergeAcceptanceCriteria(ac, parseAc(row.ac));
    merged.push({ key, title: txt(row.title) });
  }
  await q('UPDATE app.tickets SET description = $2, ac = $3 WHERE key = $1', [targetKey, description, JSON.stringify(ac)]);

  // Repoint stored links: delete rows touching a source, re-add with the
  // target substituted, dropping self-links and letting exact dupes collapse.
  const sourceIn = placeholders(sources.length);
  const linkRows = (
    await q(`SELECT ticket_key, linked_key, type, created_by FROM app.ticket_links WHERE ticket_key IN (${sourceIn}) OR linked_key IN (${sourceIn})`, sources)
  ).rows;
  await q(`DELETE FROM app.ticket_links WHERE ticket_key IN (${sourceIn}) OR linked_key IN (${sourceIn})`, sources);
  for (const row of linkRows) {
    const from = sources.includes(txt(row.ticket_key)) ? targetKey : txt(row.ticket_key);
    const to = sources.includes(txt(row.linked_key)) ? targetKey : txt(row.linked_key);
    if (from === to) continue;
    await q(
      `INSERT INTO app.ticket_links (ticket_key, linked_key, type, created_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT (ticket_key, linked_key, type) DO NOTHING`,
      [from, to, txt(row.type), txt(row.created_by)],
    );
  }

  const mergedKeys = merged.map((m) => m.key);
  // Capture the prior statuses so the audit trail records the dismissal —
  // consolidation must not be a silent way for tickets to leave the board.
  const priorStatuses = (
    await q(`SELECT key, status FROM app.tickets WHERE key IN (${placeholders(mergedKeys.length)})`, mergedKeys)
  ).rows;
  await q(`UPDATE app.tickets SET status = 'dismissed' WHERE key IN (${placeholders(mergedKeys.length)})`, mergedKeys);
  for (const row of priorStatuses) {
    await recordTicketEvent(q, txt(row.key), txt(target.engagement_id), txt(row.status), 'dismissed');
  }
  for (const key of mergedKeys) {
    await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
      key,
      author,
      `Consolidated into ${targetKey} — this ticket's scope and acceptance criteria now live there.`,
    ]);
  }
  await q('INSERT INTO app.ticket_comments (ticket_key, author, body) VALUES ($1,$2,$3)', [
    targetKey,
    author,
    `Consolidated ${mergedKeys.join(', ')} into this ticket.`,
  ]);
  await q(
    `INSERT INTO app.feed_items (engagement_id, actor, text, time_label, reversible)
     VALUES ($1, $2, $3, 'JUST NOW', false)`,
    [txt(target.engagement_id), feedActor, `Consolidated ${mergedKeys.join(', ')} into ${targetKey}.`],
  );
  console.log(`[consolidate] ${mergedKeys.join(', ')} -> ${targetKey} (${ac.length} AC after merge)`);
  return { ok: true, targetKey, merged, acCount: ac.length };
}

const ConsolidateBody = z.object({
  sources: z.array(z.string().min(1).max(40)).min(1).max(20),
});

type RequireLead = (req: express.Request, res: express.Response, engagementId: string | null) => Promise<unknown>;

function requestAuthor(req: express.Request): string {
  const h = req.headers['x-forwarded-preferred-username'] ?? req.headers['x-forwarded-email'];
  const v = Array.isArray(h) ? h[0] : h;
  return v && v.trim() ? v.trim() : 'You';
}

export function setupTicketConsolidateRoutes(app: express.Application, q: Query, requireLead: RequireLead) {
  // Merge one or more source tickets into :key (lead only — it dismisses the
  // sources). The scoping agent reaches the same logic through its tool.
  app.post('/api/tickets/:key/consolidate', async (req, res) => {
    const parsed = ConsolidateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A non-empty sources list of ticket keys is required' });
      return;
    }
    try {
      const target = (await q('SELECT engagement_id FROM app.tickets WHERE key = $1', [req.params.key])).rows[0];
      if (!target) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      if (!(await requireLead(req, res, txt(target.engagement_id)))) return;
      const result = await consolidateTickets(q, req.params.key, parsed.data.sources, requestAuthor(req));
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({ target: result.targetKey, merged: result.merged.map((m) => m.key), ac_count: result.acCount });
    } catch (err) {
      console.error('consolidate tickets failed:', err);
      res.status(500).json({ error: 'Failed to consolidate tickets' });
    }
  });
}
