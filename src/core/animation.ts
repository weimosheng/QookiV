import { applyEasing } from "./easing";
import { mixColor, parseColor, rgbaToCss } from "./color";
import type { AnimatedValue, AnimationMap, Clip, Keyframe } from "./types";

/**
 * Keyframe resolution.
 *
 * Property paths are dotted strings (`transform.x`, `opacity`,
 * `props.style.fontSize`) resolved against the clip object, so new animatable
 * properties need no registration step anywhere.
 */

export function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Writes along a dotted path, cloning each container on the way down so the
 * caller's original object graph is never mutated.
 */
export function setPathDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const next = cur[key];
    const clone: Record<string, unknown> =
      next && typeof next === "object" && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : Array.isArray(next)
          ? ([...next] as unknown as Record<string, unknown>)
          : {};
    cur[key] = clone;
    cur = clone;
  }
  cur[parts[parts.length - 1]] = value;
}

function isColorString(v: AnimatedValue): v is string {
  return typeof v === "string";
}

/** Interpolates two keyframe values, blending colours when both are colours. */
function interpolate(a: AnimatedValue, b: AnimatedValue, t: number): AnimatedValue {
  if (typeof a === "number" && typeof b === "number") return a + (b - a) * t;
  if (isColorString(a) && isColorString(b)) {
    // Only blend when both sides are actually parseable colours.
    const pa = parseColor(a, { r: NaN, g: NaN, b: NaN, a: NaN });
    const pb = parseColor(b, { r: NaN, g: NaN, b: NaN, a: NaN });
    const valid = (c: typeof pa) => !Number.isNaN(c.r);
    if (valid(pa) && valid(pb)) return mixColor(rgbaToCss(pa), rgbaToCss(pb), t);
    return t < 0.5 ? a : b;
  }
  return t < 1 ? a : b;
}

/** Keyframes must be sorted for sampling; callers keep them that way. */
export function sortKeyframes(list: Keyframe[]): Keyframe[] {
  return [...list].sort((a, b) => a.time - b.time);
}

/**
 * Samples a keyframe list at `localTime` (seconds from the clip's in-point).
 * Before the first key the first value is held; after the last, the last.
 */
export function sampleKeyframes(list: Keyframe[], localTime: number): AnimatedValue | undefined {
  if (!list || list.length === 0) return undefined;
  if (list.length === 1) return list[0].value;

  const sorted = list;
  if (localTime <= sorted[0].time) return sorted[0].value;

  const last = sorted[sorted.length - 1];
  if (localTime >= last.time) return last.value;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (localTime >= a.time && localTime <= b.time) {
      const span = b.time - a.time;
      const raw = span <= 0 ? 1 : (localTime - a.time) / span;
      return interpolate(a.value, b.value, applyEasing(b.easing, raw));
    }
  }
  return last.value;
}

export function sampleNumber(
  animation: AnimationMap,
  path: string,
  localTime: number,
  fallback: number,
): number {
  const list = animation[path];
  if (!list || list.length === 0) return fallback;
  const v = sampleKeyframes(list, localTime);
  return typeof v === "number" ? v : fallback;
}

export function hasKeyframes(animation: AnimationMap, path: string): boolean {
  const list = animation[path];
  return !!list && list.length > 0;
}

/** Every property path that carries at least one keyframe, in stable order. */
export function animatedPaths(animation: AnimationMap): string[] {
  return Object.keys(animation)
    .filter((k) => animation[k] && animation[k].length > 0)
    .sort();
}

/**
 * Returns a clip with all animated properties baked in at `localTime`.
 *
 * When the clip animates nothing the original reference is returned, which
 * keeps the common case allocation-free.
 */
export function resolveClipAt(clip: Clip, localTime: number): Clip {
  const anim = clip.animation;
  const paths = anim ? Object.keys(anim) : [];
  if (paths.length === 0) return clip;

  // Clone the clip and every container the animated paths pass through, so the
  // caller's project graph is never mutated by a render.
  const draft: Record<string, unknown> = {
    ...(clip as unknown as Record<string, unknown>),
    transform: { ...clip.transform },
    filters: { ...clip.filters },
    props: { ...(clip.props as unknown as Record<string, unknown>) },
  };

  let changed = false;
  for (const path of paths) {
    const list = anim[path];
    if (!list || list.length === 0) continue;
    const value = sampleKeyframes(list, localTime);
    if (value === undefined) continue;
    setPathDeep(draft, path, value);
    changed = true;
  }

  return changed ? (draft as unknown as Clip) : clip;
}

/** Convenience for the inspector: the value a property has at `localTime`. */
export function currentValue(clip: Clip, path: string, localTime: number): unknown {
  const list = clip.animation[path];
  if (list && list.length > 0) return sampleKeyframes(list, localTime);
  return getPath(clip, path);
}
