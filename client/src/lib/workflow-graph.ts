import { layerByDependency } from './canvas-layout';
import { CATALOG, DEFAULT_TYPE, summarizeNode, withDefaults, type NodeConfig, type NodeKind } from '../../../shared/workflows/catalog';

/**
 * The Workflows builder's graph model (DAT-284), kept pure so the editing
 * rules can be unit-tested: what a node and an edge are, the sample the page
 * opens with, layered auto-layout, and the checks that keep the graph a DAG.
 * A node's `type` names its catalog entry and `config` holds that entry's
 * field values (shared/workflows/catalog.ts); the server runs them.
 */

export type { NodeKind };

export interface WfNode {
  id: string;
  kind: NodeKind;
  /** Catalog entry id (a trigger / condition / action / agent type). */
  type: string;
  config: NodeConfig;
  title: string;
  detail: string;
  x: number;
  y: number;
}

export interface WfEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Workflow {
  nodes: WfNode[];
  edges: WfEdge[];
}

/** A run of a workflow as the list shows it (DAT-288). */
export interface WorkflowRunSummary {
  id: number;
  workflowId: number;
  workflowName: string;
  trigger: string;
  subject: string;
  /** running / succeeded / failed. */
  state: string;
  error: string;
  startedAt: string;
  finishedAt: string | null;
  stepCount: number;
}

export interface WorkflowRunStep {
  nodeId: string;
  kind: NodeKind;
  type: string;
  title: string;
  state: 'ok' | 'failed';
  outcome?: string;
  detail: string;
  startedAt: string;
  ms: number;
}

export interface WorkflowRun extends WorkflowRunSummary {
  steps: WorkflowRunStep[];
  payload: Record<string, unknown>;
}

/** A stored workflow as the list shows it (DAT-288). */
export interface WorkflowSummary {
  id: number;
  name: string;
  enabled: boolean;
  nodes: number;
  trigger: string;
  updatedBy: string;
  updatedAt: string;
  lastRun: { id: number; state: string; startedAt: string; finishedAt: string | null; error: string } | null;
  runs7d: { ok: number; failed: number };
}

/** A stored workflow with its graph; `updatedAt` is what the next save is based on. */
export interface SavedWorkflow {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  graph: Workflow;
  updatedBy: string;
  updatedAt: string;
}

export const NODE_W = 230;
export const NODE_H = 86;
const COL_GAP = 90;
const ROW_GAP = 34;
const ORIGIN = 60;

export const KIND_META: Record<NodeKind, { label: string; glyph: string; color: string; blurb: string }> = {
  trigger: { label: 'TRIGGER', glyph: '◉', color: 'var(--acc)', blurb: 'Starts the workflow: an event, a schedule, or Run now' },
  agent: { label: 'AGENT', glyph: '◆', color: 'var(--agent)', blurb: 'Queues the ticket for a coding agent' },
  condition: { label: 'CONDITION', glyph: '◇', color: 'var(--warn)', blurb: 'A rule, or a decision model picking one of your choices' },
  action: { label: 'ACTION', glyph: '▸', color: 'var(--ok)', blurb: 'Moves, comments, assigns, tags, notifies, posts, calls a webhook' },
};

/** A node's card copy from its config: the catalog label and a one-line summary. */
export function describeNode(kind: NodeKind, type: string, config: NodeConfig): { title: string; detail: string } {
  const entry = CATALOG[kind].find((e) => e.id === type);
  return { title: entry?.label ?? type, detail: summarizeNode(kind, type, config) };
}

/** A node whose title and detail follow its config (unless the title was customised). */
export function retitle(n: WfNode, type: string, config: NodeConfig): WfNode {
  const before = describeNode(n.kind, n.type, n.config);
  const after = describeNode(n.kind, type, config);
  const customTitle = n.title !== before.title;
  return { ...n, type, config, title: customTitle ? n.title : after.title, detail: after.detail };
}

function node(id: string, kind: NodeKind, type: string, config: NodeConfig = {}, title?: string): Omit<WfNode, 'x' | 'y'> {
  const full = withDefaults(kind, type, config);
  const d = describeNode(kind, type, full);
  return { id, kind, type, config: full, title: title ?? d.title, detail: d.detail };
}

/** The draft the page opens with: a review gate and an idle-ticket nudge. */
export function sampleWorkflow(): Workflow {
  const nodes: Omit<WfNode, 'x' | 'y'>[] = [
    node('pr-opened', 'trigger', 'pr.opened'),
    node(
      'kind',
      'condition',
      'decide',
      {
        question: 'Is this pull request a quick fix or a substantial change?',
        choices: 'quick: a few lines, a typo, a config value\nsubstantial: new behaviour, a migration, or touches many files',
        state: '{{pr.title}}\n\n{{ticket.title}}\n{{ticket.description}}',
      },
      'Quick fix or substantial?',
    ),
    node('tag-review', 'action', 'ticket.tag', { tag: 'needs-second-reviewer' }),
    node('notify-lead', 'action', 'notify', { to: '{{ticket.assignee}}', title: '{{ticket.key}}: PR #{{pr.number}} is up', message: '{{pr.url}}' }),
    node('idle', 'trigger', 'ticket.idle', { days: 3 }),
    node('nudge', 'action', 'ticket.comment', { body: 'Nothing has happened on {{ticket.key}} for {{idle.days}} business days. Still on it?' }),
  ];
  const edges: WfEdge[] = [
    { from: 'pr-opened', to: 'kind' },
    { from: 'kind', to: 'tag-review', label: 'substantial' },
    { from: 'kind', to: 'notify-lead' },
    { from: 'idle', to: 'nudge' },
  ];
  return autoLayout({ nodes: nodes.map((n) => ({ ...n, x: 0, y: 0 })), edges });
}

