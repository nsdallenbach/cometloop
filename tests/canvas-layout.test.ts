import { describe, expect, it } from 'vitest';
import {
  assignZones,
  CARD_GAP,
  CARD_H,
  CARD_W,
  gridForLayers,
  layerByDependency,
  layoutZone,
  nextZoneOrigin,
  orthoPath,
  routeLink,
  segmentHitsBox,
  ZONE_HEAD,
  ZONE_PAD,
  zoneSize,
  type Box,
} from '../client/src/lib/canvas-layout';

const zone = (id: number, tag: string, cols = 2) => ({ id, tag, x: 40, y: 40, cols });

describe('assignZones', () => {
  it('gives a ticket to the first zone whose tag it carries, in zone order', () => {
    const zones = [zone(1, 'board'), zone(2, 'bug')];
    const tickets = [
      { key: 'A', tags: ['bug', 'board'] },
      { key: 'B', tags: ['bug'] },
      { key: 'C', tags: [] },
    ];
    const { byZone, loose } = assignZones(tickets, zones);
    expect(byZone.get(1)).toEqual(['A']);
    expect(byZone.get(2)).toEqual(['B']);
    expect(loose).toEqual(['C']);
  });

  it('keeps every zone present even when empty', () => {
    const { byZone } = assignZones([], [zone(7, 'docs')]);
    expect(byZone.get(7)).toEqual([]);
  });
});

describe('layerByDependency', () => {
  it('puts blockers before what they block', () => {
    expect(layerByDependency(['B', 'A', 'C'], [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }])).toEqual([['A'], ['B'], ['C']]);
  });

  it('keeps input order inside a layer and ignores links to keys outside the set', () => {
    const layers = layerByDependency(['X', 'Y', 'Z'], [{ from: 'X', to: 'Y' }, { from: 'X', to: 'Z' }, { from: 'Q', to: 'Y' }]);
    expect(layers).toEqual([['X'], ['Y', 'Z']]);
  });

  it('breaks a cycle at its earliest member so nothing is dropped', () => {
    const layers = layerByDependency(['A', 'B'], [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]);
    expect(layers.flat().sort()).toEqual(['A', 'B']);
    expect(layers[0]).toEqual(['A']);
  });

  it('is a single layer with no links', () => {
    expect(layerByDependency(['A', 'B'], [])).toEqual([['A', 'B']]);
  });
});

describe('gridForLayers', () => {
  it('lays one layer out row-major', () => {
    expect(gridForLayers([['A', 'B', 'C']], 2)).toEqual([
      { key: 'A', col: 0, row: 0 },
      { key: 'B', col: 1, row: 0 },
      { key: 'C', col: 0, row: 1 },
    ]);
  });

  it('uses one column per layer when the layers fit', () => {
    expect(gridForLayers([['A'], ['B', 'C']], 2)).toEqual([
      { key: 'A', col: 0, row: 0 },
      { key: 'B', col: 1, row: 0 },
      { key: 'C', col: 1, row: 1 },
    ]);
  });

  it('flattens in dependency order when there are more layers than columns', () => {
    expect(gridForLayers([['A'], ['B'], ['C']], 2).map((c) => c.key)).toEqual(['A', 'B', 'C']);
    expect(gridForLayers([['A'], ['B'], ['C']], 2)[2]).toEqual({ key: 'C', col: 0, row: 1 });
  });
});

describe('layoutZone', () => {
  it('sizes the zone to its columns and rows and places cards inside the padding', () => {
    const { box, cards } = layoutZone(zone(1, 'agents', 2), ['A', 'B', 'C'], [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }]);
    expect(box).toEqual({ x: 40, y: 40, ...zoneSize(2, 2) });
    expect(cards.get('A')).toEqual({ x: 40 + ZONE_PAD, y: 40 + ZONE_HEAD, w: CARD_W, h: CARD_H });
    expect(cards.get('C')).toEqual({ x: 40 + ZONE_PAD + CARD_W + CARD_GAP, y: 40 + ZONE_HEAD + CARD_H + CARD_GAP, w: CARD_W, h: CARD_H });
  });

  it('is one row tall when empty', () => {
    expect(layoutZone(zone(1, 'x', 1), [], []).box.h).toBe(zoneSize(1, 1).h);
  });
});

describe('nextZoneOrigin', () => {
  it('starts at the margin on an empty canvas and stacks below existing boxes', () => {
    expect(nextZoneOrigin([])).toEqual({ x: 40, y: 40 });
    expect(nextZoneOrigin([{ x: 40, y: 40, w: 100, h: 100 }, { x: 300, y: 60, w: 50, h: 200 }])).toEqual({ x: 40, y: 284 });
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

  it('joins side by side cards with a straight line', () => {
    expect(routeLink(a, b, [a, b])).toEqual([[100, 25], [200, 25]]);
  });

  it('detours around a card sitting on the direct route', () => {
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
