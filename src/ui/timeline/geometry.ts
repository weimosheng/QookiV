import { assignLanes, LANE_H, LANE_PAD, laneRowHeight } from "../../core/lanes";
import type { Project, Track } from "../../core/types";

/**
 * Timeline row geometry.
 *
 * The rows are laid out by flexbox, but marquee selection and drop targeting
 * need to know where things actually are, so the same layout is computed here as
 * a plain list of rectangles. Kept free of React so it can be asserted directly.
 */

/**
 * Width of the scrollable grid area, in pixels.
 *
 * Must be at least the viewport. The old rule was just
 * `max(900, (duration + 3) * zoom)`, so once the content was narrower than the
 * panel — zoomed out, or simply a short project — the rows, their borders and the
 * ruler all stopped partway across and the rest of the timeline was bare panel
 * background. It read as the tracks being cut in half.
 */
export function gridWidth(duration: number, zoom: number, viewportWidth: number): number {
  // Sanitised: a corrupt project can carry a NaN duration, and the viewport is
  // 0 until the container has been measured. Either would otherwise poison every
  // downstream layout number.
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const safeViewport = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  const content = Math.max(MIN_CONTENT_PX, (safeDuration + TAIL_SECONDS) * safeZoom);
  return Math.max(content, Math.max(0, safeViewport - HEADER_W));
}

/** Floor for the content area, so a very short project still has room to drag. */
export const MIN_CONTENT_PX = 900;
/** Empty room kept after the last clip, so a clip can be dragged past the end. */
export const TAIL_SECONDS = 3;

/**
 * Width of the track header column.
 *
 * Sized so a single-line header fits without clipping: a 13px icon, a readable
 * stretch of name, the sub-lane badge and four 22px buttons.
 */
export const HEADER_W = 208;
export const RULER_H = 30;
export const AUDIO_SECTION_H = 24;

export interface RowLayout {
  track: Track;
  /** Offset from the top of the timeline grid, in pixels. */
  top: number;
  height: number;
  /** True for the synthetic "音频" divider, which hosts no clips. */
  section?: boolean;
}

export interface TimelineLayout {
  rows: RowLayout[];
  byTrackId: Map<string, RowLayout>;
  /** Height of the ruler + every row. */
  totalHeight: number;
}

/** Visual tracks topmost-first, then an audio section — matching the render order. */
export function layoutRows(project: Project): TimelineLayout {
  const visual = project.tracks.filter((t) => t.kind === "visual").reverse();
  const audio = project.tracks.filter((t) => t.kind === "audio").reverse();

  const rows: RowLayout[] = [];
  let top = RULER_H;

  for (const track of visual) {
    const height = laneRowHeight(assignLanes(track.clips).lanes);
    rows.push({ track, top, height });
    top += height;
  }

  if (audio.length > 0) {
    // The section header is not a track; a synthetic row keeps the arithmetic
    // in one place for both rendering and hit testing.
    rows.push({ track: audio[0], top, height: AUDIO_SECTION_H, section: true });
    top += AUDIO_SECTION_H;
  }

  for (const track of audio) {
    const height = laneRowHeight(assignLanes(track.clips).lanes);
    rows.push({ track, top, height });
    top += height;
  }

  const byTrackId = new Map<string, RowLayout>();
  for (const row of rows) {
    // A section marker shares its track id; the real row must win.
    if (!byTrackId.has(row.track.id) || row.height > (byTrackId.get(row.track.id)?.height ?? 0)) {
      byTrackId.set(row.track.id, row);
    }
  }

  return { rows, byTrackId, totalHeight: top };
}

/** True for the synthetic "音频" section divider row. */
export function isSectionRow(row: RowLayout): boolean {
  return row.section === true;
}

export interface ClipRect {
  clipId: string;
  trackId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Screen-space (grid-space) rectangle of every clip, including its sub-lane.
 *
 * `x` is offset by the sticky header so these rectangles share a coordinate
 * system with pointer positions measured against the grid element — which is what
 * marquee selection compares against.
 */
export function clipRects(layout: TimelineLayout, zoom: number): ClipRect[] {
  const out: ClipRect[] = [];
  for (const row of layout.rows) {
    if (isSectionRow(row)) continue;
    const { laneOf } = assignLanes(row.track.clips);
    for (const clip of row.track.clips) {
      const lane = laneOf.get(clip.id) ?? 0;
      out.push({
        clipId: clip.id,
        trackId: row.track.id,
        x: HEADER_W + clip.start * zoom,
        y: row.top + LANE_PAD + lane * LANE_H,
        w: Math.max(6, clip.duration * zoom - 1),
        h: LANE_H - 4,
      });
    }
  }
  return out;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function normalizeBox(a: { x: number; y: number }, b: { x: number; y: number }): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Ids of every clip whose rectangle touches `box`. */
export function clipIdsInBox(rects: ClipRect[], box: Box): string[] {
  const ids: string[] = [];
  for (const rect of rects) {
    if (intersects(box, rect)) ids.push(rect.clipId);
  }
  return ids;
}

/** All clip edges on visible, unlocked tracks — the "edit points" ↑/↓ jump between. */
export function editPoints(project: Project): number[] {
  const points: number[] = [0];
  for (const track of project.tracks) {
    if (track.locked || track.hidden) continue;
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      points.push(clip.start, clip.start + clip.duration);
    }
  }
  return Array.from(new Set(points)).sort((a, b) => a - b);
}
