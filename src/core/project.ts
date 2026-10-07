import { newId } from "./ids";
import { QOOKIX_PRESENTATION } from "./theme";
import type {
  AnimationMap,
  Asset,
  Clip,
  ClipRef,
  Project,
  ProjectSettings,
  Seconds,
  ThemeTokens,
  Track,
  TrackKind,
  Transition,
  VisualClip,
} from "./types";
import { SCHEMA_VERSION, VISUAL_KINDS } from "./types";

/**
 * Project construction, queries and normalisation.
 *
 * All functions here are pure: mutating edits live in the store so that every
 * change can be captured by the undo stack.
 */

export function createProjectSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    aspect: "16:9",
    duration: 30,
    background: "#000000",
    ...overrides,
  };
}

export function createTrack(kind: TrackKind = "visual", name?: string): Track {
  return {
    id: newId("track"),
    name: name ?? (kind === "audio" ? "音频" : "图层"),
    kind,
    clips: [],
    muted: false,
    hidden: false,
    locked: false,
  };
}

export function createProject(overrides: Partial<Project> = {}): Project {
  const theme: ThemeTokens = overrides.theme ?? QOOKIX_PRESENTATION;
  const settings = createProjectSettings(overrides.settings);
  const now = Date.now();
  return {
    id: newId("proj"),
    schemaVersion: SCHEMA_VERSION,
    name: "未命名宣传片",
    settings,
    theme,
    assets: [],
    // Paint order: index 0 draws first (furthest back).
    tracks: [
      createTrack("visual", "背景"),
      createTrack("visual", "内容"),
      createTrack("visual", "叠加"),
      createTrack("audio", "音频"),
    ],
    slots: {},
    detachedClipIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export function findTrack(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

export function findClipRef(project: Project, clipId: string): ClipRef | undefined {
  for (const track of project.tracks) {
    if (track.clips.some((c) => c.id === clipId)) {
      return { trackId: track.id, clipId };
    }
  }
  return undefined;
}

export function findClip(project: Project, clipId: string): Clip | undefined {
  for (const track of project.tracks) {
    const found = track.clips.find((c) => c.id === clipId);
    if (found) return found;
  }
  return undefined;
}

export function findAsset(project: Project, assetId: string | undefined): Asset | undefined {
  if (!assetId) return undefined;
  return project.assets.find((a) => a.id === assetId);
}

export function allClips(project: Project): Clip[] {
  const out: Clip[] = [];
  for (const track of project.tracks) out.push(...track.clips);
  return out;
}

export function visualTracks(project: Project): Track[] {
  return project.tracks.filter((t) => t.kind === "visual");
}

export function audioTracks(project: Project): Track[] {
  return project.tracks.filter((t) => t.kind === "audio");
}

/** Visual tracks in composite order: back to front. */
export function paintOrderTracks(project: Project): Track[] {
  return visualTracks(project);
}

export function clipCount(project: Project): number {
  return project.tracks.reduce((n, t) => n + t.clips.length, 0);
}

/** Assets that are referenced by at least one clip. */
export function usedAssetIds(project: Project): Set<string> {
  const used = new Set<string>();
  for (const clip of allClips(project)) {
    if (clip.kind === "image" || clip.kind === "video" || clip.kind === "audio") {
      if (clip.props.assetId) used.add(clip.props.assetId);
    } else if (clip.kind === "device" && clip.props.assetId) {
      used.add(clip.props.assetId);
    }
  }
  return used;
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/**
 * Clamps keyframe times into the clip's own span.
 *
 * Keyframes are clip-local, so a keyframe beyond `duration` can never be reached:
 * an exit fade authored as `fadeOut(4.45, 0.6)` on a 5s clip would only reach ~92%
 * opacity before the clip disappears, producing a visible pop at the cut. Trimming
 * the timeline of every curve to the clip makes each fade actually finish, in one
 * place, for hand-authored clips and generated templates alike.
 */
function clampAnimation(animation: AnimationMap, duration: number): AnimationMap {
  let changed = false;
  const out: AnimationMap = {};
  for (const [path, frames] of Object.entries(animation)) {
    out[path] = frames.map((frame) => {
      const time = Math.max(0, Math.min(duration, frame.time));
      if (time === frame.time) return frame;
      changed = true;
      return { ...frame, time };
    });
  }
  return changed ? out : animation;
}

export function clampClip(clip: Clip, maxDuration: number): Clip {
  const duration = Math.max(1 / 60, clip.duration);
  const start = Math.max(0, Math.min(clip.start, maxDuration));
  return {
    ...clip,
    start,
    duration,
    trimIn: Math.max(0, clip.trimIn),
    speed: clip.speed === 0 ? 1 : clip.speed,
    opacity: Math.max(0, Math.min(1, clip.opacity)),
    animation: clampAnimation(clip.animation, duration),
    transitionIn: clampTransition(clip.transitionIn),
    transitionOut: clampTransition(clip.transitionOut),
  };
}

/** Ensures a transition has a valid easing and a positive duration. */
function clampTransition(t: Transition | undefined): Transition | undefined {
  if (!t) return undefined;
  return {
    kind: t.kind,
    duration: Math.max(0.05, t.duration),
    easing: t.easing ?? "easeOutCubic",
  };
}

/** The asset a clip draws from, for the kinds that have one. */
export function clipAsset(project: Project, clip: Clip): Asset | undefined {
  switch (clip.kind) {
    case "image":
    case "video":
    case "audio":
    case "device":
      return findAsset(project, clip.props.assetId);
    default:
      return undefined;
  }
}

/**
 * Keeps a clip inside the media it actually has.
 *
 * `clampClip` cannot do this — it never sees the asset list. Without the check a
 * **speed change** is enough to demand more source than exists: doubling a 10s
 * clip's speed needs 20s from a 10s file, and the overrun renders as black video
 * or silence, with nothing anywhere to explain it. The trim handle already
 * refuses to extend past the source, so this makes the rest of the app agree
 * with it.
 *
 * Assets with an unknown length (or none at all, like a shape) are left alone:
 * clamping to a guess would be worse than doing nothing.
 */
export function clampClipToSource(project: Project, clip: Clip): Clip {
  const asset = clipAsset(project, clip);
  if (!asset) return clip;
  if (asset.kind !== "video" && asset.kind !== "audio") return clip;

  const total = asset.duration;
  if (!total || total <= 0) return clip;

  const frame = 1 / 60;
  const speed = clip.speed > 0 ? clip.speed : 1;

  // An in-point at or past the end is pulled back onto the last frame, and the
  // duration then has to fit in whatever is left — repairing only the in-point
  // still leaves the clip reaching past the file.
  let trimIn = Math.max(0, clip.trimIn);
  if (trimIn >= total) trimIn = Math.max(0, total - frame);

  // Never below one frame: a zero-length clip is worse than a frame of black,
  // and `clampClip` would raise it back to a frame anyway.
  const capacity = Math.max(frame, (total - trimIn) / speed);
  if (trimIn === clip.trimIn && clip.duration <= capacity + 1e-9) return clip;
  return clampClip({ ...clip, trimIn, duration: Math.min(clip.duration, capacity) }, 1e6);
}

/** Sorts clips, drops duplicates and repairs obviously invalid values. */
export function normalizeProject(project: Project): Project {
  const tracks = project.tracks.map((track) => ({
    ...track,
    clips: [...track.clips]
      .map((c) => clampClipToSource(project, clampClip(c, 1e6)))
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)),
  }));
  return { ...project, tracks };
}

export function isVisual(clip: Clip): clip is VisualClip {
  return (VISUAL_KINDS as readonly string[]).includes(clip.kind);
}

export function projectAspectLabel(settings: ProjectSettings): string {
  return settings.aspect;
}

export function totalSourceLength(clip: Clip, fps: number): Seconds {
  return Math.max(clip.duration, 1 / fps);
}
