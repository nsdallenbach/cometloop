import { describe, expect, it } from 'vitest';
import { layerByDependency, orthoPath, routeLink, segmentHitsBox, worldSize, type Box } from '../client/src/lib/canvas-layout';

describe('layerByDependency', () => {
  it('puts upstream nodes before what they feed', () => {
    expect(layerByDependency(['B', 'A', 'C'], [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])).toEqual([['A'], ['B'], ['C']]);
  });

  it('keeps input order inside a layer and ignores edges to keys outside the set', () => {
    const layers = layerByDependency(['X', 'Y', 'Z'], [{ from: 'X', to: 'Y' }, { from: 'X', to: 'Z' }, { from: 'Q', to: 'Y' }]);
    expect(layers).toEqual([['X'], ['Y', 'Z']]);
  });

  it('breaks a cycle at its earliest member so nothing is dropped', () => {
    const layers = layerByDependency(['A', 'B'], [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]);
    expect(layers.flat().sort()).toEqual(['A', 'B']);
    expect(layers[0]).toEqual(['A']);
  });

  it('is a single layer with no edges', () => {
    expect(layerByDependency(['A', 'B'], [])).toEqual([['A', 'B']]);
  });
});

describe('worldSize', () => {
  it('covers every box plus the margin', () => {
    expect(worldSize([{ x: 40, y: 40, w: 100, h: 100 }, { x: 300, y: 60, w: 50, h: 200 }])).toEqual({ w: 390, h: 300 });
  });
});

describe('orthoPath', () => {
  it('draws straight lines without corners', () => {
    expect(orthoPath([[0, 0], [10, 0]])).toBe('M 0 0 L 10 0');
  });

  it('rounds each corner with a quadratic curve', () => {
    expect(orthoPath([[0, 0], [20, 0], [20, 20]], 4)).toBe('M 0 0 L 16 0 Q 20 0 20 4 L 20 20');
  });
});

describe('segmentHitsBox', () => {
  const box: Box = { x: 10, y: 10, w: 20, h: 20 };
  it('detects a segment crossing the box interior', () => {
    expect(segmentHitsBox([0, 20], [40, 20], box)).toBe(true);
  });
  it('ignores a segment that only touches an edge', () => {
    expect(segmentHitsBox([0, 10], [40, 10], box)).toBe(false);
  });
});

describe('routeLink', () => {
  const a: Box = { x: 0, y: 0, w: 100, h: 50 };
  const b: Box = { x: 200, y: 0, w: 100, h: 50 };

  it('joins side by side boxes with a straight line', () => {
    expect(routeLink(a, b, [a, b])).toEqual([[100, 25], [200, 25]]);
  });

  it('detours around a box sitting on the direct route', () => {
    const blocker: Box = { x: 120, y: 0, w: 60, h: 50 };
    const route = routeLink(a, b, [a, b, blocker]);
    for (let i = 1; i < route.length; i++) expect(segmentHitsBox(route[i - 1], route[i], blocker)).toBe(false);
    expect(route[0]).not.toEqual([100, 25]);
  });

  it('falls back to the direct route when nothing is clear', () => {
    const wall: Box = { x: -1000, y: -1000, w: 3000, h: 3000 };
    expect(routeLink(a, b, [a, b, wall])).toEqual([[100, 25], [200, 25]]);
  });
});
