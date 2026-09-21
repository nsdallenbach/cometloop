import { layerByDependency } from './canvas-layout';

/**
 * The Workflows builder's graph model (DAT-284), kept pure so the editing
 * rules can be unit-tested: what a node and an edge are, the sample the page
 * opens with, layered auto-layout, and the checks that keep the graph a DAG.
 * Nothing here executes a workflow — the builder is a placeholder surface.
 */

export type NodeKind = 'trigger' | 'agent' | 'condition' | 'action';

export interface WfNode {
  id: string;
  kind: NodeKind;
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

export const NODE_W = 230;
export const NODE_H = 86;
const COL_GAP = 90;
const ROW_GAP = 34;
const ORIGIN = 60;

export const KIND_META: Record<NodeKind, { label: string; glyph: string; color: string; blurb: string }> = {
  trigger: { label: 'TRIGGER', glyph: '◉', color: 'var(--acc)', blurb: 'Starts the workflow: an event or a schedule' },
  agent: { label: 'AGENT', glyph: '◆', color: 'var(--agent)', blurb: 'Hands a step to an agent' },
  condition: { label: 'CONDITION', glyph: '◇', color: 'var(--warn)', blurb: 'Branches on a result' },
  action: { label: 'ACTION', glyph: '▸', color: 'var(--ok)', blurb: 'Does something in the console or outside it' },
};

const NEW_NODE_COPY: Record<NodeKind, { title: string; detail: string }> = {
  trigger: { title: 'New trigger', detail: 'when…' },
  agent: { title: 'New agent step', detail: 'agent: unassigned' },
  condition: { title: 'New condition', detail: 'if…' },
  action: { title: 'New action', detail: 'do…' },
};

/** The draft the page opens with: a review gate and an idle-ticket nudge. */
export function sampleWorkflow(): Workflow {
  const nodes: Omit<WfNode, 'x' | 'y'>[] = [
    { id: 'pr-opened', kind: 'trigger', title: 'PR opened', detail: 'github · branch carries a ticket key' },
    { id: 'review', kind: 'agent', title: 'Run the PR review agent', detail: 'agent: pr-reviewer' },
    { id: 'verdict', kind: 'condition', title: 'Verdict?', detail: 'approve / request changes' },
    { id: 'to-deploying', kind: 'action', title: 'Move ticket to Deploying', detail: 'console · ticket status' },
    { id: 'requeue', kind: 'action', title: 'Requeue the ticket for its agent', detail: 'console · agent queue, top priority' },
    { id: 'summary', kind: 'action', title: 'Post the summary on the ticket', detail: 'console · ticket comment' },
    { id: 'idle', kind: 'trigger', title: 'Ticket idle 3 business days', detail: 'schedule · weekdays 09:00' },
    { id: 'nudge', kind: 'action', title: 'Nudge the assignee', detail: 'console · notification' },
  ];
  const edges: WfEdge[] = [
    { from: 'pr-opened', to: 'review' },
    { from: 'review', to: 'verdict' },
    { from: 'verdict', to: 'to-deploying', label: 'approve' },
    { from: 'verdict', to: 'requeue', label: 'changes' },
    { from: 'to-deploying', to: 'summary' },
    { from: 'requeue', to: 'summary' },
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

export function removeNode(wf: Workflow, id: string): Workflow {
  return { nodes: wf.nodes.filter((n) => n.id !== id), edges: wf.edges.filter((e) => e.from !== id && e.to !== id) };
}

/** A new node of `kind`, dropped under everything so it never lands on top of a node. */
export function addNode(wf: Workflow, kind: NodeKind, id: string): Workflow {
  const bottom = wf.nodes.reduce((m, n) => Math.max(m, n.y + NODE_H), ORIGIN - ROW_GAP);
  return { ...wf, nodes: [...wf.nodes, { id, kind, ...NEW_NODE_COPY[kind], x: ORIGIN, y: bottom + ROW_GAP }] };
}

/** Accept only a well-formed draft from storage; anything else means "start from the sample". */
export function parseWorkflow(raw: string | null): Workflow | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) return null;
    const kinds = Object.keys(KIND_META);
    const nodes = (v.nodes as Partial<WfNode>[]).filter(
      (n): n is WfNode =>
        typeof n.id === 'string' && typeof n.title === 'string' && typeof n.detail === 'string' && typeof n.x === 'number' && typeof n.y === 'number' && kinds.includes(n.kind ?? ''),
    );
    const ids = new Set(nodes.map((n) => n.id));
    const edges = (v.edges as Partial<WfEdge>[]).filter((e): e is WfEdge => typeof e.from === 'string' && typeof e.to === 'string' && ids.has(e.from) && ids.has(e.to));
    return nodes.length === (v.nodes as unknown[]).length ? { nodes, edges } : null;
  } catch {
    return null;
  }
}
