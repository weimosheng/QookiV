import type { AnimationMap, EasingName, Keyframe } from "./types";

/**
 * Reusable motion presets.
 *
 * Keyframe times are clip-local seconds, so a preset can be dropped onto any
 * clip regardless of where it sits on the timeline. Templates lean on these to
 * get consistent, well-timed motion without hand-authoring curves.
 */

export function kf(time: number, value: number | string, easing: EasingName = "linear"): Keyframe {
  return { time, value, easing };
}

function ramp(
  path: string,
  from: number | string,
  to: number | string,
  start: number,
  duration: number,
  easing: EasingName,
): AnimationMap {
  const span = Math.max(0, duration);
  return {
    [path]: [kf(start, from, "linear"), kf(start + span, to, easing)],
  };
}

type Sign = 1 | -1;

/* ------------------------------------------------------------------ *
 * Entrances
 * ------------------------------------------------------------------ */

export function fadeIn(duration = 0.6, delay = 0, easing: EasingName = "easeOutCubic"): AnimationMap {
  return ramp("opacity", 0, 1, delay, duration, easing);
}

export function fadeOut(at: number, duration = 0.5, easing: EasingName = "easeInCubic"): AnimationMap {
  return ramp("opacity", 1, 0, at, duration, easing);
}

/** Fades the clip in at its head and out at its tail. */
export function fadeInOut(
  clipDuration: number,
  inDuration = 0.6,
  outDuration = 0.5,
): AnimationMap {
  return mergeAnimations(
    fadeIn(inDuration, 0),
    fadeOut(Math.max(inDuration, clipDuration - outDuration), outDuration),
  );
}

export function riseIn(duration = 0.75, distance = 70, delay = 0, easing: EasingName = "easeOutQuart"): AnimationMap {
  return mergeAnimations(
    ramp("transform.y", distance, 0, delay, duration, easing),
    ramp("opacity", 0, 1, delay, Math.min(duration, 0.45), "easeOutQuad"),
  );
}

export function dropIn(duration = 0.75, distance = 70, delay = 0, easing: EasingName = "easeOutQuart"): AnimationMap {
  return mergeAnimations(
    ramp("transform.y", -distance, 0, delay, duration, easing),
    ramp("opacity", 0, 1, delay, Math.min(duration, 0.45), "easeOutQuad"),
  );
}

export function slideIn(
  from: "left" | "right" | "top" | "bottom",
  duration = 0.7,
  distance = 160,
  delay = 0,
  easing: EasingName = "easeOutQuart",
): AnimationMap {
  const axis = from === "left" || from === "right" ? "transform.x" : "transform.y";
  const sign: Sign = from === "right" || from === "bottom" ? 1 : -1;
  return mergeAnimations(
    ramp(axis, distance * sign, 0, delay, duration, easing),
    ramp("opacity", 0, 1, delay, Math.min(duration, 0.4), "easeOutQuad"),
  );
}

export function popIn(duration = 0.62, from = 0.82, delay = 0, easing: EasingName = "easeOutBack"): AnimationMap {
  return mergeAnimations(
    ramp("transform.scale", from, 1, delay, duration, easing),
    ramp("opacity", 0, 1, delay, Math.min(duration, 0.3), "easeOutQuad"),
  );
}

/** Blur-and-sharpen entrance; reads as "focus pulling" onto the subject. */
export function blurIn(duration = 0.7, amount = 18, delay = 0): AnimationMap {
  return mergeAnimations(
    ramp("filters.blur", amount, 0, delay, duration, "easeOutQuart"),
    ramp("opacity", 0, 1, delay, Math.min(duration, 0.4), "easeOutQuad"),
    ramp("transform.scale", 1.06, 1, delay, duration, "easeOutQuart"),
  );
}

/** Expands a mask-like wipe by scaling a fully transparent edge inward. */
export function scaleSettle(duration = 1.6, from = 1.12, delay = 0): AnimationMap {
  return ramp("transform.scale", from, 1, delay, duration, "easeOutQuart");
}

/* ------------------------------------------------------------------ *
 * Emphasis & ambience
 * ------------------------------------------------------------------ */

/**
 * Gentle continuous drift, expressed as N keyframes over the clip. Use for
 * backgrounds and screenshots so a static frame never looks frozen.
 */
export function floatY(amplitude = 12, period = 4, cycles = 8, path = "transform.y"): AnimationMap {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= cycles; i += 1) {
    const t = (i * period) / 2;
    const up = i % 2 === 0;
    frames.push({ time: t, value: up ? -amplitude : amplitude, easing: "easeInOutQuad" });
  }
  return { [path]: frames };
}

