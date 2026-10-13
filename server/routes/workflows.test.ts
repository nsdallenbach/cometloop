import { describe, expect, it } from 'vitest';
import { graphProblem, type WorkflowGraph } from './workflows';

const node = (id: string, kind: WorkflowGraph['nodes'][number]['kind'] = 'action') => ({ id, kind, type: '', config: {}, title: id, detail: '', x: 0, y: 0 });
const graph = (edges: WorkflowGraph['edges'], nodes = [node('t', 'trigger'), node('a'), node('b'), node('c')]): WorkflowGraph => ({ nodes, edges });

describe('graphProblem', () => {
  it('accepts a branching one-way graph, and an empty one', () => {
    expect(graphProblem(graph([{ from: 't', to: 'a' }, { from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'c' }]))).toBeNull();
    expect(graphProblem({ nodes: [], edges: [] })).toBeNull();
  });

  it('refuses a loop, however long', () => {
    expect(graphProblem(graph([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]))).toMatch(/loops back/);
  });

  it('refuses a connection to a node that is not there', () => {
    expect(graphProblem(graph([{ from: 'a', to: 'ghost' }]))).toMatch(/not in the workflow/);
  });

  it('refuses a self-link, a repeated connection and an edge into a trigger', () => {
    expect(graphProblem(graph([{ from: 'a', to: 'a' }]))).toMatch(/itself/);
    expect(graphProblem(graph([{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }]))).toMatch(/twice/);
    expect(graphProblem(graph([{ from: 'a', to: 't' }]))).toMatch(/trigger/);
  });

  it('refuses duplicate node ids', () => {
    expect(graphProblem(graph([], [node('a'), node('a')]))).toMatch(/share the id/);
  });
});
