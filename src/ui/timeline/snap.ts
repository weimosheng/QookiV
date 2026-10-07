import { clipEnd } from "../../core/time";
import type { Project } from "../../core/types";

/**
 * Magnetic snapping for the timeline.
 *
 * Pure so the rules can be asserted directly: "does dragging a clip butt its
 * *tail* against the next cut?" is not something to verify by eye.
 *
 * Two stages, in order:
 * 1. magnet targets (clip edges, the playhead, zero, the project end) within a
 *    pixel tolerance, so alignment feels deliberate;
 * 2. otherwise the frame grid, so a clip never lands between frames.
 */

/** How close, in screen pixels, a magnet target grabs an edge. */
export const SNAP_TOLERANCE_PX = 7;

export interface SnapResult {
  /** The time to use. */
  time: number;
  /** The magnet target that was hit, or null when only the frame grid applied. */
  guide: number | null;
}

/** Rounds to the frame grid; the fallback when no magnet is in range. */
export function quantizeToFrame(time: number, fps: number): number {
  const frame = 1 / Math.max(1, fps);
  return Math.round(time / frame) * frame;
}

/**
 * Every time an edge should be able to stick to.
 *
 * `exclude` holds the ids being dragged: snapping a clip to where it already is
 * would make it feel glued in place.
 */
export function collectSnapTimes(
  project: Project,
  exclude: Iterable<string> = [],
  playhead?: number,
): number[] {
  const skip = new Set(exclude);
  // 0 is the timeline origin; the rest are real edges.
  const out: number[] = [0];
  if (playhead !== undefined) out.push(playhead);
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (skip.has(clip.id)) continue;
      out.push(clip.start, clipEnd(clip));
    }
  }
  return out.filter((value) => Number.isFinite(value) && value >= 0);
}

interface Candidate {
  time: number;
  distance: number;
}

function nearest(time: number, targets: number[], tolerance: number): Candidate | null {
  let best: Candidate | null = null;
  for (const target of targets) {
    const distance = Math.abs(target - time);
    if (distance > tolerance) continue;
    if (!best || distance < best.distance) best = { time: target, distance };
  }
  return best;
}

/**
 * Snaps a single edge (a trim handle, or the playhead) to the nearest target.
 *
 * Falls back to the frame grid rather than returning the raw time, so the result
 * is always frame-accurate.
 */
export function snapEdge(
  time: number,
  targets: number[],
  zoom: number,
  fps: number,
  tolerancePx = SNAP_TOLERANCE_PX,
): SnapResult {
  const tolerance = tolerancePx / Math.max(1e-6, zoom);
  const magnet = nearest(time, targets, tolerance);
  if (magnet) return { time: magnet.time, guide: magnet.time };
  return { time: quantizeToFrame(time, fps), guide: null };
}

/**
 * Snaps a dragged clip by whichever of its two edges is closest to a target.
 *
 * Head-only snapping (the previous behaviour) meant the only way to butt a clip
 * against the next cut was to guess its length; real editors snap either end.
 * Ties go to the head, which is the edge the pointer is actually holding.
 */
export function snapSpan(
  start: number,
  duration: number,
  targets: number[],
  zoom: number,
  fps: number,
  tolerancePx = SNAP_TOLERANCE_PX,
): SnapResult {
  const tolerance = tolerancePx / Math.max(1e-6, zoom);
  const head = nearest(start, targets, tolerance);
  const tail = nearest(start + duration, targets, tolerance);

  if (head && tail) {
    // Prefer the head on a tie: it is the edge under the pointer.
    if (tail.distance < head.distance) {
      return { time: start + (tail.time - (start + duration)), guide: tail.time };
    }
    return { time: start + (head.time - start), guide: head.time };
  }
  if (head) return { time: head.time, guide: head.time };
  if (tail) return { time: start + (tail.time - (start + duration)), guide: tail.time };

  return { time: quantizeToFrame(start, fps), guide: null };
}