export function breathe(amount = 0.03, period = 3.2, cycles = 8, path = "transform.scale"): AnimationMap {
  const frames: Keyframe[] = [];
  for (let i = 0; i <= cycles; i += 1) {
    const t = (i * period) / 2;
    const peak = i % 2 === 1;
    frames.push({ time: t, value: peak ? 1 + amount : 1, easing: "easeInOutQuad" });
  }
  return { [path]: frames };
}

export function pulse(at: number, duration = 0.45, amount = 1.08): AnimationMap {
  return {
    "transform.scale": [
      kf(Math.max(0, at - duration / 2), 1, "easeOutQuad"),
      kf(at, amount, "easeOutQuad"),
      kf(at + duration / 2, 1, "easeOutQuad"),
    ],
  };
}

/** Counter-rotating wobble, good for sticker-like accents. */
export function wobble(duration = 0.9, degrees = 6, at = 0): AnimationMap {
  return {
    "transform.rotation": [
      kf(at, 0, "linear"),
      kf(at + duration * 0.25, -degrees, "easeInOutQuad"),
      kf(at + duration * 0.6, degrees * 0.7, "easeInOutQuad"),
      kf(at + duration, 0, "easeOutQuad"),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Composition helpers
 * ------------------------------------------------------------------ */

/**
 * Merges animation maps. Keyframes targeting the same path are concatenated and
 * time-sorted so a single curve drives each property.
 */
export function mergeAnimations(...maps: Array<AnimationMap | undefined>): AnimationMap {
  const out: AnimationMap = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [path, frames] of Object.entries(map)) {
      out[path] = [...(out[path] ?? []), ...frames];
    }
  }
  for (const path of Object.keys(out)) {
    out[path] = out[path].sort((a, b) => a.time - b.time);
  }
  return out;
}

/** Shifts every keyframe later in time — used to stagger sibling elements. */
export function delayAnimation(map: AnimationMap, seconds: number): AnimationMap {
  const out: AnimationMap = {};
  for (const [path, frames] of Object.entries(map)) {
    out[path] = frames.map((f) => ({ ...f, time: f.time + seconds }));
  }
  return out;
}

/**
 * Adds `delta` to every numeric keyframe on `path`.
 *
 * Keyframes hold absolute property values, so a preset like `riseIn` (which
 * animates `transform.y` from 70 to 0) would drag a clip to the centre. Offsetting
 * lets a template place a clip and still animate it: the entrance now runs from
 * `base + 70` to `base`.
 */
export function offsetAnimation(map: AnimationMap, path: string, delta: number): AnimationMap {
  const frames = map[path];
  if (!frames) return map;
  return {
    ...map,
    [path]: frames.map((f) =>
      typeof f.value === "number" ? { ...f, value: f.value + delta } : f,
    ),
  };
}

/** Offsets several paths at once, e.g. `{ "transform.x": 200, "transform.y": -80 }`. */
export function offsetPaths(map: AnimationMap, deltas: Record<string, number>): AnimationMap {
  let out = map;
  for (const [path, delta] of Object.entries(deltas)) {
    out = offsetAnimation(out, path, delta);
  }
  return out;
}

/**
 * Rewrites every numeric keyframe value on `path` through `fn`.
 *
 * Needed when a clip has a non-default base value: `popIn` animates
 * `transform.scale` from 0.82 to **1**, which would blow a logo that should sit
 * at 0.34 up to full size. Mapping the curve fixes it:
 * `mapAnimation(popIn(), "transform.scale", (v) => v * 0.34)`.
 */
export function mapAnimation(
  map: AnimationMap,
  path: string,
  fn: (value: number) => number,
): AnimationMap {
  const frames = map[path];
  if (!frames) return map;
  return {
    ...map,
    [path]: frames.map((f) => (typeof f.value === "number" ? { ...f, value: fn(f.value) } : f)),
  };
}

/** Shifts every keyframe earlier in time (clamped at zero). */
export function advanceAnimation(map: AnimationMap, seconds: number): AnimationMap {
  const out: AnimationMap = {};
  for (const [path, frames] of Object.entries(map)) {
    out[path] = frames.map((f) => ({ ...f, time: Math.max(0, f.time - seconds) }));
  }
  return out;
}

/** Stretches or compresses keyframe timing by a factor. */
export function scaleAnimation(map: AnimationMap, factor: number): AnimationMap {
  const out: AnimationMap = {};
  for (const [path, frames] of Object.entries(map)) {
    out[path] = frames.map((f) => ({ ...f, time: f.time * factor }));
  }
  return out;
}
