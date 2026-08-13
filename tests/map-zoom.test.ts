import { describe, expect, it } from 'vitest';
import {
  BUTTON_STEP,
  clampPan,
  clampScale,
  DEFAULT_VIEW,
  distance,
  isAtMax,
  isAtMin,
  MAX_SCALE,
  MIN_SCALE,
  scalePercent,
  viewChanged,
  wheelScaleFactor,
  zoomByPinch,
  zoomByStep,
  zoomByWheel,
  zoomToPoint,
  type Point,
  type Size,
  type View,
} from '../client/src/lib/map-zoom';

const VIEWPORT: Size = { width: 1000, height: 600 };

/** Where a content-space point lands in the viewport under a given view. */
function project(view: View, content: Point): Point {
  return { x: content.x * view.scale + view.x, y: content.y * view.scale + view.y };
}

/** Inverse of `project` — the content point currently under a viewport point. */
function unproject(view: View, screen: Point): Point {
  return { x: (screen.x - view.x) / view.scale, y: (screen.y - view.y) / view.scale };
}

describe('clampScale', () => {
  it('holds values inside the bounds untouched', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(2)).toBe(2);
  });

  it('pins values outside the bounds to the limit', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(50)).toBe(MAX_SCALE);
  });

  it('falls back to the default for any non-finite input', () => {
    // NaN/Infinity mean the caller's arithmetic went wrong; snapping back to
    // 100% is recoverable, whereas propagating them would wedge the transform.
    expect(clampScale(Number.NaN)).toBe(DEFAULT_VIEW.scale);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(DEFAULT_VIEW.scale);
    expect(clampScale(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_VIEW.scale);
  });

  it('reports the bounds', () => {
    expect(isAtMin(MIN_SCALE)).toBe(true);
    expect(isAtMin(1)).toBe(false);
    expect(isAtMax(MAX_SCALE)).toBe(true);
    expect(isAtMax(1)).toBe(false);
  });
});

describe('scalePercent', () => {
  it('renders whole percentages', () => {
    expect(scalePercent(1)).toBe('100%');
    expect(scalePercent(0.4)).toBe('40%');
    expect(scalePercent(1.334)).toBe('133%');
  });
});

describe('wheelScaleFactor', () => {
  it('magnifies on scroll up and shrinks on scroll down', () => {
    expect(wheelScaleFactor(-100)).toBeGreaterThan(1);
    expect(wheelScaleFactor(100)).toBeLessThan(1);
  });

  it('is a no-op for zero or non-finite deltas', () => {
    expect(wheelScaleFactor(0)).toBe(1);
    expect(wheelScaleFactor(Number.NaN)).toBe(1);
  });

  it('is symmetric, so a notch back undoes a notch forward', () => {
    expect(wheelScaleFactor(-120) * wheelScaleFactor(120)).toBeCloseTo(1, 10);
  });

  it('treats trackpad pinch deltas as more sensitive than mouse notches', () => {
    expect(wheelScaleFactor(-40, true)).toBeGreaterThan(wheelScaleFactor(-40, false));
  });

  it('caps a single violent delta so one flick cannot cross the whole range', () => {
    expect(wheelScaleFactor(-100000)).toBe(2);
    expect(wheelScaleFactor(100000)).toBe(0.5);
  });
});

describe('zoomToPoint', () => {
  it('keeps the content under the focal point pinned there', () => {
    const view: View = { scale: 1, x: -120, y: 40 };
    const focal: Point = { x: 300, y: 220 };
    const before = unproject(view, focal);
    const after = zoomToPoint(view, 2.2, focal);
    const moved = project(after, before);
    expect(moved.x).toBeCloseTo(focal.x, 8);
    expect(moved.y).toBeCloseTo(focal.y, 8);
  });

  it('pins the focal point when zooming out too', () => {
    const view: View = { scale: 2.5, x: -600, y: -300 };
    const focal: Point = { x: 810, y: 90 };
    const before = unproject(view, focal);
    const after = zoomToPoint(view, 0.8, focal);
    const moved = project(after, before);
    expect(moved.x).toBeCloseTo(focal.x, 8);
    expect(moved.y).toBeCloseTo(focal.y, 8);
  });

  it('clamps to the bound and flags it rather than dropping the gesture', () => {
    const view: View = { scale: 2.5, x: 0, y: 0 };
    const result = zoomToPoint(view, 12, { x: 100, y: 100 });
    expect(result.scale).toBe(MAX_SCALE);
    expect(result.clamped).toBe(true);
    // Even clamped, the focal point stays pinned at the limit scale.
    const before = unproject(view, { x: 100, y: 100 });
    const moved = project(result, before);
    expect(moved.x).toBeCloseTo(100, 8);
  });

  it('is a no-op when already at the requested bound', () => {
    const view: View = { scale: MAX_SCALE, x: -30, y: -20 };
    const result = zoomToPoint(view, MAX_SCALE * 2, { x: 10, y: 10 });
    expect(result.x).toBe(view.x);
    expect(result.y).toBe(view.y);
    expect(result.scale).toBe(MAX_SCALE);
    expect(result.clamped).toBe(true);
  });

  it('leaves the origin alone when the focal point is the origin', () => {
    const result = zoomToPoint({ scale: 1, x: 0, y: 0 }, 2, { x: 0, y: 0 });
    expect(result).toMatchObject({ scale: 2, x: 0, y: 0 });
  });
});

