import type { EasingName } from "./types";

/**
 * Easing curves used by both keyframe interpolation and transitions.
 *
 * Every curve is a pure function of normalised progress, which is what lets the
 * preview and the offline exporter agree frame for frame.
 */
const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;

export const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,

  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),

  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),

  easeInQuart: (t) => t * t * t * t,
  easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),

  easeInExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutExpo: (t) =>
    t === 0
      ? 0
      : t === 1
        ? 1
        : t < 0.5
          ? Math.pow(2, 20 * t - 10) / 2
          : (2 - Math.pow(2, -20 * t + 10)) / 2,

  easeInBack: (t) => c3 * t * t * t - c1 * t * t,
  easeOutBack: (t) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2),
  easeInOutBack: (t) =>
    t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2,

  easeOutElastic: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1,

  easeOutBounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },

  hold: () => 0,
};

/** Easing choices surfaced in the inspector, in a friendly order. */
export const EASING_OPTIONS: EasingName[] = [
  "linear",
  "easeInQuad",
  "easeOutQuad",
  "easeInOutQuad",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeInQuart",
  "easeOutQuart",
  "easeInOutQuart",
  "easeInExpo",
  "easeOutExpo",
  "easeInOutExpo",
  "easeInBack",
  "easeOutBack",
  "easeInOutBack",
  "easeOutElastic",
  "easeOutBounce",
  "hold",
];

export const EASING_LABELS: Record<EasingName, string> = {
  linear: "线性",
  easeInQuad: "缓入 · 二次",
  easeOutQuad: "缓出 · 二次",
  easeInOutQuad: "缓入缓出 · 二次",
  easeInCubic: "缓入 · 三次",
  easeOutCubic: "缓出 · 三次",
  easeInOutCubic: "缓入缓出 · 三次",
  easeInQuart: "缓入 · 四次",
  easeOutQuart: "缓出 · 四次",
  easeInOutQuart: "缓入缓出 · 四次",
  easeInExpo: "缓入 · 指数",
  easeOutExpo: "缓出 · 指数",
  easeInOutExpo: "缓入缓出 · 指数",
  easeInBack: "回拉 · 入",
  easeOutBack: "回弹 · 出",
  easeInOutBack: "回弹 · 进出",
  easeOutElastic: "弹性",
  easeOutBounce: "弹跳",
  hold: "保持（阶跃）",
};

export function applyEasing(name: EasingName | undefined, t: number): number {
  const fn = EASINGS[name ?? "linear"] ?? EASINGS.linear;
  return fn(t);
}
