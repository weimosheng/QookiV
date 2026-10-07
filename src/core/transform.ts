import { currentValue } from "./animation";
import { mapAnimation, offsetAnimation } from "./motion";
import type { AnimationMap, Clip } from "./types";

/**
 * Transform editing that coexists with keyframes.
 *
 * Keyframes hold *absolute* values, and `resolveClipAt` replaces the base
 * transform with them. So writing `transform.y` on a clip whose entrance
 * animates `transform.y` changes nothing on screen — which is exactly why
 * dragging such a clip appeared to work horizontally (x was usually not
 * animated) but not vertically.
 *
 * The fix is to treat a manual edit as a change to the *whole* motion: the base
 * value moves, and every keyframe on that path moves with it, so the curve keeps
 * its shape and the element lands where the user put it.
 */

export type TransformKey = "x" | "y" | "scale" | "rotation";

export interface TransformSnapshot {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  animation: AnimationMap;
}

export function snapshotTransform(clip: Clip): TransformSnapshot {
  return {
    x: clip.transform.x,
    y: clip.transform.y,
    scale: clip.transform.scale,
    rotation: clip.transform.rotation,
    animation: clip.animation,
  };
}

/**
 * Rebuilds a clip with its transform set to `target` (base values).
 *
 * Offsets are derived from `snap`, so repeated calls during a drag are absolute
 * rather than cumulative. Translation and rotation shift their keyframes;
 * scale multiplies them, because scaling is multiplicative.
 */
export function applyTransform(
  clip: Clip,
  snap: TransformSnapshot,
  target: Partial<Record<TransformKey, number>>,
): Clip {
  const transform = { ...clip.transform };

  // Offsets are applied to the *snapshot's* animation, never to `clip.animation`.
  //
  // A drag fires many move events, each passing the same original snapshot with a
  // growing absolute target. Reading the animation from `clip` would offset an
  // already-offset curve again on every event, so the total shift would grow
  // quadratically and the element would fly off the canvas. Anchoring to the
  // snapshot makes each call absolute and therefore idempotent.
  let animation = snap.animation;

  if (target.x !== undefined) {
    const delta = target.x - snap.x;
    transform.x = target.x;
    if (delta !== 0) animation = offsetAnimation(animation, "transform.x", delta);
  }

  if (target.y !== undefined) {
    const delta = target.y - snap.y;
    transform.y = target.y;
    if (delta !== 0) animation = offsetAnimation(animation, "transform.y", delta);
  }

  if (target.rotation !== undefined) {
    const delta = target.rotation - snap.rotation;
    transform.rotation = target.rotation;
    if (delta !== 0) animation = offsetAnimation(animation, "transform.rotation", delta);
  }

  if (target.scale !== undefined) {
    const factor = snap.scale === 0 ? 1 : target.scale / snap.scale;
    transform.scale = target.scale;
    if (factor !== 1) animation = mapAnimation(animation, "transform.scale", (v) => v * factor);
  }

  return { ...clip, transform, animation };
}

/** The value actually on screen for one transform key at `localTime`. */
export function visibleTransformValue(clip: Clip, key: TransformKey, localTime: number): number {
  const value = currentValue(clip, `transform.${key}`, localTime);
  return typeof value === "number" && Number.isFinite(value) ? value : clip.transform[key];
}

/**
 * Converts "the user wants the element to sit at `desiredVisible`" into the base
 * value that produces it, so an inspector field can show and accept the value the
 * user actually sees.
 */
export function baseTargetForVisible(
  clip: Clip,
  snap: TransformSnapshot,
  key: TransformKey,
  desiredVisible: number,
  localTime: number,
): number {
  const base = snap[key];
  const visible = visibleTransformValue(clip, key, localTime);

  if (key === "scale") {
    if (visible === 0) return desiredVisible;
    return base * (desiredVisible / visible);
  }
  return base + (desiredVisible - visible);
}
