import type { EasingName, FilterState, TransitionKind } from "../core/types";
import { EASINGS } from "../core/easing";

/**
 * Per-clip visual effects.
 *
 * Transitions are deliberately *source-only*: they transform the incoming clip
 * rather than reading the already-composited frame. That keeps them order
 * independent (any layer can transition over anything), fast, and identical
 * between the live preview and the offline exporter.
 */

export interface TransitionGeometry {
  width: number;
  height: number;
  /** Centre of the transitioning layer, in project pixels. */
  cx: number;
  cy: number;
}

export interface TransitionState {
  /** Multiplied into the clip's own opacity. */
  alpha: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  /** Extra blur in project pixels. */
  blur: number;
  /** Reveal window in project space, when the transition wipes. */
  clipRect?: { x: number; y: number; w: number; h: number };
  /** Reveal disc, when the transition is a circle open. */
  circle?: { cx: number; cy: number; r: number };
  /** Mosaic cell size in project pixels; 0 disables. */
  pixelate: number;
}

const IDENTITY: TransitionState = {
  alpha: 1,
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  blur: 0,
  pixelate: 0,
};

export function identityTransition(): TransitionState {
  return { ...IDENTITY };
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Evaluates a transition at progress `t`, where 0 is fully hidden and 1 is
 * fully present. Passing the same `t` always yields the same state, which is
 * what makes exported frames reproducible.
 *
 * `easing` controls the progress curve of the transition. It defaults to
 * `easeOutCubic` to preserve the behaviour the project shipped with before the
 * easing field became editable.
 */
export function evaluateTransition(
  kind: TransitionKind,
  t: number,
  geo: TransitionGeometry,
  easing?: EasingName,
): TransitionState {
  const p = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const ease = EASINGS[easing ?? "easeOutCubic"] ?? easeOutCubic;
  const e = ease(p);
  const { width: w, height: h, cx, cy } = geo;
  const s: TransitionState = { ...IDENTITY };

  switch (kind) {
    case "fade":
      s.alpha = e;
      break;

    case "slideLeft":
      s.offsetX = -(1 - e) * w;
      s.alpha = Math.min(1, e * 1.6);
      break;
    case "slideRight":
      s.offsetX = (1 - e) * w;
      s.alpha = Math.min(1, e * 1.6);
      break;
    case "slideUp":
      s.offsetY = -(1 - e) * h;
      s.alpha = Math.min(1, e * 1.6);
      break;
    case "slideDown":
      s.offsetY = (1 - e) * h;
      s.alpha = Math.min(1, e * 1.6);
      break;

    case "wipeRight":
      s.clipRect = { x: 0, y: 0, w: w * e, h };
      break;
    case "wipeLeft":
      s.clipRect = { x: w * (1 - e), y: 0, w: w * e, h };
      break;

    case "circleOpen": {
      const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
      s.circle = { cx, cy, r: maxR * e };
      break;
    }

    case "pixelate": {
      const maxCell = Math.max(24, Math.round(Math.min(w, h) / 22));
      s.pixelate = Math.max(1, Math.round(maxCell * (1 - e)));
      s.alpha = Math.min(1, 0.35 + e * 0.65);
      break;
    }

    case "blurDissolve":
      s.blur = (1 - e) * 26;
      s.alpha = e;
      s.scale = 1 + (1 - e) * 0.04;
      break;

    case "zoomBlur":
      s.blur = (1 - e) * 22;
      s.scale = 1 + (1 - e) * 0.22;
      s.alpha = Math.min(1, e * 1.35);
      break;
  }

  return s;
}

export const TRANSITION_KINDS: TransitionKind[] = [
  "fade",
  "slideLeft",
  "slideRight",
  "slideUp",
  "slideDown",
  "wipeLeft",
  "wipeRight",
  "circleOpen",
  "pixelate",
  "blurDissolve",
  "zoomBlur",
];

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  fade: "淡入淡出",
  slideLeft: "左侧滑入",
  slideRight: "右侧滑入",
  slideUp: "下方滑入",
  slideDown: "上方滑入",
  wipeLeft: "左向擦除",
  wipeRight: "右向擦除",
  circleOpen: "圆形展开",
  pixelate: "像素化",
  blurDissolve: "模糊溶解",
  zoomBlur: "缩放冲击",
};

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

export function isIdentityFilter(f: FilterState): boolean {
  return (
    f.blur === 0 &&
    f.brightness === 1 &&
    f.contrast === 1 &&
    f.saturate === 1 &&
    f.grayscale === 0 &&
    f.hueRotate === 0
  );
}

export function hasShadow(f: FilterState): boolean {
  return f.shadowBlur > 0;
}

/** Builds the `ctx.filter` string. Returns "none" when nothing is applied. */
export function filterString(f: FilterState): string {
  if (isIdentityFilter(f)) return "none";
  const parts: string[] = [];
  if (f.blur > 0) parts.push(`blur(${round(f.blur)}px)`);
  if (f.brightness !== 1) parts.push(`brightness(${round(f.brightness)})`);
  if (f.contrast !== 1) parts.push(`contrast(${round(f.contrast)})`);
  if (f.saturate !== 1) parts.push(`saturate(${round(f.saturate)})`);
  if (f.grayscale > 0) parts.push(`grayscale(${round(f.grayscale)})`);
  if (f.hueRotate !== 0) parts.push(`hue-rotate(${round(f.hueRotate)}deg)`);
  return parts.length > 0 ? parts.join(" ") : "none";
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * Path helpers
 * ------------------------------------------------------------------ */

/** `ctx.roundRect` polyfill/facade that works on every supported WebView. */
export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  ctx.beginPath();
  if (r <= 0.01) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function polygonPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotation = -Math.PI / 2,
): void {
  ctx.beginPath();
  for (let i = 0; i < sides; i += 1) {
    const a = rotation + (i * Math.PI * 2) / sides;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function starPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outer: number,
  innerRatio: number,
  points: number,
  rotation = -Math.PI / 2,
): void {
  const inner = outer * Math.max(0.05, Math.min(0.95, innerRatio));
  ctx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
