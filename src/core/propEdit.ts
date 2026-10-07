import { currentValue, getPath, setPathDeep } from "./animation";
import type { AnimationMap, Clip, EasingName, Keyframe } from "./types";

/**
 * Editing a property that is also keyframed.
 *
 * Keyframes hold *absolute* values and `resolveClipAt` replaces the base value with
 * them, so writing a property that carries keyframes changes nothing on screen.
 * `core/transform.ts` solved that for the four transform keys; this module is the
 * same idea for everything else — `props.width`, `props.height`, `props.radius`,
 * `props.strokeWidth`, `opacity`, `filters.blur`, `props.style.color` — so a clip
 * built by hand can reach anything a template animates.
 *
 * Two edit semantics, chosen by value type:
 *
 * - **numbers shift**: the base value moves and every numeric keyframe on that path
 *   moves with it, so the curve keeps its shape and the value at the playhead
 *   becomes exactly what was typed (`applyVisibleNumber`);
 * - **strings cannot be shifted**: the keyframe sitting at the playhead is replaced,
 *   or written if there is none (`applyVisibleValue`). Colours interpolate, so a
 *   fill fading from opaque to transparent is just two of these.
 */

/** True when `path` carries at least one keyframe. */
export function isAnimated(clip: Clip, path: string): boolean {
  return (clip.animation[path]?.length ?? 0) > 0;
}