/**
 * Left-to-right layers: a node sits one column right of everything that
 * feeds it. Rows inside a column keep the node order, centred on the tallest
 * column so fan-outs spread evenly around their source.
 */
export function autoLayout(wf: Workflow): Workflow {
  const layers = layerByDependency(
    wf.nodes.map((n) => n.id),
    wf.edges,
  );
  const tallest = Math.max(1, ...layers.map((l) => l.length));
  const at = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, col) => {
    const offset = ((tallest - layer.length) * (NODE_H + ROW_GAP)) / 2;
    layer.forEach((id, row) => at.set(id, { x: ORIGIN + col * (NODE_W + COL_GAP), y: Math.round(ORIGIN + offset + row * (NODE_H + ROW_GAP)) }));
  });
  return { ...wf, nodes: wf.nodes.map((n) => ({ ...n, ...(at.get(n.id) ?? { x: n.x, y: n.y }) })) };
}

/** Whether `to` can already reach `from` — adding from→to would close a cycle. */
export function wouldCycle(edges: WfEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(out.get(cur) ?? []));
  }
  return false;
}

/** Add an edge, or say why not. Triggers start workflows, so nothing feeds one. */
export function connect(wf: Workflow, from: string, to: string): { wf: Workflow; error: string | null } {
  const target = wf.nodes.find((n) => n.id === to);
  if (!target || !wf.nodes.some((n) => n.id === from)) return { wf, error: 'That node is gone' };
  if (target.kind === 'trigger') return { wf, error: 'A trigger starts a workflow — nothing can feed it' };
  if (wf.edges.some((e) => e.from === from && e.to === to)) return { wf, error: 'Those two are already connected' };
  if (wouldCycle(wf.edges, from, to)) return { wf, error: 'That would make a loop — workflows run one way' };
  return { wf: { ...wf, edges: [...wf.edges, { from, to }] }, error: null };
}

/** Set (or clear) the label on a connection — the outcome it waits for out of a condition. */
export function relabel(wf: Workflow, from: string, to: string, label: string): Workflow {
  const l = label.trim();
  return { ...wf, edges: wf.edges.map((e) => (e.from === from && e.to === to ? (l ? { ...e, label: l } : { from: e.from, to: e.to }) : e)) };
}

export function removeNode(wf: Workflow, id: string): Workflow {
  return { nodes: wf.nodes.filter((n) => n.id !== id), edges: wf.edges.filter((e) => e.from !== id && e.to !== id) };
}

export function removeEdge(wf: Workflow, from: string, to: string): Workflow {
  return { ...wf, edges: wf.edges.filter((e) => !(e.from === from && e.to === to)) };
}

/** A new node of `kind` (its default type), dropped under everything so it never lands on top of a node. */
export function addNode(wf: Workflow, kind: NodeKind, id: string, type: string = DEFAULT_TYPE[kind]): Workflow {
  const bottom = wf.nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), ORIGIN - ROW_GAP);
  return { ...wf, nodes: [...wf.nodes, { ...node(id, kind, type), x: ORIGIN, y: bottom + ROW_GAP }] };
}

/** Change what a node does (its config, or its type) and keep the card copy in step. */
export function configure(wf: Workflow, id: string, patch: { type?: string; config?: NodeConfig; title?: string }): Workflow {
  return {
    ...wf,
    nodes: wf.nodes.map((n) => {
      if (n.id !== id) return n;
      const type = patch.type ?? n.type;
      const config = patch.type && patch.type !== n.type ? withDefaults(n.kind, type, patch.config ?? {}) : (patch.config ?? n.config);
      const next = retitle(n, type, config);
      return patch.title !== undefined ? { ...next, title: patch.title } : next;
    }),
  };
}

const isConfig = (v: unknown): v is NodeConfig =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string' || typeof x === 'number');

/** Accept only a well-formed draft from storage; anything else means "start from the sample". */
export function parseWorkflow(raw: string | null): Workflow | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) return null;
    const kinds = Object.keys(KIND_META);
    const nodes = (v.nodes as Partial<WfNode>[]).flatMap((n): WfNode[] => {
      if (typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.detail !== 'string' || typeof n.x !== 'number' || typeof n.y !== 'number' || !kinds.includes(n.kind ?? '')) return [];
      const kind = n.kind as NodeKind;
      // Pre-catalog drafts carry no type: they get the kind's default and keep their copy.
      const type = typeof n.type === 'string' && CATALOG[kind].some((e) => e.id === n.type) ? n.type : DEFAULT_TYPE[kind];
      return [{ id: n.id, kind, type, config: withDefaults(kind, type, isConfig(n.config) ? n.config : {}), title: n.title, detail: n.detail, x: n.x, y: n.y }];
    });
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (v.edges as Partial<WfEdge>[]).flatMap((e): WfEdge[] =>
      typeof e.from === 'string' && typeof e.to === 'string' && ids.has(e.from) && ids.has(e.to) ? [typeof e.label === 'string' && e.label ? { from: e.from, to: e.to, label: e.label } : { from: e.from, to: e.to }] : [],
    );
    return nodes.length === (v.nodes as unknown[]).length ? { nodes, edges } : null;
  } catch {
    return null;
  }
}
