import { describe, expect, it } from 'vitest';
import { addNode, autoLayout, connect, NODE_H, NODE_W, parseWorkflow, removeNode, sampleWorkflow, wouldCycle, type Workflow } from '../client/src/lib/workflow-graph';
import { DEFAULT_TYPE, withDefaults } from '../shared/workflows/catalog';

const node = (id: string, kind: Workflow['nodes'][number]['kind'] = 'action') => ({ id, kind, type: DEFAULT_TYPE[kind], config: withDefaults(kind, DEFAULT_TYPE[kind], {}), title: id, detail: '', x: 0, y: 0 });
const wf: Workflow = { nodes: [node('t', 'trigger'), node('a'), node('b')], edges: [{ from: 't', to: 'a' }] };

describe('sampleWorkflow', () => {
  it('opens laid out, acyclic, with no two nodes overlapping', () => {
    const s = sampleWorkflow();
    for (const e of s.edges) expect(wouldCycle(s.edges.filter((x) => x !== e), e.from, e.to)).toBe(false);
    for (let i = 0; i < s.nodes.length; i++) {
      for (let j = i + 1; j < s.nodes.length; j++) {
        const a = s.nodes[i];
        const b = s.nodes[j];
        expect(Math.abs(a.x - b.x) >= NODE_W || Math.abs(a.y - b.y) >= NODE_H).toBe(true);
      }
    }
  });
});

describe('autoLayout', () => {
  it('puts each node one column right of what feeds it', () => {
    const laid = autoLayout({ ...wf, edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'b' }] });
    const x = (id: string) => laid.nodes.find((n) => n.id === id)?.x ?? -1;
    expect(x('t')).toBeLessThan(x('a'));
    expect(x('a')).toBeLessThan(x('b'));
  });
});

describe('connect', () => {
  it('adds an edge between two nodes', () => {
    const r = connect(wf, 'a', 'b');
    expect(r.error).toBeNull();
    expect(r.wf.edges).toContainEqual({ from: 'a', to: 'b' });
  });

  it('refuses a loop, a duplicate, a self-link and an edge into a trigger', () => {
    expect(connect({ ...wf, edges: [{ from: 'a', to: 'b' }] }, 'b', 'a').error).toMatch(/loop/);
    expect(connect(wf, 't', 'a').error).toMatch(/already/);
    expect(connect(wf, 'a', 'a').error).toMatch(/loop/);
    expect(connect(wf, 'a', 't').error).toMatch(/trigger/);
  });
});

describe('removeNode and addNode', () => {
  it('removes a node with every edge that touched it', () => {
    expect(removeNode(wf, 'a')).toEqual({ nodes: [wf.nodes[0], wf.nodes[2]], edges: [] });
  });

  it('drops a new node below everything already placed', () => {
    const placed = autoLayout(wf);
    const next = addNode(placed, 'condition', 'c');
    const added = next.nodes[next.nodes.length - 1];
    expect(added.kind).toBe('condition');
    for (const n of placed.nodes) expect(added.y).toBeGreaterThanOrEqual(n.y + NODE_H);
  });
});

describe('parseWorkflow', () => {
  it('round-trips a saved draft', () => {
    const s = sampleWorkflow();
    expect(parseWorkflow(JSON.stringify(s))).toEqual(s);
  });

  it('rejects junk and drafts with malformed nodes, and drops edges to missing nodes', () => {
    expect(parseWorkflow(null)).toBeNull();
    expect(parseWorkflow('{')).toBeNull();
    expect(parseWorkflow('{"nodes":[{"id":1}],"edges":[]}')).toBeNull();
    const ok = parseWorkflow(JSON.stringify({ nodes: [node('a')], edges: [{ from: 'a', to: 'ghost' }] }));
    expect(ok).toEqual({ nodes: [node('a')], edges: [] });
  });
});
