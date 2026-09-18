import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { animate, motion, useMotionValue } from 'motion/react';
import { animate as anime, stagger } from 'animejs';
import { mono } from '../util';
import {
  clampPan,
  DEFAULT_VIEW,
  distance,
  isAtMax,
  isAtMin,
  scalePercent,
  viewChanged,
  zoomByPinch,
  zoomByStep,
  zoomByWheel,
  type Point,
  type View,
} from '../lib/map-zoom';

/**
 * A zoom/pan viewport for the agent constellation (DAT-215).
 *
 * Motion owns the transform: `x`/`y`/`scale` are MotionValues written straight
 * into the content layer's `style`, so a zoom never re-renders React — the
 * clusters below can be a hundred nodes deep and the gesture still runs on the
 * compositor. anime.js handles the auxiliary micro-animations (connection-line
 * lift, node-mark pop) once a zoom settles.
 *
 * Gesture split, by what each input should feel like:
 * - mouse wheel notch → discrete, so it animates on a spring toward the target
 * - trackpad pinch (ctrl+wheel) and touch pinch → continuous, so it tracks 1:1
 * - drag → 1:1, with a movement threshold so a pan never opens a node
 *
 * All zooms are pointer-focal: whatever sits under the cursor stays under it.
 */

/** anime.js targets — AgentMap tags its SVG link groups and node marks with these. */
export const MAP_LINKS_CLASS = 'eec-map-links';
export const MAP_MARK_CLASS = 'eec-map-mark';

/** Above this many nodes the per-node pop is skipped; the line lift still runs. */
const MAX_MICRO_MARKS = 96;

/** Quiet period after the last zoom event before the micro-animations fire. */
const SETTLE_MS = 170;

/** Drag distance (px) before a pointer-down becomes a pan instead of a click. */
const PAN_THRESHOLD = 4;

const ZOOM_SPRING = { type: 'spring', visualDuration: 0.34, bounce: 0.12 } as const;
const RESET_SPRING = { type: 'spring', visualDuration: 0.5, bounce: 0.18 } as const;

type Transition = typeof ZOOM_SPRING | typeof RESET_SPRING;

interface CommitOptions {
  /** Spring toward the target (discrete input) vs. set it outright (tracking). */
  animated?: boolean;
  /** Whether this change should trigger the anime.js settle pass. */
  settle?: boolean;
  transition?: Transition;
}

/** Wheel deltas arrive in pixels, lines or pages depending on the device. */
function normalizeWheel(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16;
  if (e.deltaMode === 2) return e.deltaY * 400;
  return e.deltaY;
}

interface Slot {
  id: number;
  x: number;
  y: number;
}

export interface MapViewportProps {
  children: ReactNode;
  minHeight?: number;
  /** Screen-reader name for the surface; the default describes the agent map. */
  ariaLabel?: string;
  /** Bottom-left gesture hint; null hides it. */
  hint?: string | null;
  /** A fixed world size for the content layer (the canvas board); omitted, the
   *  layer is as wide as the host and as tall as its children, with padding. */
  contentSize?: { w: number; h: number };
  /** Called with every committed view, for children that convert pointer
   *  positions into world coordinates (card dragging on the canvas board). */
  onViewChange?: (view: View) => void;
  /** Drop the border and radius when the host already frames the surface. */
  frameless?: boolean;
  /** Where the zoom cluster sits. */
  controls?: 'top-right' | 'bottom-right';
  /** Called on every frame of the live transform (springs included), for a
   *  host that paints something in step with it — the canvas board's dot
   *  grid. Write to the DOM here, never to React state. */
  onTransform?: (x: number, y: number, scale: number) => void;
  /** Host background; 'transparent' lets the parent paint behind the content. */
  background?: string;
}