describe('zoomByStep', () => {
  it('steps by the button multiplier around the viewport centre', () => {
    const inResult = zoomByStep(DEFAULT_VIEW, 1, VIEWPORT);
    expect(inResult.scale).toBeCloseTo(BUTTON_STEP, 10);
    const centre = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
    const moved = project(inResult, unproject(DEFAULT_VIEW, centre));
    expect(moved.x).toBeCloseTo(centre.x, 8);
    expect(moved.y).toBeCloseTo(centre.y, 8);
  });

  it('round-trips in and back out to the starting view', () => {
    const zoomed = zoomByStep(DEFAULT_VIEW, 1, VIEWPORT);
    const back = zoomByStep(zoomed, -1, VIEWPORT);
    expect(back.scale).toBeCloseTo(DEFAULT_VIEW.scale, 10);
    expect(back.x).toBeCloseTo(DEFAULT_VIEW.x, 8);
    expect(back.y).toBeCloseTo(DEFAULT_VIEW.y, 8);
  });

  it('cannot be stepped past the bounds however many times it is pressed', () => {
    let view: View = { ...DEFAULT_VIEW };
    for (let i = 0; i < 40; i++) view = zoomByStep(view, 1, VIEWPORT);
    expect(view.scale).toBe(MAX_SCALE);
    for (let i = 0; i < 80; i++) view = zoomByStep(view, -1, VIEWPORT);
    expect(view.scale).toBe(MIN_SCALE);
  });
});

describe('zoomByWheel', () => {
  it('zooms toward the pointer, not the centre', () => {
    const focal: Point = { x: 900, y: 550 };
    const result = zoomByWheel(DEFAULT_VIEW, -200, focal);
    expect(result.scale).toBeGreaterThan(1);
    // Zooming in at the bottom-right pulls the content up and left.
    expect(result.x).toBeLessThan(0);
    expect(result.y).toBeLessThan(0);
    const moved = project(result, unproject(DEFAULT_VIEW, focal));
    expect(moved.x).toBeCloseTo(focal.x, 8);
    expect(moved.y).toBeCloseTo(focal.y, 8);
  });
});

describe('zoomByPinch', () => {
  it('applies the finger-distance ratio to the scale the pinch started at', () => {
    const start: View = { scale: 1.2, x: -10, y: -10 };
    const result = zoomByPinch(start, 1.2, 1.5, { x: 400, y: 300 });
    expect(result.scale).toBeCloseTo(1.8, 10);
  });

  it('ignores a degenerate ratio instead of producing NaN', () => {
    const start: View = { scale: 1.2, x: -10, y: -10 };
    expect(zoomByPinch(start, 1.2, 0, { x: 0, y: 0 })).toMatchObject({ scale: 1.2, x: -10, y: -10 });
    expect(zoomByPinch(start, 1.2, Number.NaN, { x: 0, y: 0 }).scale).toBe(1.2);
  });

  it('keeps the pinch midpoint pinned', () => {
    const start: View = { scale: 1, x: 0, y: 0 };
    // The focal point of a pinch is the midpoint of the two fingers.
    const focal: Point = { x: (200 + 400) / 2, y: (100 + 300) / 2 };
    const result = zoomByPinch(start, 1, 1.75, focal);
    const moved = project(result, unproject(start, focal));
    expect(moved.x).toBeCloseTo(focal.x, 8);
    expect(moved.y).toBeCloseTo(focal.y, 8);
  });
});

describe('clampPan', () => {
  const content: Size = { width: 1600, height: 900 };

  it('leaves a reasonable offset alone', () => {
    const view: View = { scale: 1, x: -200, y: -100 };
    expect(clampPan(view, content, VIEWPORT)).toEqual(view);
  });

  it('stops content wider than the viewport being dragged fully off screen', () => {
    const flung = clampPan({ scale: 1, x: 99999, y: 99999 }, content, VIEWPORT);
    expect(flung.x).toBeLessThan(VIEWPORT.width);
    expect(flung.y).toBeLessThan(VIEWPORT.height);
    const yanked = clampPan({ scale: 1, x: -99999, y: -99999 }, content, VIEWPORT);
    // The far edge may not be pulled inside the near edge (beyond the slack).
    expect(yanked.x + content.width).toBeGreaterThan(0);
    expect(yanked.y + content.height).toBeGreaterThan(0);
  });

  it('accounts for scale when deciding how far the content may travel', () => {
    const zoomedOut = clampPan({ scale: MIN_SCALE, x: -99999, y: 0 }, content, VIEWPORT);
    const zoomedIn = clampPan({ scale: MAX_SCALE, x: -99999, y: 0 }, content, VIEWPORT);
    expect(zoomedIn.x).toBeLessThan(zoomedOut.x);
  });

  it('preserves the scale it was handed', () => {
    expect(clampPan({ scale: 1.75, x: 0, y: 0 }, content, VIEWPORT).scale).toBe(1.75);
  });

  it('is a no-op before the viewport has been measured', () => {
    const view: View = { scale: 1, x: 500, y: 500 };
    expect(clampPan(view, content, { width: 0, height: 0 })).toEqual(view);
  });

  it('recovers from a non-finite offset', () => {
    expect(clampPan({ scale: 1, x: Number.NaN, y: 0 }, content, VIEWPORT).x).toBe(0);
  });
});

describe('geometry helpers', () => {
  it('measures pointer distance', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('detects meaningful view changes and ignores sub-pixel noise', () => {
    const view: View = { scale: 1, x: 0, y: 0 };
    expect(viewChanged(view, { scale: 1, x: 0.2, y: 0.1 })).toBe(false);
    expect(viewChanged(view, { scale: 1, x: 4, y: 0 })).toBe(true);
    expect(viewChanged(view, { scale: 1.02, x: 0, y: 0 })).toBe(true);
  });
});
