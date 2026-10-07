import type { Clip, Project, Seconds } from "./types";

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp; returns 0 when the range is degenerate. */
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function round(v: number, decimals = 2): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

export function timeToFrame(time: Seconds, fps: number): number {
  return Math.round(time * fps);
}

export function frameToTime(frame: number, fps: number): Seconds {
  return frame / fps;
}

/** Snaps a time to the nearest whole frame boundary. */
export function snapToFrame(time: Seconds, fps: number): Seconds {
  return Math.round(time * fps) / fps;
}

/** Snaps down to the frame boundary at or before `time`. */
export function floorToFrame(time: Seconds, fps: number): Seconds {
  return Math.floor(time * fps + 1e-6) / fps;
}

/* ------------------------------------------------------------------ *
 * Clips
 * ------------------------------------------------------------------ */

export function clipEnd(clip: Clip): Seconds {
  return clip.start + clip.duration;
}

/** Local (in-clip) time for a timeline time, or null when outside the clip. */
export function localTimeAt(clip: Clip, timelineTime: Seconds): number | null {
  if (timelineTime < clip.start || timelineTime >= clipEnd(clip)) return null;
  return timelineTime - clip.start;
}

/** Maps clip-local time to a time in the underlying source media. */
export function sourceTimeAt(clip: Clip, localTime: Seconds): Seconds {
  return clip.trimIn + localTime * clip.speed;
}

/** Timeline length of a source range once `speed` is applied. */
export function sourceRangeToDuration(sourceLength: Seconds, speed: number): Seconds {
  const s = speed <= 0 ? 1 : speed;
  return sourceLength / s;
}

/* ------------------------------------------------------------------ *
 * Project
 * ------------------------------------------------------------------ */

/** Last moment occupied by any enabled clip; 0 for an empty timeline. */
export function contentDuration(project: Project): Seconds {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clipEnd(clip);
      if (end > max) max = end;
    }
  }
  return max;
}

/**
 * Timeline length used for playback and export.
 *
 * The **content decides**: the timeline ends where the last clip ends, which is
 * what the user sees and what an NLE exports.
 *
 * This used to be `max(content, settings.duration)`, which silently padded every
 * project out to the default 30s — a three-clip edit exported as 30 seconds with
 * 20-odd seconds of black at the end. `settings.duration` was a default that
 * nothing ever updated, so it could not be told apart from a deliberate choice.
 *
 * `settings.duration` now applies only to an **empty** timeline, where there is
 * no content to measure.
 */
export function effectiveDuration(project: Project): Seconds {
  const content = contentDuration(project);
  if (content > 0) return content;
  const authored = project.settings.duration;
  return authored > 0 ? authored : 1;
}

export function overlappingClips(track: { clips: Clip[] }, clip: Clip, ignoreId?: string): Clip[] {
  const a0 = clip.start;
  const a1 = clipEnd(clip);
  return track.clips.filter((c) => {
    if (c.id === clip.id || c.id === ignoreId) return false;
    return c.start < a1 && clipEnd(c) > a0;
  });
}

/** Orders clips by start time; used after inserts and moves. */
export function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

function pad(n: number, width = 2): string {
  return Math.floor(Math.abs(n)).toString().padStart(width, "0");
}

/** `HH:MM:SS:FF` — the conventional NLE timecode display. */
export function formatTimecode(time: Seconds, fps: number): string {
  const total = Math.max(0, time);
  const totalFrames = Math.round(total * fps);
  const frames = totalFrames % Math.max(1, Math.round(fps));
  const totalSeconds = Math.floor(totalFrames / Math.max(1, Math.round(fps)));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/** `12.34s`, `1:05.2` — compact duration for clip badges. */
export function formatDuration(time: Seconds): string {
  const total = Math.max(0, time);
  if (total < 60) return `${total.toFixed(total < 10 ? 2 : 1)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function aspectToSize(aspect: string, base = 1080): { width: number; height: number } {
  switch (aspect) {
    case "9:16":
      return { width: base, height: Math.round((base * 16) / 9) };
    case "1:1":
      return { width: base, height: base };
    case "4:5":
      return { width: base, height: Math.round((base * 5) / 4) };
    case "21:9":
      return { width: Math.round(base * 1.5), height: Math.round((base * 1.5 * 9) / 21) };
    case "16:9":
    default:
      return { width: Math.round((base * 16) / 9), height: base };
  }
}