/** A number read off the clip, or the fallback when the path is not numeric. */
export function numberAt(clip: Clip, path: string, fallback = 0): number {
  const value = getPath(clip, path);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The value actually on screen at `localTime` (keyframes win over the base). */
export function valueAt(clip: Clip, path: string, localTime: number): unknown {
  return currentValue(clip, path, localTime);
}

/** Keyframe matching `localTime` within half a frame, or -1. */
function frameIndexAt(frames: Keyframe[], localTime: number): number {
  return frames.findIndex((f) => Math.abs(f.time - localTime) <= 1 / 120);
}

/** Copies the clip with `path` set, cloning each container on the way down. */
function withBaseValue(clip: Clip, path: string, value: unknown): Clip {
  const draft = { ...(clip as unknown as Record<string, unknown>) };
  setPathDeep(draft, path, value);
  return draft as unknown as Clip;
}

/** Moves every numeric keyframe on `path` by `delta`. */
export function shiftNumericKeyframes(
  animation: AnimationMap,
  path: string,
  delta: number,
): AnimationMap {
  const frames = animation[path];
  if (!frames || frames.length === 0 || delta === 0) return animation;
  return {
    ...animation,
    [path]: frames.map((f) => (typeof f.value === "number" ? { ...f, value: f.value + delta } : f)),
  };
}

/** Replaces the keyframe at `localTime`, or writes a new one, keeping the list sorted. */
export function writeKeyframeAt(
  animation: AnimationMap,
  path: string,
  localTime: number,
  value: number | string,
  easing: EasingName = "easeInOutCubic",
): AnimationMap {
  const frames = animation[path] ?? [];
  const hit = frameIndexAt(frames, localTime);
  const next =
    hit >= 0
      ? frames.map((f, i) => (i === hit ? { ...f, value } : f))
      : [...frames, { time: localTime, value, easing }].sort((a, b) => a.time - b.time);
  return { ...animation, [path]: next };
}

/**
 * Writes a number the way the user sees it.
 *
 * Not animated: the base value takes it (a plain property edit). Animated: the
 * whole curve shifts by `target - valueAt(localTime)`, so the number typed is the
 * number that ends up under the playhead and the motion keeps its shape.
 */
export function applyVisibleNumber(
  clip: Clip,
  path: string,
  target: number,
  localTime: number,
): Clip {
  const base = numberAt(clip, path, target);
  if (!isAnimated(clip, path)) return withBaseValue(clip, path, target);

  const visible = valueAt(clip, path, localTime);
  const from = typeof visible === "number" && Number.isFinite(visible) ? visible : base;
  const delta = target - from;
  const shifted = withBaseValue(clip, path, base + delta);
  return { ...shifted, animation: shiftNumericKeyframes(clip.animation, path, delta) };
}

/**
 * Writes a string value (a colour, a font family…).
 *
 * Strings have no meaningful "shift", so an animated path gets a keyframe at the
 * playhead — replacing the one already sitting there — while a plain path just
 * takes the new base value.
 */
export function applyVisibleValue(
  clip: Clip,
  path: string,
  value: number | string,
  localTime: number,
): Clip {
  if (!isAnimated(clip, path)) return withBaseValue(clip, path, value);
  return { ...clip, animation: writeKeyframeAt(clip.animation, path, localTime, value) };
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export interface NumberTransitionOptions {
  clip: Clip;
  path: string;
  /** 终点值。 */
  target: number;
  /** 片段内的过渡起点（通常是播放头所在的本地时刻）。 */
  at: number;
  duration: number;
  easing?: EasingName;
}

/**
 * "从这里开始，用 N 秒动到这个值"。
 *
 * 起点会在 `at` 处打一个**当前可见值**的点，所以它接在已有曲线上而不是把它压平；
 * 终点打在 `at + duration`。两点之间的缓动属于终点那一帧。
 *
 * 两个关键帧都必须落在片段内，否则会被 `normalizeProject` 裁掉——调用方负责把
 * `at` 与 `duration` 夹进片段；这里再夹一次，保证手写工程或极端数值也不会越界。
 */
export function applyNumberTransition(opts: NumberTransitionOptions): Clip {
  const { clip, path, target, easing = "easeInOutCubic" } = opts;
  const duration = Math.max(1 / 60, Math.min(opts.duration, clip.duration));
  const at = Math.max(0, Math.min(opts.at, Math.max(0, clip.duration - duration)));
  const from = valueAt(clip, path, at);
  const start = typeof from === "number" && Number.isFinite(from) ? from : numberAt(clip, path, target);

  // 先写终点、后写起点：起点那一帧带 `hold`，于是它之前的值被停住，曲线只会从 `at`
  // 开始走。反过来写的话，已经存在的那一帧会让缓动从更早的地方就开始爬。
  let animation = writeKeyframeAt(clip.animation, path, at + duration, target, easing);
  animation = writeKeyframeAt(animation, path, at, start, "hold");

  return { ...withBaseValue(clip, path, target), animation };
}

/* ------------------------------------------------------------------ *
 * 尺寸过渡
 * ------------------------------------------------------------------ */

/**
 * 片段当前的可见宽/高。形状与界面演示的盒子尺寸就是 `props.width/height`；
 * 其它图层没有这个属性，返回 0。
 */
export function sizeAt(clip: Clip, axis: "width" | "height", localTime: number): number {
  const path = `props.${axis}`;
  const animated = valueAt(clip, path, localTime);
  if (typeof animated === "number" && Number.isFinite(animated)) return animated;
  return numberAt(clip, path, 0);
}

/** True when the clip is a layer whose box size can be animated（形状 / 界面演示）。 */
export function hasAnimatableSize(clip: Clip): boolean {
  if (clip.kind !== "shape" && clip.kind !== "device") return false;
  return sizeAt(clip, "width", 0) > 0 && sizeAt(clip, "height", 0) > 0;
}

export interface SizeGroupItem {
  clip: Clip;
  /** 该片段内的过渡起点。 */
  at: number;
}

export interface SizeTarget {
  id: string;
  width: number;
  height: number;
}

/**
 * 一组尺寸图层共用**同一个尺寸增量**。
 *
 * 一叠"外框 + 截图"是两张各自带 `props.width/height` 的片段，外框比截图大一圈（边框
 * 厚度）。如果两张都直接动到目标尺寸，边框会消失；所以以参考片段在播放头处的可见尺寸
 * 为准算出增量，再把这个增量摊到其它片段上——边框厚度、两张之间的任何偏移都原样保留。
 * 只选了一张时，结果就等于"动到目标尺寸"。
 */
export function planSizeTransition(
  items: SizeGroupItem[],
  referenceIndex: number,
  target: { width: number; height: number },
): SizeTarget[] {
  const ref = items[referenceIndex] ?? items[0];
  if (!ref) return [];

  const deltaWidth = target.width - sizeAt(ref.clip, "width", ref.at);
  const deltaHeight = target.height - sizeAt(ref.clip, "height", ref.at);

  return items.map((item) => ({
    id: item.clip.id,
    width: Math.max(1, sizeAt(item.clip, "width", item.at) + deltaWidth),
    height: Math.max(1, sizeAt(item.clip, "height", item.at) + deltaHeight),
  }));
}
