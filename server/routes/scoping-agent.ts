import { SCOPING_TOOL_LIMIT, executeScopingTool, scopingToolDefs, type ScopingToolContext } from './scoping-tools';
import { invokeModel, type InvokeContext } from './llm-health';

/**
 * Ticket scoping via the model serving endpoint (DAT-173).
 *
 * Two paths, same output contract:
 *  - refinePlan: the original single-shot completion — no board visibility.
 *    Kept as the deterministic-ish fallback so a tool-loop failure can never
 *    make ticket creation worse than it was before this module existed.
 *  - refineTicketWithBoard: a tool-calling agent loop. The same serving
 *    endpoint is invoked with the delivery-console scoping tools
 *    (search_tickets / get_ticket / link_tickets / consolidate_tickets — the
 *    board tools also exposed over MCP at POST /api/mcp), so while planning it
 *    can pull context from other tickets on the board, link related work, and
 *    consolidate duplicates into the ticket being scoped.
 */

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type Serving = (alias: string) => { invoke(body: unknown): Promise<unknown> };

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

/** Unwrap the appkit serving ExecutionResult wrapper: { ok, data } | { ok: false, message }. */
function unwrap(response: unknown): unknown {
  if (response && typeof response === 'object' && 'ok' in response) {
    const wrapper = response as { ok: boolean; data?: unknown; message?: string };
    if (!wrapper.ok) throw new Error(wrapper.message ?? 'model invocation failed');
    return wrapper.data;
  }
  return response;
}

/** choices[0].message from a chat-completions response, or null. */
function extractMessage(response: unknown): Record<string, unknown> | null {
  const r = unwrap(response) as { choices?: { message?: unknown }[] };
  const message = r?.choices?.[0]?.message;
  return message && typeof message === 'object' ? (message as Record<string, unknown>) : null;
}

/** Text content of a chat message (string or typed-parts array). */
function messageText(message: Record<string, unknown> | null): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        const part = c as { type?: string; text?: string };
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return '';
}

export function extractText(response: unknown): string {
  return messageText(extractMessage(response));
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
  const title = typeof plan.title === 'string' ? plan.title.trim().slice(0, 200) : '';
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
export async function refinePlan(
  serving: Serving,
  content: string,
  roadmapItems: string[] = [],
  q: Query | null = null,
  ictx: InvokeContext = {},
): Promise<RefinedPlan | null> {
  try {
    // Through the DAT-180 reliability wrapper: retry-once on transients,
    // per-flow failure counters, throttled ⚠ feed item on failure.
    const response = await invokeModel(serving, q, 'ticket-refine', {
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
      max_tokens: 1500,
    }, ictx);
    return parsePlan(extractText(response), roadmapItems);
  } catch (err) {
    console.warn('[scoping] ticket refinement failed:', (err as Error).message);
    return null;
  }
}

/** Tool-call rounds before the loop gives up and the caller falls back. */
const MAX_TOOL_ROUNDS = 8;

interface ServingToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/**
 * Tool-calling refinement: the ticket already exists (raw), and the model may
 * search the board, read other tickets, link related work and consolidate
 * duplicates into it before answering with the plan JSON. Returns the plan
 * plus the tool actions taken, or null on any failure (caller falls back to
 * refinePlan — a tool-loop failure must never fail the user's action).
 */
export async function refineTicketWithBoard(
  serving: Serving,
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
  const tools = scopingToolDefs({ selfKey: opts.key }).map((d) => ({ type: 'function', function: d }));
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

  const messages: unknown[] = [{ role: 'user', content: prompt }];
  const actions: ScopingAction[] = [];
  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await invokeModel(serving, q, 'ticket-refine', { messages, tools, max_tokens: 2500 }, {
        engagementId: opts.engagementId,
        ticketKey: opts.key,
      });
      const message = extractMessage(response);
      if (!message) return null;
      const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as ServingToolCall[]) : [];
      if (toolCalls.length === 0) {
        const plan = parsePlan(messageText(message), roadmapItems);
        return plan ? { plan, actions } : null;
      }
      // Echo the assistant turn verbatim (content + tool_calls), then answer
      // every call — the endpoint rejects dangling tool_call ids.
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });
      for (const tc of toolCalls.slice(0, SCOPING_TOOL_LIMIT)) {
        const name = typeof tc.function?.name === 'string' ? tc.function.name : '';
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(typeof tc.function?.arguments === 'string' && tc.function.arguments ? tc.function.arguments : '{}');
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
        } catch {
          /* malformed arguments — run the tool with none and let it complain */
        }
        const result = await executeScopingTool(ctx, name, args);
        actions.push({ tool: name, summary: result.summary, ok: result.ok });
        messages.push({
          role: 'tool',
          tool_call_id: typeof tc.id === 'string' ? tc.id : '',
          content: JSON.stringify(result.ok ? result.data : { error: result.error }),
        });
      }
    }
    console.warn(`[scoping] ${opts.key}: tool loop exceeded ${MAX_TOOL_ROUNDS} rounds without a final plan`);
    return null;
  } catch (err) {
    console.warn(`[scoping] ${opts.key}: board-aware refinement failed:`, (err as Error).message);
    return null;
  }
}
