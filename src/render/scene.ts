import { resolveClipAt } from "../core/animation";
import { paintOrderTracks } from "../core/project";
import type { Project, Seconds, VisualClip } from "../core/types";
import { evaluateTransition, identityTransition } from "./effects";
import type { TransitionState } from "./effects";
import { getLayer } from "./layers";
import type { LayerBox, MediaProvider, RenderQuality } from "./types";

/**
 * Scene geometry.
 *
 * The compositor and the preview's direct-manipulation handles must agree
 * exactly: if the selection frame were computed from a second, slightly
 * different transform, the outline would drift away from the pixels. So both
 * read this module, and `Renderer` draws from the very placements the overlay
 * hit-tests against.
 */

export interface LayerPlacement {
  clipId: string;
  trackId: string;
  /** The clip with its animated properties already resolved. */
  clip: VisualClip;
  /** Intrinsic layer size, before the transform. */
  box: LayerBox;
  localTime: Seconds;
  sourceTime: Seconds;
  transition: TransitionState;
  /** Where the layer's anchor point lands, in project pixels. */
  originX: number;
  originY: number;
  /** Uniform scale actually applied (clip scale × transition scale). */
  scale: number;
  /** Rotation in radians. */
  rotation: number;
  /** Anchor in normalised layer coordinates. */
  anchorX: number;
  anchorY: number;
  /** Effective alpha, so invisible layers can be excluded from hit testing. */
  alpha: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Evaluates the clip's in/out transition at `localTime`. */
export function transitionFor(
  clip: VisualClip,
  localTime: Seconds,
  width: number,
  height: number,
): TransitionState {
  const geo = {
    width,
    height,
    cx: width / 2 + clip.transform.x,
    cy: height / 2 + clip.transform.y,
  };

  let inProgress = 1;
  if (clip.transitionIn && clip.transitionIn.duration > 0) {
    inProgress = Math.max(0, Math.min(1, localTime / clip.transitionIn.duration));
  }
  let outProgress = 1;
  if (clip.transitionOut && clip.transitionOut.duration > 0) {
    outProgress = Math.max(
      0,
      Math.min(1, (clip.duration - localTime) / clip.transitionOut.duration),
    );
  }

  if (inProgress >= 1 && outProgress >= 1) return identityTransition();
  if (inProgress <= outProgress && clip.transitionIn) {
    return evaluateTransition(clip.transitionIn.kind, inProgress, geo, clip.transitionIn.easing);
  }
  if (clip.transitionOut) {
    return evaluateTransition(clip.transitionOut.kind, outProgress, geo, clip.transitionOut.easing);
  }
  return identityTransition();
}

/**
 * Every visual layer visible at `time`, in paint order (back to front).
 *
 * `ctx` is needed because text layers measure themselves.
 */
export function collectPlacements(
  ctx: CanvasRenderingContext2D,
  project: Project,
  media: MediaProvider,
  time: Seconds,
  quality: RenderQuality = "preview",
): LayerPlacement[] {
  const { width, height } = project.settings;
  const out: LayerPlacement[] = [];

  for (const track of paintOrderTracks(project)) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.kind === "audio") continue;
      const localTime = time - clip.start;
      if (localTime < 0 || localTime >= clip.duration) continue;

      const resolved = resolveClipAt(clip, localTime) as VisualClip;
      const layer = getLayer(resolved.kind);
      if (!layer) continue;

      const box = layer.measure({ ctx, clip: resolved, project, localTime, media, quality });
      if (box.w <= 0 || box.h <= 0) continue;

      const transition = transitionFor(resolved, localTime, width, height);
      const t = resolved.transform;

      out.push({
        clipId: clip.id,
        trackId: track.id,
        clip: resolved,
        box,
        localTime,
        sourceTime: resolved.trimIn + localTime * resolved.speed,
        transition,
        originX: width / 2 + t.x + transition.offsetX,
        originY: height / 2 + t.y + transition.offsetY,
        scale: t.scale * transition.scale,
        rotation: (t.rotation * Math.PI) / 180,
        anchorX: t.anchorX,
        anchorY: t.anchorY,
        alpha: resolved.opacity * transition.alpha,
      });
    }
  }

  return out;
}

/** Maps a point in layer-local pixels to project pixels. */
export function localToProject(p: LayerPlacement, localX: number, localY: number): Point {
  const cos = Math.cos(p.rotation);
  const sin = Math.sin(p.rotation);
  const sx = (localX - p.box.w * p.anchorX) * p.scale;
  const sy = (localY - p.box.h * p.anchorY) * p.scale;
  return {
    x: p.originX + sx * cos - sy * sin,
    y: p.originY + sx * sin + sy * cos,
  };
}

/** Inverse of `localToProject`: project pixels back to layer-local pixels. */
export function projectToLocal(p: LayerPlacement, x: number, y: number): Point {
  const dx = x - p.originX;
  const dy = y - p.originY;
  const cos = Math.cos(-p.rotation);
  const sin = Math.sin(-p.rotation);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  const scale = Math.abs(p.scale) < 1e-6 ? 1e-6 : p.scale;
  return {
    x: rx / scale + p.box.w * p.anchorX,
    y: ry / scale + p.box.h * p.anchorY,
  };
}

/** The layer's four corners in project pixels, clockwise from its top-left. */
export function cornersOf(p: LayerPlacement): [Point, Point, Point, Point] {
  return [
    localToProject(p, 0, 0),
    localToProject(p, p.box.w, 0),
    localToProject(p, p.box.w, p.box.h),
    localToProject(p, 0, p.box.h),
  ];
}

/** The layer's anchor point in project pixels. */
export function anchorPoint(p: LayerPlacement): Point {
  return localToProject(p, p.box.w * p.anchorX, p.box.h * p.anchorY);
}

export type HandleId =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "rotate";

/** Handle positions in layer-local pixels. */
export function handleLocalPositions(p: LayerPlacement): Array<{ id: HandleId; x: number; y: number }> {
  const { w, h } = p.box;
  return [
    { id: "nw", x: 0, y: 0 },
    { id: "n", x: w / 2, y: 0 },
    { id: "ne", x: w, y: 0 },
    { id: "e", x: w, y: h / 2 },
    { id: "se", x: w, y: h },
    { id: "s", x: w / 2, y: h },
    { id: "sw", x: 0, y: h },
    { id: "w", x: 0, y: h / 2 },
  ];
}

/** True when the handle resizes rather than skews (scale is uniform here). */
export function isCornerHandle(id: HandleId): boolean {
  return id === "nw" || id === "ne" || id === "se" || id === "sw";
}

/**
 * Topmost layer containing the project-space point, or null.
 *
 * Iterates back to front so the visually topmost layer wins, and ignores layers
 * that are effectively invisible so a fade-out never steals a click.
 */
export function hitTest(placements: LayerPlacement[], x: number, y: number): LayerPlacement | null {
  for (let i = placements.length - 1; i >= 0; i -= 1) {
    const p = placements[i];
    if (p.alpha < 0.12) continue;
    const local = projectToLocal(p, x, y);
    if (local.x >= 0 && local.x <= p.box.w && local.y >= 0 && local.y <= p.box.h) return p;
  }
  return null;
}

/** Finds the placement for a clip id, if it is visible right now. */
export function placementFor(
  placements: LayerPlacement[],
  clipId: string,
): LayerPlacement | undefined {
  for (let i = placements.length - 1; i >= 0; i -= 1) {
    if (placements[i].clipId === clipId) return placements[i];
  }
  return undefined;
}