export function MapViewport({
  children,
  minHeight = 340,
  ariaLabel = 'Agent map — scroll or pinch to zoom, drag to pan, 0 to reset',
  hint = 'SCROLL OR PINCH TO ZOOM · DRAG TO PAN · + − 0',
  contentSize,
  onViewChange,
  frameless = false,
  controls = 'top-right',
  onTransform,
  background = 'var(--bg)',
}: MapViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const zoomInRef = useRef<HTMLButtonElement>(null);
  const zoomOutRef = useRef<HTMLButtonElement>(null);

  const x = useMotionValue(DEFAULT_VIEW.x);
  const y = useMotionValue(DEFAULT_VIEW.y);
  const scale = useMotionValue(DEFAULT_VIEW.scale);

  /** The authoritative logical view — gestures compose against this, not the
   *  animated MotionValues, so rapid input accumulates toward one target. */
  const viewRef = useRef<View>({ ...DEFAULT_VIEW });
  const reduced = useRef(false);
  const onViewChangeRef = useRef(onViewChange);
  useEffect(() => {
    onViewChangeRef.current = onViewChange;
  });
  const onTransformRef = useRef(onTransform);
  useEffect(() => {
    onTransformRef.current = onTransform;
  });
  // The live transform, frame by frame: the MotionValues, not the committed
  // view, so anything painted from this stays in step through a zoom spring.
  useEffect(() => {
    const emit = () => onTransformRef.current?.(x.get(), y.get(), scale.get());
    emit();
    const offs = [x.on('change', emit), y.on('change', emit), scale.on('change', emit)];
    return () => offs.forEach((off) => off());
  }, [x, y, scale]);

  // Cached viewport rect: pointer-move must not force a layout read per event.
  const rect = useRef({ left: 0, top: 0, width: 0, height: 0 });
  const readRect = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const r = host.getBoundingClientRect();
    rect.current.left = r.left;
    rect.current.top = r.top;
    rect.current.width = r.width;
    rect.current.height = r.height;
  }, []);

  const settleTimer = useRef<number | null>(null);
  const busyTimer = useRef<number | null>(null);

  /**
   * `will-change` is set only while the map is actually moving — a permanently
   * promoted layer costs memory on every other tab the console renders.
   */
  const markBusy = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    content.style.willChange = 'transform';
    if (busyTimer.current !== null) window.clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => {
      busyTimer.current = null;
      if (contentRef.current) contentRef.current.style.willChange = 'auto';
    }, 600);
  }, []);

  /** Node/line micro-animations, debounced to the end of a zoom burst. */
  const runSettle = useCallback(() => {
    const host = hostRef.current;
    if (!host || reduced.current) return;
    const links = host.querySelectorAll(`.${MAP_LINKS_CLASS}`);
    if (links.length > 0) {
      anime(links, { opacity: [0.42, 1], duration: 430, delay: stagger(18), ease: 'out(3)' });
    }
    const marks = host.querySelectorAll(`.${MAP_MARK_CLASS}`);
    if (marks.length > 0 && marks.length <= MAX_MICRO_MARKS) {
      anime(marks, { scale: [0.9, 1], duration: 460, delay: stagger(7, { from: 'center' }), ease: 'out(3)' });
    }
  }, []);

  const scheduleSettle = useCallback(() => {
    if (reduced.current) return;
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      runSettle();
    }, SETTLE_MS);
  }, [runSettle]);

  /** Clamp, record, then either spring or snap the MotionValues to the view. */
  const commit = useCallback(
    (next: View, { animated = false, settle = false, transition = ZOOM_SPRING }: CommitOptions = {}) => {
      const host = hostRef.current;
      const content = contentRef.current;
      if (!host || !content) return;
      const view = clampPan(
        next,
        { width: content.offsetWidth, height: content.offsetHeight },
        { width: host.clientWidth, height: host.clientHeight },
      );
      // Sub-pixel noise and pushes against a bound are not worth an animation.
      if (!viewChanged(viewRef.current, view)) return;
      viewRef.current = view;
      onViewChangeRef.current?.(view);
      markBusy();
      if (animated && !reduced.current) {
        void animate(x, view.x, transition);
        void animate(y, view.y, transition);
        void animate(scale, view.scale, transition);
      } else {
        x.set(view.x);
        y.set(view.y);
        scale.set(view.scale);
      }
      if (settle) scheduleSettle();
    },
    [markBusy, scale, scheduleSettle, x, y],
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced.current = query.matches;
    const onChange = () => {
      reduced.current = query.matches;
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Keep the cached rect honest across layout changes.
  useEffect(() => {
    readRect();
    const host = hostRef.current;
    const observer = new ResizeObserver(readRect);
    if (host) observer.observe(host);
    window.addEventListener('resize', readRect);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', readRect);
    };
  }, [readRect]);

  // Live readout + bound affordances, written to the DOM rather than to state:
  // React state here would re-render every cluster on every animation frame.
  // (The dimmed look rides on `:disabled` in index.css, so a parent re-render
  // diffing the style prop cannot undo it.)
  useEffect(() => {
    const write = (value: number) => {
      if (readoutRef.current) readoutRef.current.textContent = scalePercent(value);
      if (zoomInRef.current) zoomInRef.current.disabled = isAtMax(value);
      if (zoomOutRef.current) zoomOutRef.current.disabled = isAtMin(value);
    };
    write(scale.get());
    return scale.on('change', write);
  }, [scale]);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      if (busyTimer.current !== null) window.clearTimeout(busyTimer.current);
    },
    [],
  );

  // Wheel: non-passive (we preventDefault to stop the pane scrolling) and
  // coalesced to one commit per frame, so a high-resolution trackpad cannot
  // queue dozens of animations inside a single paint.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    let notches = 0;
    let pinches = 0;
    const focal: Point = { x: 0, y: 0 };
    const flush = () => {
      frame = 0;
      const pinch = pinches;
      const notch = notches;
      pinches = 0;
      notches = 0;
      if (pinch !== 0) commit(zoomByWheel(viewRef.current, pinch, focal, true), { settle: true });
      if (notch !== 0) commit(zoomByWheel(viewRef.current, notch, focal, false), { animated: true, settle: true });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (frame === 0) readRect();
      focal.x = e.clientX - rect.current.left;
      focal.y = e.clientY - rect.current.top;
      // ctrl+wheel is how both trackpad pinch and browser zoom present here.
      if (e.ctrlKey) pinches += normalizeWheel(e);
      else notches += normalizeWheel(e);
      if (frame === 0) frame = requestAnimationFrame(flush);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      host.removeEventListener('wheel', onWheel);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [commit, readRect]);

  // Two fixed pointer slots rather than a Map: pinch needs exactly two, and
  // mutating slots in place keeps the move handler allocation-free.
  const slotA = useRef<Slot | null>(null);
  const slotB = useRef<Slot | null>(null);
  /** Pinch baseline — finger distance and midpoint at the moment two touched. */
  const pinch = useRef<{ scale: number; dist: number; midX: number; midY: number } | null>(null);
  /** Pan baseline: absolute, so clamping at an edge cannot accumulate drift. */
  const pan = useRef<{ originX: number; originY: number; view: View } | null>(null);
  const dragged = useRef(false);

  const beginPinch = (a: Slot, b: Slot) => {
    pan.current = null;
    pinch.current = {
      scale: viewRef.current.scale,
      dist: Math.max(1, distance(a, b)),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (slotA.current !== null && slotB.current !== null) return; // ignore a third finger
    readRect();
    const slot: Slot = { id: e.pointerId, x: e.clientX - rect.current.left, y: e.clientY - rect.current.top };
    if (slotA.current === null) slotA.current = slot;
    else slotB.current = slot;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (slotA.current !== null && slotB.current !== null) {
      beginPinch(slotA.current, slotB.current);
    } else {
      pan.current = { originX: slot.x, originY: slot.y, view: { ...viewRef.current } };
      dragged.current = false;
      e.currentTarget.style.cursor = 'grabbing';
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const a = slotA.current;
    const b = slotB.current;
    const slot = a?.id === e.pointerId ? a : b?.id === e.pointerId ? b : null;
    if (slot === null) return;
    slot.x = e.clientX - rect.current.left;
    slot.y = e.clientY - rect.current.top;

    if (a !== null && b !== null && pinch.current !== null) {
      const start = pinch.current;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const view = viewRef.current;
      // Two fingers drifting across the screen should carry the map with them,
      // so pan by the midpoint's travel before applying the new scale.
      const base: View = { scale: view.scale, x: view.x + (midX - start.midX), y: view.y + (midY - start.midY) };
      start.midX = midX;
      start.midY = midY;
      const ratio = Math.max(1, distance(a, b)) / start.dist;
      dragged.current = true; // a pinch that ends over a node must not open it
      commit(zoomByPinch(base, start.scale, ratio, { x: midX, y: midY }), { settle: true });
      return;
    }

    const drag = pan.current;
    if (drag === null) return;
    const totalX = slot.x - drag.originX;
    const totalY = slot.y - drag.originY;
    // Measured from the press, not per event — a slow drag of 1px steps must
    // still cross the threshold rather than never registering at all.
    if (!dragged.current && Math.hypot(totalX, totalY) < PAN_THRESHOLD) return;
    dragged.current = true;
    commit({ scale: drag.view.scale, x: drag.view.x + totalX, y: drag.view.y + totalY });
  };

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (slotA.current?.id === e.pointerId) slotA.current = null;
    else if (slotB.current?.id === e.pointerId) slotB.current = null;
    if (slotA.current === null || slotB.current === null) pinch.current = null;
    // A finger lifted from a pinch leaves one down: hand it back to panning
    // rather than stranding the gesture until both are released.
    const remaining = slotA.current ?? slotB.current;
    if (remaining !== null) {
      pan.current = { originX: remaining.x, originY: remaining.y, view: { ...viewRef.current } };
    } else {
      pan.current = null;
      e.currentTarget.style.cursor = 'grab';
    }
    // The click that follows pointerup is swallowed below; clear the flag after
    // it has had its chance, so a drag ending off-node never eats the next click.
    if (dragged.current) {
      window.setTimeout(() => {
        dragged.current = false;
      }, 0);
    }
  };

  /** A pan that ends over a node must not also count as a click on it. */
  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragged.current) return;
    e.stopPropagation();
    e.preventDefault();
  };

  const step = (direction: 1 | -1) => {
    readRect();
    commit(zoomByStep(viewRef.current, direction, { width: rect.current.width, height: rect.current.height }), {
      animated: true,
      settle: true,
    });
  };

  const reset = () => {
    commit({ ...DEFAULT_VIEW }, { animated: true, settle: true, transition: RESET_SPRING });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === '+' || e.key === '=') step(1);
    else if (e.key === '-' || e.key === '_') step(-1);
    else if (e.key === '0') reset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={hostRef}
      tabIndex={0}
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onClickCapture={onClickCapture}
      onKeyDown={onKeyDown}
      style={{
        position: 'relative',
        flex: 1,
        minHeight,
        overflow: 'hidden',
        touchAction: 'none',
        cursor: 'grab',
        border: frameless ? 'none' : '1px solid var(--line)',
        borderRadius: frameless ? 0 : 5,
        background,
        outlineOffset: -2,
      }}
    >
      <motion.div
        ref={contentRef}
        style={
          contentSize
            ? { x, y, scale, transformOrigin: '0 0', position: 'relative', width: contentSize.w, height: contentSize.h }
            : { x, y, scale, transformOrigin: '0 0', width: '100%', padding: '10px 12px 16px' }
        }
      >
        {children}
      </motion.div>

      <ZoomControls
        readoutRef={readoutRef}
        zoomInRef={zoomInRef}
        zoomOutRef={zoomOutRef}
        onIn={() => step(1)}
        onOut={() => step(-1)}
        onReset={reset}
        placement={controls}
      />

      {hint !== null && (
        <div
          style={{
            position: 'absolute',
            left: 10,
            bottom: 8,
            ...mono(400, 8.5),
            color: 'var(--tx3)',
            letterSpacing: '.08em',
            pointerEvents: 'none',
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

const CTRL_BTN: React.CSSProperties = {
  width: 26,
  height: 24,
  display: 'grid',
  placeItems: 'center',
  background: 'var(--bg2)',
  border: '1px solid var(--line2)',
  borderRadius: 3,
  color: 'var(--tx2)',
  cursor: 'pointer',
  padding: 0,
};

function ZoomControls({
  readoutRef,
  zoomInRef,
  zoomOutRef,
  onIn,
  onOut,
  onReset,
  placement,
}: {
  readoutRef: React.RefObject<HTMLSpanElement | null>;
  zoomInRef: React.RefObject<HTMLButtonElement | null>;
  zoomOutRef: React.RefObject<HTMLButtonElement | null>;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
  placement: 'top-right' | 'bottom-right';
}) {
  return (
    <div
      // The controls sit over the map, so their own clicks must not pan it.
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        right: 10,
        ...(placement === 'top-right' ? { top: 10 } : { bottom: 10 }),
        display: 'flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      <button
        ref={zoomOutRef}
        className="hv-border eec-zoom-btn"
        onClick={onOut}
        aria-label="Zoom out"
        title="Zoom out (−)"
        style={{ ...CTRL_BTN, ...mono(500, 13) }}
      >
        −
      </button>
      <span
        ref={readoutRef}
        aria-live="off"
        style={{
          ...mono(500, 9),
          minWidth: 34,
          textAlign: 'center',
          color: 'var(--tx2)',
          letterSpacing: '.06em',
          background: 'var(--bg2)',
          border: '1px solid var(--line2)',
          borderRadius: 3,
          padding: '5px 0',
        }}
      >
        100%
      </span>
      <button
        ref={zoomInRef}
        className="hv-border eec-zoom-btn"
        onClick={onIn}
        aria-label="Zoom in"
        title="Zoom in (+)"
        style={{ ...CTRL_BTN, ...mono(500, 13) }}
      >
        +
      </button>
      <button
        className="hv-border eec-zoom-btn"
        onClick={onReset}
        aria-label="Reset zoom"
        title="Reset the view (0)"
        style={{ ...CTRL_BTN, ...mono(500, 8.5), width: 'auto', padding: '0 8px', letterSpacing: '.08em' }}
      >
        RESET
      </button>
    </div>
  );
}
