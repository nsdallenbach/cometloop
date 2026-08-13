/**
 * Deploy gate on Done (DAT-213): a ticket only reaches Done once its work is
 * actually deployed. Deployment status is not a field of its own — it is the
 * `deploy_state` the sync pass tracks on the ticket's linked PR
 * (`app.repo_prs`, advanced by checkDeployments in repos.ts), so the gate reads
 * the same truth the board card's DEPLOYING / DEPLOY FAILED badges show and is
 * refreshed by the same webhook/sync path with no extra plumbing.
 *
 * The gate gates *user-initiated* moves only — the PATCH/bulk ticket APIs.
 * The automation in repos.ts (settleDeploy) writes Done directly through
 * setTicketStatus and is deliberately not gated: it is the thing that verified
 * the deploy in the first place, and double-checking it here would only race
 * its own write.
 *
 * Three ways a ticket is out of scope of the rule, so the gate never blocks
 * work that has no deployment to wait for:
 *  - it is already in Done (history is never re-litigated — existing Done
 *    tickets keep their status, which is why this needs no backfill);
 *  - its engagement has no repo connected at all (nothing here ever deploys);
 *  - it carries the `no-deploy` tag (the per-ticket exemption for work that
 *    ships nothing — docs, spikes, meetings).
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** Tag that exempts a single ticket from the deploy gate; matched case-insensitively. */
export const DEPLOY_EXEMPT_TAG = 'no-deploy';

/** What the gate needs to know about one ticket to rule on a move to Done. */
export interface DeployGateInput {
  key: string;
  /** Current status — a ticket already in Done is never re-gated. */
  status: string;
  tags: string[];
  /** Whether the ticket's engagement has a git repo connected. */
  repoConnected: boolean;
  /** The PR driving the ticket: open one if any, else the most recent. */
  prNumber: number | null;
  prState: string | null;
  /** deploy_state of the latest tracked deploy for the ticket, null when none. */
  deployState: string | null;
}

/**
 * Why this ticket cannot move to Done, or null when the move is allowed.
 * The string is user-facing: it says what is missing and how to unblock it.
 */
export function doneBlockedReason(t: DeployGateInput): string | null {
  if (t.status === 'done') return null;
  if (!t.repoConnected) return null;
  if (t.tags.some((tag) => tag.trim().toLowerCase() === DEPLOY_EXEMPT_TAG)) return null;

  // A tracked deploy outranks the PR state: it is the later, more specific
  // fact, and 'success'/'none' are exactly the outcomes settleDeploy treats as
  // shipped ('none' = merged with no pipeline configured to wait for).
  if (t.deployState === 'success' || t.deployState === 'none') return null;

  const pr = t.prNumber === null ? 'the linked PR' : `PR #${String(t.prNumber)}`;
  const suffix = ` Tag the ticket \`${DEPLOY_EXEMPT_TAG}\` if it ships nothing deployable.`;
  const blocked = `${t.key} can't move to Done`;

  if (t.deployState === 'pending' || t.deployState === 'running') {
    return `${blocked} — the deploy pipeline for ${pr} is still running. It moves to Done on its own once the pipeline succeeds.${suffix}`;
  }
  if (t.deployState === 'failed') {
    return `${blocked} — the deploy pipeline for ${pr} failed. Land a passing run before closing the ticket.${suffix}`;
  }
  if (t.prState === 'merged') {
    return `${blocked} — ${pr} is merged but no deploy has been recorded yet. Wait for the deploy watch to settle the pipeline result.${suffix}`;
  }
  if (t.prState === 'open') {
    return `${blocked} — ${pr} is still open. Done unlocks once it is merged and the deploy pipeline succeeds.${suffix}`;
  }
  if (t.prState === 'closed') {
    return `${blocked} — ${pr} was closed without merging, so nothing has been deployed. Merge a PR for this ticket first.${suffix}`;
  }
  return `${blocked} — no deployment is linked to it. Merge a PR whose branch or title carries the ticket key and let the deploy pipeline succeed.${suffix}`;
}

/** JSONB tags arrive as an array, but tolerate the serialized form too. */
export function toTags(value: unknown): string[] {
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = [];
    }
  }
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

/** Read one gate input off a ticket row carrying the joined deploy columns. */
export function gateInputFromRow(row: Record<string, unknown>): DeployGateInput {
  return {
    key: typeof row.key === 'string' ? row.key : '',
    status: typeof row.status === 'string' ? row.status : '',
    tags: toTags(row.tags),
    repoConnected: row.repo_connected === true,
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
    prState: typeof row.pr_state === 'string' ? row.pr_state : null,
    deployState: typeof row.deploy_state === 'string' ? row.deploy_state : null,
  };
}

/**
 * Does this ticket's engagement have a repo connected at all? Select it as
 * `(conn.present IS NOT NULL) AS repo_connected`. Split out because the board
 * detail query already joins the PR and deploy laterals and only needs this one.
 */
export const REPO_CONNECTED_JOIN = `
  LEFT JOIN LATERAL (
    SELECT 1 AS present FROM app.repo_connections rc WHERE rc.engagement_id = t.engagement_id LIMIT 1
  ) conn ON true`;

/**
 * The joins that put a ticket's deployment facts on the row: whether its
 * engagement has a repo at all, the PR driving it, and the latest tracked
 * deploy. Mirrors the laterals the board detail query already uses, so the
 * gate and the card badges can never disagree.
 */
export const DEPLOY_GATE_JOINS = `
  ${REPO_CONNECTED_JOIN}
  LEFT JOIN LATERAL (
    SELECT pr.number, pr.state FROM app.repo_prs pr
    JOIN app.repo_connections c ON c.id = pr.connection_id
    WHERE pr.ticket_key = t.key AND c.engagement_id = t.engagement_id
    ORDER BY (pr.state = 'open') DESC, pr.updated_at DESC NULLS LAST LIMIT 1
  ) gp ON true
  LEFT JOIN LATERAL (
    SELECT pr.deploy_state FROM app.repo_prs pr
    JOIN app.repo_connections c ON c.id = pr.connection_id
    WHERE pr.ticket_key = t.key AND c.engagement_id = t.engagement_id AND pr.deploy_state IS NOT NULL
    ORDER BY pr.updated_at DESC NULLS LAST LIMIT 1
  ) gd ON true`;

/**
 * Gate every named ticket: key → blocking reason (null = the move to Done is
 * allowed). Keys that do not exist are absent from the map.
 */
export async function loadDeployGates(q: Query, keys: string[]): Promise<Map<string, string | null>> {
  const gates = new Map<string, string | null>();
  if (keys.length === 0) return gates;
  const { rows } = await q(
    `SELECT t.key, t.status, t.tags,
            (conn.present IS NOT NULL) AS repo_connected,
            gp.number AS pr_number, gp.state AS pr_state, gd.deploy_state
     FROM app.tickets t
     ${DEPLOY_GATE_JOINS}
     WHERE t.key = ANY($1)`,
    [keys],
  );
  for (const row of rows) {
    const input = gateInputFromRow(row);
    gates.set(input.key, doneBlockedReason(input));
  }
  return gates;
}
