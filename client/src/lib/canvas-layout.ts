/**
 * Canvas board geometry (DAT-281), kept pure so it can be unit-tested without
 * the viewport: which zone a ticket belongs to, how a zone lays its cards out
 * in dependency layers, where loose tickets go, and how a link is routed
 * around the cards as an orthogonal line.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Point = [number, number];

export const CARD_W = 250;
export const CARD_H = 136;
export const CARD_GAP = 12;
export const ZONE_PAD = 16;
export const ZONE_HEAD = 30;
export const MIN_COLS = 1;
export const MAX_COLS = 4;

export interface ZoneSpec {
  id: number;
  tag: string;
  x: number;
  y: number;
  cols: number;
}

export interface Dependency {
  from: string;
  to: string;
}

/** Zone box for a column count and the rows its cards need. */
export function zoneSize(cols: number, rows: number): { w: number; h: number } {
  const c = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
  const r = Math.max(1, rows);
  return { w: ZONE_PAD * 2 + c * CARD_W + (c - 1) * CARD_GAP, h: ZONE_HEAD + r * CARD_H + (r - 1) * CARD_GAP + ZONE_PAD };
}

/**
 * The first zone (in zone order) whose tag a ticket carries owns it; a ticket
 * with no zoned tag is loose. Returns zone id → keys plus the loose keys, all
 * in the input order of `tickets`.
 */
export function assignZones<T extends { key: string; tags: string[] }>(
  tickets: T[],
  zones: ZoneSpec[],
): { byZone: Map<number, string[]>; loose: string[] } {
  const byZone = new Map<number, string[]>(zones.map((z) => [z.id, []]));
  const loose: string[] = [];
  for (const t of tickets) {
    const zone = zones.find((z) => t.tags.includes(z.tag));
    if (zone) byZone.get(zone.id)?.push(t.key);
    else loose.push(t.key);
  }
  return { byZone, loose };
}

/**
 * Dependency layers among `keys`: layer 0 holds keys nothing in the set
 * blocks, layer 1 what layer 0 blocks, and so on (Kahn's algorithm). Keys
 * keep their input order inside a layer. A cycle is broken at its
 * earliest-input member so every key lands somewhere.
 */
