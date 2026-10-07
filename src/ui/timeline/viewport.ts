import { effectiveDuration } from "../../core/time";
import { clampZoom, MAX_ZOOM, MIN_ZOOM } from "../../core/zoom";
import { playback } from "../../engine/PlaybackEngine";
import { selectedClips, useEditor } from "../../store/editorStore";
import { HEADER_W } from "./geometry";

/**
 * Timeline viewport: zoom and scroll behaviour.
 *
 * Lives outside the component so the keyboard shortcuts in the app shell drive
 * exactly the same code path as the toolbar buttons, instead of a second
 * implementation that drifts.
 */

/** Re-exported so callers have one import site for the zoom range. */
export { clampZoom, MAX_ZOOM, MIN_ZOOM };

let viewport: HTMLElement | null = null;

let userScrolledAt = 0;

/** True if the user has scrolled the timeline recently (within 800ms). */
export function isUserScrolling(): boolean {
  return Date.now() - userScrolledAt < 800;
}

export function registerTimelineViewport(element: HTMLElement | null): void {
  viewport = element;
}

/** Grid-space x of a time, i.e. its offset inside the scrollable content. */
export function gridXForTime(time: number, zoom: number): number {
  return HEADER_W + time * zoom;
}

/** Applies a zoom, then restores the focus time to its previous screen position. */
function applyZoom(next: number, focusTime: number, focusScreen: number): void {
  useEditor.getState().setZoom(next);
  if (!viewport) return;
  // The scroll range changes with the content width, so adjust after layout.
  requestAnimationFrame(() => {
    if (!viewport) return;
    viewport.scrollLeft = Math.max(0, gridXForTime(focusTime, next) - focusScreen);
  });
}

/**
 * Zooms about the playhead, falling back to the viewport centre when the
 * playhead is off screen. Zooming about a fixed point is what makes repeated
 * zooming usable — otherwise the view drifts away from what the user was
 * looking at.
 */
export function zoomTimeline(factor: number): void {
  const store = useEditor.getState();
  const zoom = store.zoom;
  const next = clampZoom(zoom * factor);
  if (next === zoom) return;
  if (!viewport) {
    store.setZoom(next);
    return;
  }

  const clientWidth = viewport.clientWidth;
  const centre = HEADER_W + (clientWidth - HEADER_W) / 2;
  const playheadScreen = gridXForTime(playback.time, zoom) - viewport.scrollLeft;
  const focusScreen =
    playheadScreen >= HEADER_W && playheadScreen <= clientWidth ? playheadScreen : centre;
  const focusTime = (focusScreen + viewport.scrollLeft - HEADER_W) / zoom;

  applyZoom(next, focusTime, focusScreen);
}

/** Fits the whole project in the viewport. */
export function fitTimeline(): void {
  const store = useEditor.getState();
  const width = viewport?.clientWidth ?? 1200;
  const duration = effectiveDuration(store.project);
  store.setZoom(clampZoom((width - HEADER_W - 24) / Math.max(1, duration)));
}

/**
 * Zooms about a screen x rather than the playhead.
 *
 * Wheel zoom has to keep the moment under the cursor fixed, otherwise the view
 * slides away from whatever the pointer is on.
 */
export function zoomTimelineAt(factor: number, clientX: number): void {
  const store = useEditor.getState();
  const zoom = store.zoom;
  const next = clampZoom(zoom * factor);
  if (next === zoom) return;
  if (!viewport) {
    store.setZoom(next);
    return;
  }

  const rect = viewport.getBoundingClientRect();
  // Clamp into the grid area: the header does not scroll with the content, so a
  // focus point behind it would compute a nonsense time.
  const focusScreen = Math.max(
    HEADER_W + 1,
    Math.min(viewport.clientWidth, clientX - rect.left),
  );
  const focusTime = (focusScreen + viewport.scrollLeft - HEADER_W) / zoom;
  applyZoom(next, focusTime, focusScreen);
}

/* ------------------------------------------------------------------ *
 * Drag auto-scroll
 * ------------------------------------------------------------------ */

/** How close to an edge, in pixels, a drag starts scrolling. */
const AUTOSCROLL_EDGE = 46;
/** Pixels per tick at the very edge. */
const AUTOSCROLL_MAX = 22;

/** The scroll container, for callers that need its live scroll position. */
export function timelineViewport(): HTMLElement | null {
  return viewport;
}

/**
 * Pointer travel converted to a time delta, corrected for view scrolling.
 *
 * A drag's delta is not just pointer movement: if the timeline scrolls
 * underneath (auto-scroll at an edge, or a wheel event mid-drag) the content
 * moves while the pointer does not, and a naive delta makes the clip stay put
 * while the timeline slides away from it.
 */
