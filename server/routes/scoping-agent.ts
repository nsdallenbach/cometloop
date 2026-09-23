import { SCOPING_TOOL_LIMIT, executeScopingTool, scopingToolDefs, type ScopingToolContext } from './scoping-tools';
import { invokeModel, type InvokeContext } from './llm-health';
import type { ChatMessage } from '../llm/provider';
import { clipText } from './utf8-body';

/**
 * Ticket scoping through the planning role (DAT-173; provider registry since
 * phase 3).
 *
 * Two paths, same output contract:
 *  - refinePlan: the original single-shot completion — no board visibility.
 *    Kept as the deterministic-ish fallback so a tool-loop failure can never
 *    make ticket creation worse than it was before this module existed.
 *  - refineTicketWithBoard: a tool-calling agent loop. The planning model is
 *    invoked with the delivery-console scoping tools
 *    (search_tickets / get_ticket / link_tickets / consolidate_tickets — the
 *    board tools also exposed over MCP at POST /api/mcp), so while planning it
 *    can pull context from other tickets on the board, link related work, and
 *    consolidate duplicates into the ticket being scoped.
 *
 * Both talk to the model through `invokeModel('planning', …)` and read the
 * provider-neutral reply (`text`, `toolCalls`) — the adapter owns the wire
 * format, so this module no longer guesses at response shapes.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface RefinedPlan {
  title: string;
  description: string;
  ac: string[];
  estHours: number | null;
  humanEstHours: number | null;
  roadmapItem: string | null;
}

/** A tool call the scoping loop executed, for logging/feed attribution. */
export interface ScopingAction {
  tool: string;
  summary: string;
  ok: boolean;
}

/** The JSON contract both refinement paths ask the model for. */
function planContractLines(roadmapItems: string[]): string[] {
  return [
    'Respond with ONLY a JSON object, no code fences:',
    '{"title": "concise title, max 10 words, plain text", "description": "markdown", "acceptance_criteria": ["testable outcome", ...], "est_hours": number, "human_est_hours": number' +
      (roadmapItems.length > 0 ? ', "roadmap_item": "one of the roadmap items below"' : '') +
      '}',
    'The description becomes the prompt handed to an autonomous coding agent, so make it a compact plan in markdown with these sections (omit any that truly do not apply): ## Context (what exists today and why this is needed), ## Approach (how to implement, referencing systems/files/endpoints implied by the request), ## Dependencies (other tickets, credentials, decisions or unknowns the agent should check first).',
    'Plan only what the request implies — do not invent scope. 3-6 acceptance criteria.',
    'When the work spans multiple components, services, or a flow with 3+ steps, include ONE compact diagram inside the ## Approach section as a fenced ```mermaid block (flowchart TD — top-down suits the ticket panel — or sequenceDiagram for actor interactions; at most ~10 nodes; label every arrow with what moves or happens). The diagram must show the MECHANISM, never a straight chain of boxes: include the decision points, error/rejection paths, and parallel actors that make the flow worth drawing — if the picture would be a single linear line, skip it. Skip it entirely when a diagram would not add real information. The fence lives INSIDE the "description" markdown string; your response overall is still only the bare JSON object.',
    'In flowcharts, color-code nodes by role with these pre-styled classes (append :::name to the node, e.g. Runner[Agent runner]:::agent — no classDef needed): :::agent for AI/runner components, :::app for the console/system being changed, :::good for success/end states, :::risk for human gates or waits, :::bad for failure/error paths. Tag the nodes where the role genuinely matters; leave plumbing untagged.',
    'est_hours is the expected Claude Code agent execution time from claim to ready-for-review, in agent-hours (may be fractional, typically 0.2–8): a small well-scoped change is under an hour; only genuinely sprawling multi-system work exceeds 8.',
    'human_est_hours is an independent estimate of the same scope done by a professional human developer, in hours — usually 3–6× the agent time, but reason from the scope rather than applying a multiplier.',
    ...(roadmapItems.length > 0
      ? [`roadmap_item must be exactly one of: ${roadmapItems.map((p) => JSON.stringify(p)).join(', ')} — pick the item this work belongs to.`]
      : []),
  ];
}

/** Parse the plan JSON out of a model response, defensively typed field by field. */
export function parsePlan(text: string, roadmapItems: string[] = []): RefinedPlan | null {
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (!jsonMatch) return null;
  let plan: {
    title?: unknown;
    description?: unknown;
    acceptance_criteria?: unknown;
    est_hours?: unknown;
    human_est_hours?: unknown;
    roadmap_item?: unknown;
  };
  try {
    plan = JSON.parse(jsonMatch[0]) as typeof plan;
  } catch {
    return null;
  }
  const title = typeof plan.title === 'string' ? clipText(plan.title.trim(), 200) : '';
  const description = typeof plan.description === 'string' ? plan.description.trim() : '';
  const ac = Array.isArray(plan.acceptance_criteria)
    ? plan.acceptance_criteria.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).slice(0, 10)
    : [];
  const estHours =
    typeof plan.est_hours === 'number' && Number.isFinite(plan.est_hours) && plan.est_hours > 0
      ? Math.min(400, Math.round(plan.est_hours * 2) / 2)
      : null;
  const humanEstHours =
    typeof plan.human_est_hours === 'number' && Number.isFinite(plan.human_est_hours) && plan.human_est_hours > 0
      ? Math.min(999, Math.round(plan.human_est_hours * 2) / 2)
      : null;
  // Only accept an item that actually exists on the roadmap — the model must not invent one.
  const roadmapItem =
    typeof plan.roadmap_item === 'string' && roadmapItems.includes(plan.roadmap_item.trim()) ? plan.roadmap_item.trim() : null;
  if (!title && !description) return null;
  return { title, description, ac, estHours, humanEstHours, roadmapItem };
}