export function layerByDependency(keys: string[], blocks: Dependency[]): string[][] {
  const inSet = new Set(keys);
  const edges = blocks.filter((e) => e.from !== e.to && inSet.has(e.from) && inSet.has(e.to));
  const indegree = new Map<string, number>(keys.map((k) => [k, 0]));
  const out = new Map<string, string[]>(keys.map((k) => [k, []]));
  const seen = new Set<string>();
  for (const e of edges) {
    const id = `${e.from}>${e.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.get(e.from)?.push(e.to);
  }
  const layers: string[][] = [];
  const remaining = new Set(keys);
  let frontier = keys.filter((k) => indegree.get(k) === 0);
  while (remaining.size > 0) {
    if (frontier.length === 0) {
      // Every remaining key is inside a cycle: start the next layer with the
      // earliest one and let the rest fall out behind it.
      const first = keys.find((k) => remaining.has(k));
      if (first === undefined) break;
      frontier = [first];
    }
    const layer = frontier.filter((k) => remaining.has(k));
    layers.push(layer);
    const next: string[] = [];
    for (const k of layer) {
      remaining.delete(k);
      for (const to of out.get(k) ?? []) {
        indegree.set(to, (indegree.get(to) ?? 1) - 1);
        if (indegree.get(to) === 0 && remaining.has(to)) next.push(to);
      }
    }
    frontier = keys.filter((k) => next.includes(k));
  }
  return layers;
}

/**
 * Card grid for a zone. One layer: a plain row-major grid. Up to `cols`
 * layers: one column per layer, blockers left. More layers than columns: the
 * layers flatten in order into a row-major grid, so blockers still come
 * first reading left to right, top to bottom.
 */
export function gridForLayers(layers: string[][], cols: number): { key: string; col: number; row: number }[] {
  const c = Math.max(MIN_COLS, Math.min(MAX_COLS, cols));
  const cells: { key: string; col: number; row: number }[] = [];
  if (layers.length > 1 && layers.length <= c) {
    layers.forEach((layer, col) => layer.forEach((key, row) => cells.push({ key, col, row })));
    return cells;
  }
  layers.flat().forEach((key, i) => cells.push({ key, col: i % c, row: Math.floor(i / c) }));
  return cells;
}

/** A zone's box and the boxes of its cards, in world coordinates. */
export function layoutZone(zone: ZoneSpec, keys: string[], blocks: Dependency[]): { box: Box; cards: Map<string, Box> } {
  const cells = gridForLayers(layerByDependency(keys, blocks), zone.cols);
  const rows = cells.reduce((m, c) => Math.max(m, c.row + 1), 0);
  const size = zoneSize(zone.cols, rows);
  const cards = new Map<string, Box>();
  for (const c of cells) {
    cards.set(c.key, {
      x: zone.x + ZONE_PAD + c.col * (CARD_W + CARD_GAP),
      y: zone.y + ZONE_HEAD + c.row * (CARD_H + CARD_GAP),
      w: CARD_W,
      h: CARD_H,
    });
  }
  return { box: { x: zone.x, y: zone.y, w: size.w, h: size.h }, cards };
}

/** Loose tickets sit in a row-major grid starting at (x, y). */
export function layoutLoose(keys: string[], x: number, y: number, cols = 4): Map<string, Box> {
  const cards = new Map<string, Box>();
  keys.forEach((key, i) => {
    cards.set(key, { x: x + (i % cols) * (CARD_W + CARD_GAP), y: y + Math.floor(i / cols) * (CARD_H + CARD_GAP), w: CARD_W, h: CARD_H });
  });
  return cards;
}

/** Where a new zone goes: under everything already on the canvas. */
export function nextZoneOrigin(boxes: Box[], margin = 40): { x: number; y: number } {
  if (boxes.length === 0) return { x: margin, y: margin };
  const bottom = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  return { x: margin, y: bottom + 24 };
}

/** The world's extent: everything plus a margin, never smaller than the viewport wants. */
export function worldSize(boxes: Box[], margin = 40): { w: number; h: number } {
  const right = boxes.reduce((m, b) => Math.max(m, b.x + b.w), 0);
  const bottom = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  return { w: right + margin, h: bottom + margin };
}

// ---------------------------------------------------------------------------
// Link routing

/** Orthogonal polyline with rounded corners, as an SVG path. */
export function orthoPath(pts: Point[], r = 8): string {
  const f = (n: number) => Number(n.toFixed(1));
  if (pts.length === 0) return '';
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(cx - px, cy - py);
    const l2 = Math.hypot(nx - cx, ny - cy);
    if (l1 === 0 || l2 === 0) continue;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    d += ` L ${f(cx - ((cx - px) / l1) * rr)} ${f(cy - ((cy - py) / l1) * rr)} Q ${f(cx)} ${f(cy)} ${f(cx + ((nx - cx) / l2) * rr)} ${f(cy + ((ny - cy) / l2) * rr)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L ${f(last[0])} ${f(last[1])}`;
}

/** Smooth curve between the facing edges of two boxes — the agent-traffic idiom. */
export function curvePath(a: Box, b: Box, bend = 0): { d: string; mid: Point } {
  let p1: Point, p2: Point, c1: Point, c2: Point;
  if (b.x >= a.x + a.w - 20) {
    p1 = [a.x + a.w, a.y + a.h / 2];
    p2 = [b.x, b.y + b.h / 2];
    const d = Math.max(48, (p2[0] - p1[0]) / 2);
    c1 = [p1[0] + d, p1[1] + bend];
    c2 = [p2[0] - d, p2[1] + bend];
  } else if (b.x + b.w <= a.x + 20) {
    p1 = [a.x, a.y + a.h / 2];
    p2 = [b.x + b.w, b.y + b.h / 2];
    const d = Math.max(48, (p1[0] - p2[0]) / 2);
    c1 = [p1[0] - d, p1[1] + bend];
    c2 = [p2[0] + d, p2[1] + bend];
  } else if (b.y >= a.y) {
    p1 = [a.x + a.w / 2, a.y + a.h];
    p2 = [b.x + b.w / 2, b.y];
    const d = Math.max(28, (p2[1] - p1[1]) / 2);
    c1 = [p1[0] + bend, p1[1] + d];
    c2 = [p2[0] + bend, p2[1] - d];
  } else {
    p1 = [a.x + a.w / 2, a.y];
    p2 = [b.x + b.w / 2, b.y + b.h];
    const d = Math.max(28, (p1[1] - p2[1]) / 2);
    c1 = [p1[0] + bend, p1[1] - d];
    c2 = [p2[0] + bend, p2[1] + d];
  }
  const mid: Point = [
    0.125 * p1[0] + 0.375 * c1[0] + 0.375 * c2[0] + 0.125 * p2[0],
    0.125 * p1[1] + 0.375 * c1[1] + 0.375 * c2[1] + 0.125 * p2[1],
  ];
  return { d: `M ${p1[0]} ${p1[1]} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`, mid };
}

/** Whether an axis-aligned segment passes through a box (touching its edge does not count). */
export function segmentHitsBox(p: Point, q: Point, b: Box, inset = 1): boolean {
  const x0 = Math.min(p[0], q[0]);
  const x1 = Math.max(p[0], q[0]);
  const y0 = Math.min(p[1], q[1]);
  const y1 = Math.max(p[1], q[1]);
  return x0 < b.x + b.w - inset && x1 > b.x + inset && y0 < b.y + b.h - inset && y1 > b.y + inset;
}

function routeHits(pts: Point[], obstacles: Box[]): number {
  let hits = 0;
  for (let i = 1; i < pts.length; i++) {
    for (const o of obstacles) if (segmentHitsBox(pts[i - 1], pts[i], o)) hits++;
  }
  return hits;
}

/**
 * An orthogonal route from `a` to `b` that avoids `obstacles` where it can:
 * the direct nearest-edge route first, then detours over, under and around.
 * When every candidate crosses something, the direct route wins — a line
 * behind a card beats a line looping off the canvas.
 */
export function routeLink(a: Box, b: Box, obstacles: Box[], clearance = 24): Point[] {
  const others = obstacles.filter((o) => o !== a && o !== b);
  const am: Point = [a.x + a.w / 2, a.y + a.h / 2];
  const bm: Point = [b.x + b.w / 2, b.y + b.h / 2];
  const top = Math.min(a.y, b.y) - clearance;
  const bottom = Math.max(a.y + a.h, b.y + b.h) + clearance;
  const left = Math.min(a.x, b.x) - clearance;
  const right = Math.max(a.x + a.w, b.x + b.w) + clearance;
  const candidates: Point[][] = [];
  if (b.x >= a.x + a.w) {
    const mx = (a.x + a.w + b.x) / 2;
    candidates.push(Math.abs(am[1] - bm[1]) < 2 ? [[a.x + a.w, am[1]], [b.x, bm[1]]] : [[a.x + a.w, am[1]], [mx, am[1]], [mx, bm[1]], [b.x, bm[1]]]);
    candidates.push([[am[0], a.y + a.h], [am[0], bm[1]], [b.x, bm[1]]]);
    candidates.push([[am[0], a.y], [am[0], bm[1]], [b.x, bm[1]]]);
  } else if (b.x + b.w <= a.x) {
    const mx = (b.x + b.w + a.x) / 2;
    candidates.push(Math.abs(am[1] - bm[1]) < 2 ? [[a.x, am[1]], [b.x + b.w, bm[1]]] : [[a.x, am[1]], [mx, am[1]], [mx, bm[1]], [b.x + b.w, bm[1]]]);
    candidates.push([[am[0], a.y + a.h], [am[0], bm[1]], [b.x + b.w, bm[1]]]);
    candidates.push([[am[0], a.y], [am[0], bm[1]], [b.x + b.w, bm[1]]]);
  } else if (b.y >= a.y + a.h) {
    const my = (a.y + a.h + b.y) / 2;
    candidates.push(Math.abs(am[0] - bm[0]) < 2 ? [[am[0], a.y + a.h], [bm[0], b.y]] : [[am[0], a.y + a.h], [am[0], my], [bm[0], my], [bm[0], b.y]]);
  } else {
    const my = (b.y + b.h + a.y) / 2;
    candidates.push(Math.abs(am[0] - bm[0]) < 2 ? [[am[0], a.y], [bm[0], b.y + b.h]] : [[am[0], a.y], [am[0], my], [bm[0], my], [bm[0], b.y + b.h]]);
  }
  // Detours: over the top, under the bottom, around the right, around the left.
  candidates.push([[am[0], a.y], [am[0], top], [bm[0], top], [bm[0], b.y]]);
  candidates.push([[am[0], a.y + a.h], [am[0], bottom], [bm[0], bottom], [bm[0], b.y + b.h]]);
  candidates.push([[a.x + a.w, am[1]], [right, am[1]], [right, bm[1]], [b.x + b.w, bm[1]]]);
  candidates.push([[a.x, am[1]], [left, am[1]], [left, bm[1]], [b.x, bm[1]]]);
  let best = candidates[0];
  let bestHits = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const hits = routeHits(c, others);
    if (hits === 0) return c;
    if (hits < bestHits) {
      bestHits = hits;
      best = c;
    }
  }
  return best;
}