export function dragDeltaTime(options: {
  clientX: number;
  startX: number;
  startScrollLeft: number;
  scrollLeft: number;
  zoom: number;
}): number {
  const travel = options.clientX - options.startX + (options.scrollLeft - options.startScrollLeft);
  return travel / Math.max(1e-6, options.zoom);
}

/**
 * How much to scroll while a drag sits near an edge of the timeline.
 *
 * Positive scrolls right. Without this, trimming a clip past the right edge means
 * letting go, scrolling, and grabbing the handle again.
 *
 * The left edge is measured from the end of the header column: the header does
 * not scroll with the content, so scrolling there would be surprising.
 */
export function autoscrollForPointer(clientX: number): number {
  if (!viewport) return 0;
  const rect = viewport.getBoundingClientRect();
  const leftEdge = rect.left + HEADER_W;

  if (clientX < leftEdge + AUTOSCROLL_EDGE) {
    const closeness = Math.min(1, (leftEdge + AUTOSCROLL_EDGE - clientX) / AUTOSCROLL_EDGE);
    return -Math.ceil(closeness * AUTOSCROLL_MAX);
  }
  const rightEdge = rect.right;
  if (clientX > rightEdge - AUTOSCROLL_EDGE) {
    const closeness = Math.min(1, (clientX - (rightEdge - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE);
    return Math.ceil(closeness * AUTOSCROLL_MAX);
  }
  return 0;
}

/** Applies one auto-scroll step; returns true while the drag is still at an edge. */
export function tickAutoscroll(clientX: number): boolean {
  if (!viewport) return false;
  const delta = autoscrollForPointer(clientX);
  if (delta === 0) return false;
  const before = viewport.scrollLeft;
  viewport.scrollLeft = before + delta;
  // Report "still at the edge" even when already clamped, so the caller keeps
  // ticking and resumes immediately when the pointer moves back.
  return true;
}

/* ------------------------------------------------------------------ *
 * Wheel behaviour
 * ------------------------------------------------------------------ */

/** Rough pixel height of one wheel "line" for line-mode events. */
const LINE_HEIGHT = 16;

function deltaOf(event: WheelEvent, element: HTMLElement): { x: number; y: number } {
  // Chromium reports pixels, but a line- or page-mode event would otherwise be
  // read as a couple of pixels and feel dead.
  const scale =
    event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? element.clientHeight : 1;
  return { x: event.deltaX * scale, y: event.deltaY * scale };
}

/**
 * Wheel mapping for the timeline:
 *
 * - wheel          → scroll along the timeline (horizontal)
 * - shift + wheel  → scroll the tracks vertically
 * - ctrl/cmd+wheel → zoom about the pointer
 *
 * Registered natively with `passive: false` rather than through React's
 * `onWheel`: React attaches wheel listeners passively at the root, so
 * `preventDefault()` is ignored there and ctrl+wheel would zoom the whole webview
 * instead of the timeline.
 */
export function attachTimelineWheel(element: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    userScrolledAt = Date.now();
    const { x, y } = deltaOf(event, element);

    // Pinch-zoom on a trackpad also arrives as ctrl+wheel, with small deltas —
    // the exponential curve handles both that and a mouse wheel's steps.
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      zoomTimelineAt(Math.exp(-y * 0.0016), event.clientX);
      return;
    }

    if (event.shiftKey) {
      event.preventDefault();
      // Some drivers send shift+wheel as deltaX, so fall back to it.
      element.scrollTop += y || x;
      return;
    }

    // A trackpad's two-finger horizontal gesture arrives as deltaX; prefer it
    // when it is the larger of the two so the gesture maps to the right axis.
    const amount = Math.abs(x) > Math.abs(y) ? x : y;
    if (amount === 0) return;
    event.preventDefault();
    element.scrollLeft += amount;
  };

  element.addEventListener("wheel", onWheel, { passive: false });
  return () => element.removeEventListener("wheel", onWheel);
}

/** Frames the current selection, or the whole project when nothing is selected. */
export function zoomTimelineToSelection(): void {
  const store = useEditor.getState();
  const clips = selectedClips(store);
  if (clips.length === 0) {
    fitTimeline();
    return;
  }
  const from = Math.min(...clips.map((c) => c.start));
  const to = Math.max(...clips.map((c) => c.start + c.duration));
  const width = (viewport?.clientWidth ?? 1200) - HEADER_W - 40;
  const next = clampZoom(width / Math.max(0.4, to - from));
  applyZoom(next, from, HEADER_W + 16);
}
