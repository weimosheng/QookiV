import type { Clip } from "./types";

/**
 * Sub-lane packing for the timeline.
 *
 * A track may legitimately hold clips that overlap in time: the compositor paints
 * them in array order, which is how a template layers a logo, a headline and a
 * caption without needing a track for each. The timeline, though, can only draw
 * one clip per vertical slot, so overlapping clips are packed into stacked
 * sub-lanes.
 *
 * Lives in `core` rather than the UI because it is pure interval arithmetic and
 * worth testing on its own.
 */

export interface LaneAssignment {
  /** Sub-lane index per clip id. */
  laneOf: Map<string, number>;
  /** How many sub-lanes the track needs; always at least 1. */
  lanes: number;
}

/** Height of one sub-lane, in CSS pixels. */
export const LANE_H = 32;
/** Vertical breathing room above and below a track's sub-lanes. */
export const LANE_PAD = 3;

/** Pixel height a track needs for its packed sub-lanes. */
export function laneRowHeight(lanes: number): number {
  return lanes * LANE_H + LANE_PAD * 2;
}

/** Pixel height every track needs, so the timeline can size itself to its content. */
export function totalLaneHeight(trackClips: Clip[][]): number {
  let total = 0;
  for (const clips of trackClips) total += laneRowHeight(assignLanes(clips).lanes);
  return total;
}

/**
 * Greedy interval packing.
 *
 * Clips are visited in start order and each takes the first lane whose last clip
 * has already ended. Greedy "first fit" yields the minimum possible number of
 * lanes for an interval graph, so a track that never overlaps stays exactly one
 * lane tall.
 */
export function assignLanes(clips: Clip[]): LaneAssignment {
  const sorted = [...clips].sort((a, b) => a.start - b.start || a.duration - b.duration);
  const laneEnds: number[] = [];
  const laneOf = new Map<string, number>();

  for (const clip of sorted) {
    const end = clip.start + clip.duration;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= clip.start + 1e-6);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    laneOf.set(clip.id, lane);
  }

  return { laneOf, lanes: Math.max(1, laneEnds.length) };
}

/** Largest sub-lane count across every track, used to size the timeline. */
export function maxLanes(clipsByTrack: Clip[][]): number {
  let max = 1;
  for (const clips of clipsByTrack) {
    max = Math.max(max, assignLanes(clips).lanes);
  }
  return max;
}