/**
 * Single-shot refinement (no board visibility). Returns null when the model
 * is unavailable or the response holds no usable JSON — callers fall back to
 * the raw content.
 */
export async function refinePlan(content: string, roadmapItems: string[] = [], ictx: InvokeContext = {}): Promise<RefinedPlan | null> {
  try {
    // Through the DAT-180 reliability wrapper: retry-once on transients,
    // per-flow failure counters, throttled ⚠ feed item on failure.
    const response = await invokeModel(
      'planning',
      {
        messages: [
          {
            role: 'user',
            content: [
              'You are the delivery-planning agent for a consulting delivery board. A team member typed a work request into a chat box. Turn it into a well-formed delivery ticket.',
              ...planContractLines(roadmapItems),
              'Work request:',
              content,
            ].join('\n\n'),
          },
        ],
        maxTokens: 2000,
        json: true,
      },
      { flow: 'ticket-refine', ...ictx },
    );
    return parsePlan(response.text, roadmapItems);
  } catch (err) {
    console.warn('[scoping] ticket refinement failed:', (err as Error).message);
    return null;
  }
}

/** Tool-call rounds before the loop gives up and the caller falls back. */
const MAX_TOOL_ROUNDS = 8;

/**
 * Tool-calling refinement: the ticket already exists (raw), and the model may
 * search the board, read other tickets, link related work and consolidate
 * duplicates into it before answering with the plan JSON. Returns the plan
 * plus the tool actions taken, or null on any failure (caller falls back to
 * refinePlan — a tool-loop failure must never fail the user's action).
 */
export async function refineTicketWithBoard(
  q: Query,
  opts: { key: string; engagementId: string; content: string; roadmapItems?: string[]; author?: string },
): Promise<{ plan: RefinedPlan; actions: ScopingAction[] } | null> {
  const roadmapItems = opts.roadmapItems ?? [];
  const ctx: ScopingToolContext = {
    q,
    engagementId: opts.engagementId,
    selfKey: opts.key,
    author: opts.author ?? 'Planning Agent',
    feedActor: 'AGENT',
  };
  const tools = scopingToolDefs({ selfKey: opts.key });
  const prompt = [
    `You are the delivery-planning agent for a consulting delivery board. A team member typed a work request into a chat box; it has been captured as ticket ${opts.key}. Turn it into a well-formed delivery ticket.`,
    [
      'You have tools onto the delivery board. Before finalizing the plan:',
      '- search_tickets / get_ticket: check for existing tickets covering related or overlapping work, and use what you learn to sharpen scope and avoid re-planning work that is already ticketed.',
      `- link_tickets: when an existing ticket is related to this one (or blocks it / is blocked by it), record the relationship for ${opts.key}.`,
      `- consolidate_tickets: when one or more existing tickets describe substantially the same work as this request, merge them into ${opts.key} instead of leaving duplicates — their descriptions and acceptance criteria fold into this ticket and they leave the board.`,
      'Keep tool use focused: a search or two, detail reads on the likely matches, then links/consolidation only where genuinely warranted. Do not link or consolidate on weak resemblance.',
    ].join('\n'),
    `When you are done with tools, respond with the final plan for ${opts.key}.`,
    ...planContractLines(roadmapItems),
    'Work request:',
    opts.content,
  ].join('\n\n');

  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  const actions: ScopingAction[] = [];
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await invokeModel(
        'planning',
        { messages, tools, maxTokens: 3000, json: true },
        { flow: 'ticket-refine', engagementId: opts.engagementId, ticketKey: opts.key },
      );
      if (response.toolCalls.length === 0) {
        const plan = parsePlan(response.text, roadmapItems);
        return plan ? { plan, actions } : null;
      }
      // Echo the assistant turn verbatim (text + tool calls), then answer
      // every call — providers reject dangling tool-call ids.
      messages.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });
      for (const tc of response.toolCalls.slice(0, SCOPING_TOOL_LIMIT)) {
        const result = await executeScopingTool(ctx, tc.name, tc.arguments);
        actions.push({ tool: tc.name, summary: result.summary, ok: result.ok });
        messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify(result.ok ? result.data : { error: result.error }) });
      }
      // A runaway turn is truncated, not obeyed — but every call still gets an answer so the transcript stays well-formed.
      for (const tc of response.toolCalls.slice(SCOPING_TOOL_LIMIT)) {
        messages.push({ role: 'tool', toolCallId: tc.id, content: JSON.stringify({ error: `tool call limit of ${String(SCOPING_TOOL_LIMIT)} per turn reached` }) });
      }
    }
    console.warn(`[scoping] ${opts.key}: tool loop exceeded ${String(MAX_TOOL_ROUNDS)} rounds without a final plan`);
    return null;
  } catch (err) {
    console.warn(`[scoping] ${opts.key}: board-aware refinement failed:`, (err as Error).message);
    return null;
  }
}
