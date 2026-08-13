/**
 * Zoom/pan math for the agent map viewport (DAT-215).
 *
 * Kept pure and DOM-free so the geometry is unit-testable — the component
 * (`components/MapViewport.tsx`) owns the Motion values, event plumbing and
 * anime.js micro-animations, and calls in here for every number it needs.
 *
 * Model: the content layer is transformed as `translate(x, y) scale(scale)`
 * with `transform-origin: 0 0`. That makes the mapping content → viewport a
 * plain affine one, so a content point `c` lands at `c * scale + x`, and the
 * focal-point identity below is exact rather than approximate.
 */

export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 2.75;

/** Reset target: the layout as it rendered before anyone touched the map. */
export const DEFAULT_VIEW: View = { scale: 1, x: 0, y: 0 };

/** Per-click multiplier for the +/- buttons and the keyboard shortcuts. */
export const BUTTON_STEP = 1.3;

/**
 * Wheel sensitivity. Deltas are exponentiated rather than added so a notch
 * feels the same at 0.5x as it does at 2x — additive steps crawl when zoomed
 * out and lurch when zoomed in.
 */
const WHEEL_SENSITIVITY = 0.0016;
/** Trackpad pinch (ctrl+wheel) reports much larger deltas than a mouse notch. */
const PINCH_SENSITIVITY = 0.008;

/** How far the content may be dragged past the viewport edge, as a fraction. */
const OVERSCROLL = 0.35;

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return DEFAULT_VIEW.scale;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function isAtMin(scale: number): boolean {
  return scale <= MIN_SCALE + 1e-6;
}

export function isAtMax(scale: number): boolean {
  return scale >= MAX_SCALE - 1e-6;
}

/** `1.0` → `100%`, for the readout between the zoom buttons. */
export function scalePercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * A wheel/pinch delta as a scale multiplier. Negative `deltaY` (scroll up /
 * pinch open) magnifies. Clamped per event so one violent trackpad flick or a
 * `deltaMode`-in-pages mouse cannot jump the whole zoom range at once.
 */
export function wheelScaleFactor(deltaY: number, pinch = false): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const sensitivity = pinch ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY;
  const factor = Math.exp(-deltaY * sensitivity);
  return Math.min(2, Math.max(0.5, factor));
}

export interface ZoomResult extends View {
  /** True when the requested scale was outside the bounds and got clamped. */
  clamped: boolean;
}

/**
 * Zoom toward `focal` (a point in *viewport* coordinates, i.e. relative to the
 * viewport's top-left) instead of toward the origin: solve for the translation
 * that keeps whatever content sits under the pointer sitting under it after
 * the scale change.
 *
 * Out-of-bounds requests still return a usable view — the scale pins to the
 * limit and `clamped` is set, so the caller animates to the bound rather than
 * dropping the gesture on the floor.
 */
export function zoomToPoint(view: View, nextScale: number, focal: Point): ZoomResult {
  const scale = clampScale(nextScale);
  const clamped = Math.abs(scale - nextScale) > 1e-6;
  if (scale === view.scale) return { ...view, clamped };
  // Content point currently under the focal point, then re-projected at the
  // new scale: focal = c * scale + x  =>  x = focal - c * scale.
  const ratio = scale / view.scale;
  return {
    scale,
    x: focal.x - (focal.x - view.x) * ratio,
    y: focal.y - (focal.y - view.y) * ratio,
    clamped,
  };
}

/** A +/- button or keyboard step, anchored on the viewport centre. */
export function zoomByStep(view: View, direction: 1 | -1, viewport: Size): ZoomResult {
  const next = direction > 0 ? view.scale * BUTTON_STEP : view.scale / BUTTON_STEP;
  return zoomToPoint(view, next, { x: viewport.width / 2, y: viewport.height / 2 });
}

/** A wheel notch or pinch delta, anchored on the pointer. */
export function zoomByWheel(view: View, deltaY: number, focal: Point, pinch = false): ZoomResult {
  return zoomToPoint(view, view.scale * wheelScaleFactor(deltaY, pinch), focal);
}

/**
 * Two-pointer pinch: `ratio` is current finger distance over the distance when
 * the gesture started, applied to the scale the gesture started from.
 */
export function zoomByPinch(view: View, startScale: number, ratio: number, focal: Point): ZoomResult {
  if (!Number.isFinite(ratio) || ratio <= 0) return { ...view, clamped: false };
  return zoomToPoint(view, startScale * ratio, focal);
}

/**
 * Keep the content reachable. The scaled content may be smaller or larger than
 * the viewport, so bounds are derived from the overflow in each axis and then
 * loosened by `OVERSCROLL` — enough slack to feel elastic, not enough to fling
 * the constellation off the screen and lose it.
 */
export function clampPan(view: View, content: Size, viewport: Size): View {
  return {
    scale: view.scale,
    x: clampAxis(view.x, content.width * view.scale, viewport.width),
    y: clampAxis(view.y, content.height * view.scale, viewport.height),
  };
}

function clampAxis(offset: number, scaled: number, available: number): number {
  if (!Number.isFinite(offset)) return 0;
  if (!(available > 0) || !(scaled > 0)) return offset;
  const slack = available * OVERSCROLL;
  // Content narrower than the viewport: it may sit anywhere inside, plus slack.
  // Content wider: the far edge must not be dragged inside the near edge.
  const min = Math.min(0, available - scaled) - slack;
  const max = Math.max(0, available - scaled) + slack;
  return Math.min(max, Math.max(min, offset));
}

/** Straight-line distance between two pointers — the basis of a pinch ratio. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** True when the two views differ enough to be worth animating to. */
export function viewChanged(a: View, b: View): boolean {
  return Math.abs(a.scale - b.scale) > 1e-4 || Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5;
}
