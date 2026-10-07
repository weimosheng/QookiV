/**
 * Headless smoke test for the QookiV engine.
 *
 * There is no browser in this environment, so this harness installs a minimal
 * fake canvas `document` and then runs the *real* compositor over every built-in
 * template at many timestamps. It cannot judge whether a frame looks good, but it
 * does prove the render path runs without throwing and — more usefully — that no
 * NaN or Infinity ever reaches a canvas call, which is exactly how a bad keyframe
 * or a divide-by-zero shows up in practice.
 *
 * Built for Node by `vite.smoke.config.ts` and run with `node .scratch/smoke.mjs`.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import App from "../src/App";
import { getPath, resolveClipAt } from "../src/core/animation";import {
  createAudioClip,
  createDeviceClip,
  createImageClip,
  createShapeClip,
  createTextClip,
  createVideoClip,
} from "../src/core/clips";
import {
  applyNumberTransition,
  applyVisibleNumber,
  applyVisibleValue,
  hasAnimatableSize,
  planSizeTransition,
} from "../src/core/propEdit";
import {
  clipMotionSummary,
  clipTransitionSummary,
  keyframeCount,
  pathLabel,
} from "../src/ui/timeline/labels";
import { sequenceDrops } from "../src/ui/timeline/drop";
import { assignLanes } from "../src/core/lanes";
import { contentDuration, effectiveDuration } from "../src/core/time";
import { applyTransform, snapshotTransform } from "../src/core/transform";
import { createProject, createTrack, findClip, clipAsset, normalizeProject } from "../src/core/project";
import { PlaybackEngine, playback } from "../src/engine/PlaybackEngine";
import { peaksFromChannels, quantizeThumbnailTime, requestThumbnail, thumbnailStep } from "../src/engine/clipMedia";
import { MediaPool } from "../src/engine/MediaPool";
import type { Asset, Clip, MediaClipProps, Project } from "../src/core/types";
import { exportStandaloneHtml } from "../src/export/html/exportHtml";
import { exportVideo } from "../src/export/video";
import { planExport } from "../src/export/video/exportVideo";
import { buildVolumeEnvelope, collectAudibleClips } from "../src/export/video/audio";
import { defaultVideoBitrate } from "../src/export/video/exportVideo";
import { formatBytes, matchesQuery, sortAssets } from "../src/services/mediaSort";
import { clipForAsset, defaultClipDuration } from "../src/services/assetClip";
import { Renderer } from "../src/render/Renderer";
import { collectPlacements, hitTest, localToProject, projectToLocal } from "../src/render/scene";
import {
  AUTOSAVE_KEY,
  clearAutosave,
  readAutosave,
  recoveryClipCount,
  writeAutosave,
} from "../src/services/autosave";
import { useEditor } from "../src/store/editorStore";
import { buildFromTemplate } from "../src/templates/apply";
import { getTemplate, TEMPLATES } from "../src/templates/registry";
import { defaultSlotValues } from "../src/templates/types";
import type { TemplateSlot } from "../src/templates/types";
import {
  clipIdsInBox,
  clipRects,
  editPoints,
  gridWidth,
  HEADER_W,
  layoutRows,
  RULER_H,
} from "../src/ui/timeline/geometry";
import type { Box } from "../src/ui/timeline/geometry";
import { keyframeMarkers, shouldShowArtwork, tileCount, tileSourceTime } from "../src/ui/timeline/ClipArtwork";
import {
  attachTimelineWheel,
  autoscrollForPointer,
  dragDeltaTime,
  MAX_ZOOM,
  MIN_ZOOM,
  registerTimelineViewport,
  tickAutoscroll,
} from "../src/ui/timeline/viewport";
import { collectSnapTimes, quantizeToFrame, snapEdge, snapSpan } from "../src/ui/timeline/snap";

/* ------------------------------------------------------------------ *
 * Fake canvas
 * ------------------------------------------------------------------ */

const badNumbers: string[] = [];

function guard(name: string, args: unknown[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (typeof value === "number" && !Number.isFinite(value)) {
      badNumbers.push(`${name}(arg${i}=${String(value)})`);
    }
  }
}

function createFakeCtx(canvas: FakeCanvas): Record<string, unknown> {
  const noop = () => undefined;
  const gradient = { addColorStop: noop };
  const pattern = { setTransform: noop };

  const method = (name: string) =>
    (...args: unknown[]) => {
      guard(name, args);
      return undefined;
    };

  const ctx: Record<string, unknown> = {
    canvas,
    filter: "none",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    shadowColor: "transparent",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    font: "10px sans-serif",
    textAlign: "left",
    textBaseline: "alphabetic",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
    strokeStyle: "#000",
    fillStyle: "#000",
    imageSmoothingEnabled: true,
  };

  for (const name of [
    "save", "restore", "translate", "rotate", "scale", "transform", "setTransform",
    "resetTransform", "beginPath", "closePath", "moveTo", "lineTo", "arc", "arcTo",
    "ellipse", "rect", "roundRect", "fill", "stroke", "clip", "fillRect", "strokeRect",
    "clearRect", "fillText", "strokeText", "drawImage", "setLineDash", "putImageData",
  ]) {
    ctx[name] = method(name);
  }

  ctx.getLineDash = () => [];
  ctx.measureText = (text: string) => {
    // A crude but monotonic width model: enough for wrapping to terminate.
    const width = [...String(text)].length * 10;
    return { width, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
  };
  ctx.createLinearGradient = () => gradient;
  ctx.createRadialGradient = () => gradient;
  ctx.createPattern = () => pattern;
  ctx.getImageData = (_x: number, _y: number, w: number, h: number) => ({
    data: new Uint8ClampedArray(Math.max(4, Math.abs(w * h * 4))),
    width: w,
    height: h,
  });
  ctx.createImageData = (w: number, h: number) => ({
    data: new Uint8ClampedArray(Math.max(4, Math.abs(w * h * 4))),
    width: w,
    height: h,
  });

  return ctx;
}

interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, unknown>;
  getContext: () => Record<string, unknown>;
}

function createFakeCanvas(width = 300, height = 150): FakeCanvas {
  const canvas = {
    width,
    height,
    style: {},
  } as FakeCanvas;
  const ctx = createFakeCtx(canvas);
  canvas.getContext = () => ctx;
  return canvas;
}

interface GlobalWithDom {
  document?: unknown;
  window?: unknown;
  Image?: unknown;
  HTMLVideoElement?: unknown;
  Audio?: unknown;
}
const globals = globalThis as GlobalWithDom;
globals.document = {
  createElement: (tag: string) => (tag === "canvas" ? createFakeCanvas() : { style: {} }),
};
globals.window = globalThis;

/**
 * Queued, never invoked synchronously: `PlaybackEngine.tick` re-schedules itself
 * through `requestAnimationFrame`, so a synchronous stub would recurse forever.
 * Code that defers work (zoom's scroll adjustment) simply leaves it queued.
 */
const rafQueue: Array<(time: number) => void> = [];
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
  fn: (time: number) => void,
) => {
  rafQueue.push(fn);
  return rafQueue.length;
};
(globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => undefined;

/**
 * Runs the queued animation-frame callbacks once with `time`, so a test can decide
 * how much wall time a frame took (a throttled window is a 1s gap).
 */
function drainRaf(time: number): void {
  const queued = rafQueue.splice(0);
  for (const fn of queued) fn(time);
}

/**
 * A media element stub.
 *
 * Playback sync is the one area that had two shipped bugs, and it cannot be
 * exercised at all without an element that records `play`/`pause` and counts
 * seek assignments — so the stub is worth its length. `seekCount` in particular
 * is what proves a stutter fix: a seek per frame is the bug.
 */
class FakeMedia {
  src = "";
  duration = 30;
  volume = 1;
  muted = false;
  paused = true;
  playbackRate = 1;
  readyState = 1;
  preload = "";
  playsInline = false;
  seeking = false;
  /** Number of `play()` calls that were not already playing. */
  playCalls = 0;
  /** Number of `pause()` calls that actually stopped something. */
  pauseCalls = 0;
  /** Number of `currentTime` assignments — each one is a seek. */
  seekCount = 0;

  private listeners = new Map<string, Array<() => void>>();
  private time = 0;
  /**
   * Models a seek that has not landed yet: the assignment is recorded but the
   * element keeps reporting its old position. This is exactly the condition that
   * used to trigger a fresh seek on every frame.
   */
  ignoreSeeks = false;
  /**
   * Models `seeked` firing as soon as the seek lands. Real elements clear the
   * pool's in-flight flag at that point, which is what let the old code seek
   * again on the very next frame — without this, the stub would hide the storm.
   */
  autoSeeked = true;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.seekCount += 1;
    if (this.ignoreSeeks) return;
    this.time = value;
    if (this.autoSeeked) this.dispatch("seeked");
  }

  /** Advances playback the way a real element would, without counting a seek. */
  advance(delta: number): void {
    this.time += delta;
  }

  /** True once playback has run to the end and stopped there. */
  get ended(): boolean {
    return this.paused && this.duration > 0 && this.time >= this.duration - 1e-6;
  }

  /** Forces the reported position without recording a seek (test setup). */
  setTimeRaw(value: number): void {
    this.time = value;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== fn),
    );
  }

  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  play(): Promise<void> {
    if (this.paused) this.playCalls += 1;
    // The spec seeks an ended element back to the start when `play()` is called on
    // it. Modelling that here is what makes "the clip outlasts its media" testable:
    // without the guard in `MediaPool` this rewinds to 0 and the element replays
    // the same few seconds forever.
    if (this.ended) this.time = 0;
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    if (!this.paused) this.pauseCalls += 1;
    this.paused = true;
  }

  load(): void {}
  removeAttribute(): void {}
  getAttribute(name: string): string | null {
    return name === "src" ? this.src : null;
  }
}

/** Every media element the pool creates, newest last. */
const createdMedia: FakeMedia[] = [];

function installMediaStubs(): void {
  globals.document = {
    createElement: (tag: string) => {
      if (tag === "canvas") return createFakeCanvas();
      const el = new FakeMedia();
      createdMedia.push(el);
      return el;
    },
  };
  globals.Audio = function FakeAudio() {
    const el = new FakeMedia();
    createdMedia.push(el);
    return el;
  };
}

/** No media: every layer falls back to its placeholder branch. */
const media = {
  getImage: () => null,
  getVideo: () => null,
  getSize: () => null,
  isReady: () => true,
};

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

interface Report {
  id: string;
  name: string;
  clips: number;
  tracks: number;
  duration: number;
  /** `settings.duration`: the authored timeline length. */
  authored: number;
  /** Last moment actually occupied by a clip. */
  content: number;
  /** What the template declares it should be. */
  declared: number;
  frames: number;
  /** Deepest timeline lane packing across the project's tracks. */
  lanes: number;
  problems: string[];
}

const reports: Report[] = [];

function checkTemplate(id: string): Report {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`unknown template ${id}`);
  const problems: string[] = [];

  // Slot definitions must be internally consistent: a declared type has to match the
  // shape of its default, otherwise the form hands the template a value it cannot
  // read. `list` is the one type whose default is not a primitive — and a list
  // entry's fields are described with the same `TemplateSlot` machinery (so a list
  // can nest inside a list), which means this check has to recurse.
  const shapeOf = (type: TemplateSlot["type"]): string =>
    type === "list"
      ? "list"
      : type === "number"
        ? "number"
        : type === "boolean"
          ? "boolean"
          : "string";
  const checkSlot = (slot: TemplateSlot, where: string): void => {
    const actual = Array.isArray(slot.default) ? "list" : typeof slot.default;
    if (actual !== shapeOf(slot.type)) {
      problems.push(`${where}${slot.id}: type=${slot.type} but default is ${actual}`);
    }
    for (const field of slot.item?.fields ?? []) checkSlot(field, `${where}${slot.id}.`);
  };
  for (const slot of template.slots) checkSlot(slot, "slot ");

  const values = defaultSlotValues(template);
  let project: Project;
  try {
    project = buildFromTemplate(template, values, []);
  } catch (error) {
    return {
      id,
      name: template.name,
      clips: 0,
      tracks: 0,
      duration: 0,
      frames: 0,
      problems: [`build() threw: ${String(error)}`],
    };
  }

  const clips: Clip[] = project.tracks.flatMap((t) => t.clips);
  if (clips.length === 0) problems.push("built no clips");

  // Timeline lane packing: a track must be able to show every clip without two
  // of them landing in the same lane at the same time (which is what made the
  // timeline unreadable before lanes existed).
  let deepestLanes = 1;
  for (const track of project.tracks) {
    const { laneOf, lanes } = assignLanes(track.clips);
    deepestLanes = Math.max(deepestLanes, lanes);
    for (const clip of track.clips) {
      if (!laneOf.has(clip.id)) problems.push(`${clip.name}: no timeline lane assigned`);
    }
    for (let i = 0; i < track.clips.length; i += 1) {
      for (let j = i + 1; j < track.clips.length; j += 1) {
        const a = track.clips[i];
        const b = track.clips[j];
        if (laneOf.get(a.id) !== laneOf.get(b.id)) continue;
        const overlaps =
          a.start < b.start + b.duration - 1e-6 && b.start < a.start + a.duration - 1e-6;
        if (overlaps) {
          problems.push(
            `track "${track.name}": "${a.name}" and "${b.name}" share lane ${String(
              laneOf.get(a.id),
            )} while overlapping in time`,
          );
        }
      }
    }
  }

  let maxEnd = 0;
  for (const clip of clips) {
    const end = clip.start + clip.duration;
    maxEnd = Math.max(maxEnd, end);

    if (!Number.isFinite(clip.start) || clip.start < 0) {
      problems.push(`${clip.name}: bad start ${clip.start}`);
    }
    if (!Number.isFinite(clip.duration) || clip.duration <= 0) {
      problems.push(`${clip.name}: bad duration ${clip.duration}`);
    }
    if (!Number.isFinite(clip.speed) || clip.speed <= 0) {
      problems.push(`${clip.name}: bad speed ${clip.speed}`);
    }

    // Every animated path must resolve on the clip, or the renderer silently
    // animates nothing at all.
    for (const [path, frames] of Object.entries(clip.animation)) {
      if (getPath(clip, path) === undefined) {
        problems.push(`${clip.name}: animation path "${path}" does not exist`);
      }
      if (frames.length === 0) problems.push(`${clip.name}: "${path}" has no keyframes`);
      for (const frame of frames) {
        if (!Number.isFinite(frame.time) || frame.time < 0) {
          problems.push(`${clip.name}: "${path}" keyframe time ${frame.time}`);
        }
        if (typeof frame.value === "number" && !Number.isFinite(frame.value)) {
          problems.push(`${clip.name}: "${path}" keyframe value ${frame.value}`);
        }
      }
      const last = frames[frames.length - 1];
      if (last && last.time > clip.duration + 0.001) {
        problems.push(
          `${clip.name}: "${path}" last keyframe at ${last.time.toFixed(2)}s exceeds clip ${clip.duration.toFixed(2)}s`,
        );
      }
    }

    for (const [key, value] of Object.entries(clip.transform)) {
      if (!Number.isFinite(value as number)) {
        problems.push(`${clip.name}: transform.${key} = ${String(value)}`);
      }
    }
    if (clip.kind === "device" && !clip.props.assetId) {
      // Expected when nothing was imported; the layer draws a placeholder.
      continue;
    }
  }

  if (maxEnd > template.duration + 0.06) {
    problems.push(
      `content runs to ${maxEnd.toFixed(2)}s but the template declares ${template.duration}s`,
    );
  }

  // Render sweep across the whole timeline.
  const total = effectiveDuration(project);
  const renderer = new Renderer(project, media);
  const canvas = createFakeCanvas(project.settings.width, project.settings.height);
  const ctx = canvas.getContext() as unknown as CanvasRenderingContext2D;
  const before = badNumbers.length;
  let frames = 0;
  const step = Math.max(1 / 30, total / 90);

  for (let t = 0; t <= total + 1e-6; t += step) {
    try {
      renderer.renderFrame(ctx, t, { quality: "preview" });
      frames += 1;
    } catch (error) {
      problems.push(`render at ${t.toFixed(2)}s threw: ${String(error)}`);
      break;
    }
  }
  const produced = badNumbers.length - before;
  if (produced > 0) {
    const sample = Array.from(new Set(badNumbers.slice(before, before + 5)));
    problems.push(`${produced} non-finite canvas argument(s), e.g. ${sample.join(", ")}`);
  }

  return {
    id,
    name: template.name,
    clips: clips.length,
    tracks: project.tracks.length,
    duration: total,
    authored: project.settings.duration,
    content: contentDuration(project),
    declared: template.duration,
    frames,
    lanes: deepestLanes,
    problems,
  };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

console.log("QookiV engine smoke test");
console.log("========================");

for (const template of TEMPLATES) {
  try {
    reports.push(checkTemplate(template.id));
  } catch (error) {
    reports.push({
      id: template.id,
      name: template.name,
      clips: 0,
      tracks: 0,
      duration: 0,
      authored: 0,
      content: 0,
      declared: template.duration,
      frames: 0,
      problems: [`harness error: ${String(error)}`],
    });
  }
}

// The empty project must also render, including with no assets at all.
try {
  const empty = createProject();
  const renderer = new Renderer(empty, media);
  const canvas = createFakeCanvas(empty.settings.width, empty.settings.height);
  renderer.renderFrame(canvas.getContext() as unknown as CanvasRenderingContext2D, 0);
  console.log("empty project       : renders OK");
} catch (error) {
  console.log(`empty project       : THREW ${String(error)}`);
  process.exitCode = 1;
}

let failures = 0;
for (const report of reports) {
  const ok = report.problems.length === 0;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${report.id.padEnd(16)} ${String(report.clips).padStart(3)} clips  ` +
      `${report.tracks} tracks  ${report.duration.toFixed(1)}s  ` +
      `(authored ${report.authored.toFixed(1)} / content ${report.content.toFixed(1)} / declared ${report.declared.toFixed(1)})  ` +
      `${String(report.lanes).padStart(2)} lanes deep  ${report.frames} frames rendered`,
  );
  for (const problem of report.problems) console.log(`        - ${problem}`);
}

console.log("========================");
console.log(
  failures === 0
    ? `all ${reports.length} templates passed`
    : `${failures} of ${reports.length} templates failed`,
);
if (failures > 0) process.exitCode = 1;

/* ------------------------------------------------------------------ *
 * Direct-manipulation geometry
 *
 * The preview's drag handles depend on local→project and project→local being
 * exact inverses; if they drift, the selection frame slides away from the layer
 * it is supposed to be grabbing.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("preview geometry");
const geoProblems: string[] = [];

{
  const template = TEMPLATES[0];
  const project = buildFromTemplate(template, defaultSlotValues(template), []);
  const canvas = createFakeCanvas(project.settings.width, project.settings.height);
  const ctx = canvas.getContext() as unknown as CanvasRenderingContext2D;
  const placements = collectPlacements(ctx, project, media, template.duration * 0.55);

  console.log(`  ${placements.length} layer placements at ${(template.duration * 0.55).toFixed(1)}s`);

  if (placements.length === 0) geoProblems.push("no layers visible at the sampled time");

  for (const p of placements) {
    const probes: Array<[number, number]> = [
      [0, 0],
      [p.box.w, 0],
      [p.box.w, p.box.h],
      [0, p.box.h],
      [p.box.w / 2, p.box.h / 2],
    ];
    for (const [lx, ly] of probes) {
      const proj = localToProject(p, lx, ly);
      if (!Number.isFinite(proj.x) || !Number.isFinite(proj.y)) {
        geoProblems.push(`${p.clip.name}: non-finite project point`);
        continue;
      }
      const back = projectToLocal(p, proj.x, proj.y);
      if (Math.abs(back.x - lx) > 0.02 || Math.abs(back.y - ly) > 0.02) {
        geoProblems.push(
          `${p.clip.name}: round-trip drift at (${lx},${ly}) → (${back.x.toFixed(2)},${back.y.toFixed(2)})`,
        );
      }
    }
  }

  // The topmost opaque layer's centre must hit-test back to itself.
  const topmost = [...placements].reverse().find((p) => p.alpha >= 0.12);
  if (topmost) {
    const centre = localToProject(topmost, topmost.box.w / 2, topmost.box.h / 2);
    const hit = hitTest(placements, centre.x, centre.y);
    if (hit?.clipId !== topmost.clipId) {
      geoProblems.push(
        `topmost layer centre hit "${hit?.clip.name ?? "nothing"}" instead of "${topmost.clip.name}"`,
      );
    }
  }

  // A point far outside the canvas must hit nothing.
  if (hitTest(placements, -5000, -5000)) {
    geoProblems.push("hitTest matched a point outside the frame");
  }
}

if (geoProblems.length === 0) {
  console.log("  PASS  local↔project transforms are exact and hit testing agrees");
} else {
  for (const problem of geoProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Editing a transform that is also keyframed
 *
 * Keyframes hold absolute values and `resolveClipAt` replaces the base
 * transform with them, so writing `transform.y` on a clip whose entrance
 * animates y used to change nothing on screen — dragging such a clip moved
 * horizontally but not vertically. These assertions pin that down: an edit must
 * move the *rendered* position by the same amount, without distorting the curve.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("transform editing vs keyframes");
const txProblems: string[] = [];

{
  const template = TEMPLATES[0];
  const project = buildFromTemplate(template, defaultSlotValues(template), []);
  const clips = project.tracks.flatMap((t) => t.clips);
  const animated = clips.filter((c) => (c.animation["transform.y"]?.length ?? 0) > 1);

  console.log(`  ${animated.length} of ${clips.length} clips animate transform.y`);
  if (animated.length === 0) {
    txProblems.push("expected the flagship template to animate transform.y on some clips");
  }

  const visibleY = (clip: Parameters<typeof resolveClipAt>[0], t: number): number =>
    (resolveClipAt(clip, t) as { transform: { y: number } }).transform.y;

  for (const clip of animated.slice(0, 8)) {
    const times = [0.05, clip.duration * 0.35, clip.duration * 0.65, clip.duration * 0.95];
    const before = times.map((t) => visibleY(clip, t));

    const snap = snapshotTransform(clip);
    const moved = applyTransform(clip, snap, { y: snap.y + 100 });
    const after = times.map((t) => visibleY(moved, t));

    for (let i = 0; i < times.length; i += 1) {
      const delta = after[i] - before[i];
      if (Math.abs(delta - 100) > 0.02) {
        txProblems.push(
          `${clip.name}: rendered y moved ${delta.toFixed(2)}px instead of 100px at ${times[i].toFixed(2)}s`,
        );
        break;
      }
    }

    // The motion itself must survive: the curve keeps its shape.
    const spanBefore = before[before.length - 1] - before[0];
    const spanAfter = after[after.length - 1] - after[0];
    if (Math.abs(spanBefore - spanAfter) > 0.02) {
      txProblems.push(
        `${clip.name}: motion curve distorted (span ${spanBefore.toFixed(2)} → ${spanAfter.toFixed(2)})`,
      );
    }
  }

  // Scaling is multiplicative, so the keyframed scale must scale by the same factor.
  const scaled = clips.find((c) => (c.animation["transform.scale"]?.length ?? 0) > 1);
  if (scaled) {
    const mid = scaled.duration * 0.5;
    const before = (resolveClipAt(scaled, mid) as { transform: { scale: number } }).transform.scale;
    const snap = snapshotTransform(scaled);
    const doubled = applyTransform(scaled, snap, { scale: snap.scale * 2 });
    const after = (resolveClipAt(doubled, mid) as { transform: { scale: number } }).transform.scale;
    if (Math.abs(after - before * 2) > 0.001) {
      txProblems.push(
        `${scaled.name}: rendered scale ${after.toFixed(4)} should be 2× ${before.toFixed(4)}`,
      );
    }
  }

  // Simulate an actual drag: many move events, each passing the ORIGINAL snapshot
  // with a growing absolute target. The offsets must not accumulate — reading the
  // animation from the already-edited clip made the shift grow quadratically, so
  // the element flew off the canvas after a few pixels of pointer movement.
  for (const clip of animated.slice(0, 4)) {
    const t = clip.duration * 0.5;
    const origin = visibleY(clip, t);
    const snap = snapshotTransform(clip);

    let dragged: typeof clip = clip;
    for (let step = 1; step <= 15; step += 1) {
      dragged = applyTransform(dragged, snap, { y: snap.y + step * 8 });
    }
    const travelled = visibleY(dragged, t) - origin;
    if (Math.abs(travelled - 120) > 0.02) {
      txProblems.push(
        `${clip.name}: a 15-step drag travelled ${travelled.toFixed(1)}px instead of 120px (offsets accumulated)`,
      );
    }

    // Re-applying the same absolute target must be a no-op.
    const again = applyTransform(dragged, snap, { y: snap.y + 120 });
    const againTravelled = visibleY(again, t) - origin;
    if (Math.abs(againTravelled - travelled) > 0.02) {
      txProblems.push(
        `${clip.name}: re-applying the same target moved it again (${againTravelled.toFixed(1)} vs ${travelled.toFixed(1)})`,
      );
    }
  }
}

if (txProblems.length === 0) {
  console.log("  PASS  edits move the rendered transform and keep the motion curve intact");
} else {
  for (const problem of txProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Keyframed properties other than the transform
 *
 * Whatever a template can animate, hand-editing has to reach too: the templates
 * drive `props.width/height/radius/strokeWidth`, `props.fill`, `opacity` and
 * `filters.blur`, and `core/propEdit.ts` is what lets the inspector write those
 * without the keyframes silently overriding the edit.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("keyframed property editing");
const propProblems: string[] = [];

{
  const shapeWidth = (clip: Clip, localTime: number): number =>
    (resolveClipAt(clip, localTime) as { props: { width: number } }).props.width;
  const shapeFill = (clip: Clip, localTime: number): string =>
    (resolveClipAt(clip, localTime) as { props: { fill: string } }).props.fill;

  // ---- 没打点的时候就是普通属性编辑，不许凭空生成关键帧 ----
  const plain = createShapeClip({ duration: 3, props: { width: 1105, height: 506 } });
  const resized = applyVisibleNumber(plain, "props.width", 1330, 0);
  if (resized.props.width !== 1330) {
    propProblems.push(`plain props.width edit left ${resized.props.width}, expected 1330`);
  }
  if (Object.keys(resized.animation).length !== 0) {
    propProblems.push("a plain props edit invented keyframes");
  }

  // ---- 打了点：整条曲线同量平移，输入值 = 播放头下的值 ----
  const animated = createShapeClip({ duration: 3, props: { width: 1105, height: 506 } });
  animated.animation = {
    "props.width": [
      { time: 0, value: 1105, easing: "linear" },
      { time: 1, value: 1330, easing: "easeInOutCubic" },
    ],
  };
  const spanBefore = 1330 - 1105;
  const edited = applyVisibleNumber(animated, "props.width", 1200, 0.5);
  if (Math.abs(shapeWidth(edited, 0.5) - 1200) > 1e-6) {
    propProblems.push(
      `editing an animated width left ${shapeWidth(edited, 0.5).toFixed(2)} under the playhead, expected 1200`,
    );
  }
  const frames = edited.animation["props.width"];
  if (frames.length !== 2) propProblems.push(`width shift changed the keyframe count to ${frames.length}`);
  const spanAfter = Number(frames[frames.length - 1].value) - Number(frames[0].value);
  if (Math.abs(spanAfter - spanBefore) > 1e-6) {
    propProblems.push(`width shift distorted the curve (span ${spanBefore} → ${spanAfter})`);
  }
  for (let i = 1; i < frames.length; i += 1) {
    if (frames[i].time < frames[i - 1].time) propProblems.push("width shift broke keyframe order");
  }

  // 连续输入（拖动式）必须每一步都是绝对值：反复改成同一个目标不得再动。
  let stepped = edited;
  for (const target of [1250, 1300, 1350, 1400, 1400]) {
    stepped = applyVisibleNumber(stepped, "props.width", target, 0.5);
  }
  if (Math.abs(shapeWidth(stepped, 0.5) - 1400) > 1e-6) {
    propProblems.push(
      `five successive width edits landed on ${shapeWidth(stepped, 0.5).toFixed(2)}, expected 1400 (offsets accumulated)`,
    );
  }

  // ---- 颜色：没有"平移"这回事，写进播放头那一帧 ----
  const colored = createShapeClip({ duration: 3, props: { fill: "#241C16" } });
  colored.animation = { "props.fill": [{ time: 0, value: "#241C16", easing: "linear" }] };
  const painted = applyVisibleValue(colored, "props.fill", "rgba(0,0,0,0)", 0.5);
  if ((painted.animation["props.fill"] ?? []).length !== 2) {
    propProblems.push("painting an animated colour did not add a keyframe at the playhead");
  }
  if (shapeFill(painted, 0.5) !== "rgba(0,0,0,0)") {
    propProblems.push(`colour at the playhead is ${shapeFill(painted, 0.5)}, expected the value written`);
  }
  const repainted = applyVisibleValue(painted, "props.fill", "#FF0000", 0.5);
  if ((repainted.animation["props.fill"] ?? []).length !== 2) {
    propProblems.push("painting the same moment twice added a duplicate keyframe");
  }
  if (shapeFill(repainted, 0.5) !== "#ff0000" && shapeFill(repainted, 0.5) !== "#FF0000") {
    propProblems.push(`re-painting the same moment left ${shapeFill(repainted, 0.5)}`);
  }
  const plainFill = applyVisibleValue(createShapeClip(), "props.fill", "#123456", 0.5);
  if (plainFill.props.fill !== "#123456" || Object.keys(plainFill.animation).length !== 0) {
    propProblems.push("a colour edit on a path without keyframes should just set the base value");
  }

  // ---- 尺寸过渡：起点停在原处，终点就是目标值，两个点都在片段内 ----
  const card = createShapeClip({ duration: 3, props: { width: 1105, height: 506 } });
  const grown = applyNumberTransition({
    clip: card,
    path: "props.width",
    target: 1330,
    at: 1,
    duration: 0.6,
  });
  const grownFrames = grown.animation["props.width"] ?? [];
  if (grownFrames.length !== 2) {
    propProblems.push(`size transition wrote ${grownFrames.length} keyframes, expected 2`);
  }
  if (Math.abs(grownFrames[0].time - 1) > 1e-6 || Math.abs(grownFrames[1].time - 1.6) > 1e-6) {
    propProblems.push(
      `size transition keyframes at [${grownFrames.map((f) => f.time).join(", ")}], expected [1, 1.6]`,
    );
  }
  if (grownFrames[0].easing !== "hold") {
    propProblems.push(`the transition start must hold (got ${grownFrames[0].easing})`);
  }
  // "先停住再动"：起点之前必须一直是原尺寸，否则整段都在慢慢长大。
  if (Math.abs(shapeWidth(grown, 0.2) - 1105) > 1e-6) {
    propProblems.push(
      `before the transition the card is already ${shapeWidth(grown, 0.2).toFixed(1)}px instead of holding 1105`,
    );
  }
  if (Math.abs(shapeWidth(grown, 1.6) - 1330) > 1e-6) {
    propProblems.push(`at the end of the transition the card is ${shapeWidth(grown, 1.6).toFixed(1)}px`);
  }
  const midway = shapeWidth(grown, 1.3);
  if (!(midway > 1105 && midway < 1330)) {
    propProblems.push(`mid-transition width ${midway.toFixed(1)} is outside 1105..1330`);
  }
  // 越界保护：播放头已经贴到片段尾巴时，两个关键帧仍要落在片段内。
  const atTail = applyNumberTransition({
    clip: card,
    path: "props.width",
    target: 1330,
    at: 2.95,
    duration: 0.6,
  });
  for (const frame of atTail.animation["props.width"] ?? []) {
    if (frame.time < -1e-6 || frame.time > card.duration + 1e-6) {
      propProblems.push(`transition keyframe at ${frame.time}s escaped the ${card.duration}s clip`);
    }
  }

  // ---- 一叠"外框 + 截图"共用同一个增量：边框厚度不变 ----
  const frameClip = createShapeClip({ duration: 3, props: { width: 1121, height: 522 } });
  const shotClip = createDeviceClip({ duration: 3, props: { width: 1105, height: 506 } });
  const plan = planSizeTransition(
    [
      { clip: frameClip, at: 0 },
      { clip: shotClip, at: 0 },
    ],
    1,
    { width: 1330, height: 866 },
  );
  if (plan.length !== 2) {
    propProblems.push(`size plan returned ${plan.length} targets, expected 2`);
  } else {
    if (plan[1].width !== 1330 || plan[1].height !== 866) {
      propProblems.push(
        `the reference layer should land exactly on 1330×866, got ${plan[1].width}×${plan[1].height}`,
      );
    }
    if (plan[0].width - plan[1].width !== 16 || plan[0].height - plan[1].height !== 16) {
      propProblems.push(
        `the border lost its thickness: ${plan[0].width}×${plan[0].height} vs ${plan[1].width}×${plan[1].height}`,
      );
    }
  }

  // ---- 只有形状与界面演示有可动画的盒子尺寸 ----
  if (!hasAnimatableSize(frameClip) || !hasAnimatableSize(shotClip)) {
    propProblems.push("shape/device layers must report an animatable size");
  }
  if (hasAnimatableSize(createTextClip({ text: "x" })) || hasAnimatableSize(createImageClip({ assetId: "" }))) {
    propProblems.push("text/image layers must not report an animatable size");
  }
}

if (propProblems.length === 0) {
  console.log(
    "  PASS  keyframed props shift without distortion, colours write at the playhead, size transitions hold then move",
  );
} else {
  for (const problem of propProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * 时间线上的动效标签
 *
 * 关键帧菱形只说明"有动画、在哪一刻"；片段块的 tooltip 得说清是宽高还是模糊，转场更是
 * 唯一能说明自己的地方（时间线上只有一块楔形）。中文名映射是纯函数，直接断言。
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("timeline animation labels");
const labelProblems: string[] = [];

{
  if (pathLabel("props.width") !== "宽" || pathLabel("opacity") !== "不透明度") {
    labelProblems.push("known property paths must map to their Chinese names");
  }
  // 表里没有的路径要原样露出，而不是编一个名字。
  if (pathLabel("props.focusX") !== "props.focusX") {
    labelProblems.push("unknown paths must be shown verbatim");
  }

  const labelled = createShapeClip({ duration: 3, props: { width: 1105, height: 506 } });
  labelled.animation = {
    "props.width": [
      { time: 0, value: 1105, easing: "linear" },
      { time: 0.6, value: 1330, easing: "easeInOutCubic" },
    ],
    "props.height": [
      { time: 0, value: 506, easing: "linear" },
      { time: 0.6, value: 866, easing: "easeInOutCubic" },
    ],
    "filters.blur": [{ time: 0, value: 1.2, easing: "linear" }],
    // 空数组不算"有动画"
    "transform.x": [],
  };
  const motion = clipMotionSummary(labelled);
  if (motion !== "动效 模糊 / 高 / 宽（5 帧）") {
    labelProblems.push(`motion summary is "${motion}", expected "动效 模糊 / 高 / 宽（5 帧）"`);
  }
  if (keyframeCount(labelled) !== 5) {
    labelProblems.push(`keyframeCount returned ${keyframeCount(labelled)}, expected 5`);
  }
  if (clipMotionSummary(createShapeClip()) !== "") {
    labelProblems.push("a clip with no animation must have an empty motion summary");
  }

  labelled.transitionIn = { kind: "blurDissolve", duration: 0.6, easing: "easeOutCubic" };
  labelled.transitionOut = { kind: "fade", duration: 0.5, easing: "easeOutCubic" };
  const transitions = clipTransitionSummary(labelled);
  if (transitions !== "入场 模糊溶解 0.6s · 出场 淡入淡出 0.5s") {
    labelProblems.push(`transition summary is "${transitions}"`);
  }
  if (clipTransitionSummary(createShapeClip()) !== "") {
    labelProblems.push("a clip with no transition must have an empty transition summary");
  }

  // 模板上的真实数据：那张做尺寸过渡的卡，摘要里必须看得出"宽/高"。
  //
  // 按"有没有在动宽/高"去找它，而不是按名字：模板已经改成面板驱动，卡片名跟着
  // 面板标题走，写死名字的断言会在改名之后**悄悄失去意义**（找不到 → 摘要为空 →
  // 报出来的是一句和真实原因无关的话）。
  const minimal = getTemplate("minimal-promo");
  if (!minimal) {
    labelProblems.push("minimal-promo should be registered");
  } else {
    const built = buildFromTemplate(minimal, defaultSlotValues(minimal), []);
    const morphed = built.tracks
      .flatMap((t) => t.clips)
      .filter((c) => "props.width" in c.animation || "props.height" in c.animation);
    if (morphed.length === 0) {
      labelProblems.push("minimal-promo animates no clip's width/height: the size transition is gone");
    } else {
      const summary = clipMotionSummary(morphed[0]);
      if (!summary.includes("宽") || !summary.includes("高")) {
        labelProblems.push(`the size-morph card's summary is "${summary}", expected it to name 宽/高`);
      }
    }
  }
}

if (labelProblems.length === 0) {
  console.log("  PASS  timeline summaries name what each clip animates, and unknown paths stay verbatim");
} else {
  for (const problem of labelProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Alt + 拖动 = 复制；一次拖入多个文件直接落到时间线
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("alt-drag copy & file drop");
const dropProblems: string[] = [];

{
  // ---- Alt + 拖动：移动 + 复制必须只留一步撤销 ----
  const track = createTrack("visual", "V");
  const original = createTextClip({ text: "A", start: 2, duration: 3 });
  track.clips = [original];
  useEditor.getState().loadProject({ ...createProject(), tracks: [track] });

  const historyBefore = useEditor.getState().past.length;
  const store = useEditor.getState();
  // 拖动的三步：开历史 → 移动（history:false）→ 落点补一份原件副本（history:false）→ 关历史
  store.beginHistory();
  store.updateClip(original.id, { start: 8 }, { history: false });
  const created = useEditor.getState().copyClipsAt(
    [{ clipId: original.id, trackId: track.id, start: 2 }],
    { history: false },
  );
  useEditor.getState().endHistory();

  const dragged = useEditor.getState();
  if (created.length !== 1) {
    dropProblems.push(`alt-drag produced ${created.length} copies, expected 1`);
  }
  const clipsNow = dragged.project.tracks[0].clips;
  if (clipsNow.length !== 2) {
    dropProblems.push(`alt-drag left ${clipsNow.length} clips, expected the moved one plus a copy`);
  }
  const copy = clipsNow.find((c) => c.id === created[0]);
  if (!copy) dropProblems.push("the copy from alt-drag is missing");
  else if (Math.abs(copy.start - 2) > 1e-6) {
    dropProblems.push(`the copy should stay at the original start (2s), got ${copy.start}s`);
  }
  if (dragged.past.length !== historyBefore + 1) {
    dropProblems.push(
      `alt-drag took ${dragged.past.length - historyBefore} undo steps, expected 1`,
    );
  }
  useEditor.getState().undo();
  const undone = useEditor.getState().project.tracks[0].clips;
  if (undone.length !== 1 || Math.abs(undone[0].start - 2) > 1e-6) {
    dropProblems.push(
      `one undo should take back both the move and the copy (left ${undone.length} clips, start ${undone[0]?.start})`,
    );
  }

  // ---- 副本的动画必须深拷贝：改副本的曲线不能连原件一起改 ----
  const animated = createTextClip({ text: "B", start: 0, duration: 2 });
  animated.animation = { opacity: [{ time: 0, value: 0, easing: "linear" }] };
  useEditor.getState().loadProject({
    ...createProject(),
    tracks: [{ ...createTrack("visual", "V"), clips: [animated] }],
  });
  const [copyId] = useEditor.getState().copyClipsAt([
    { clipId: animated.id, trackId: useEditor.getState().project.tracks[0].id, start: 3 },
  ]);
  useEditor.getState().updateClip(copyId, (c) => ({
    ...c,
    animation: {
      ...c.animation,
      opacity: [...(c.animation.opacity ?? []), { time: 1, value: 1, easing: "linear" }],
    },
  }));
  const sourceFrames = useEditor.getState().project.tracks[0].clips.find(
    (c) => c.id === animated.id,
  )?.animation.opacity?.length;
  if (sourceFrames !== 1) {
    dropProblems.push(
      `the copy shared its animation array with the original (source now has ${sourceFrames} keyframes)`,
    );
  }

  // ---- 一次拖入多个文件：各按类型找轨道，时间依次排开 ----
  const project = createProject();
  const visualTrack = project.tracks.find((t) => t.kind === "visual");
  const audioTrack = project.tracks.find((t) => t.kind === "audio");
  if (!visualTrack || !audioTrack) {
    dropProblems.push("the default project should have both a visual and an audio track");
  } else {
    const video: Asset = { id: "v1", kind: "video", name: "clip", src: "clip.mp4", duration: 5, addedAt: 0 };
    const image: Asset = { id: "i1", kind: "image", name: "shot", src: "shot.png", addedAt: 0 };
    const music: Asset = { id: "a1", kind: "audio", name: "music", src: "music.mp3", duration: 12, addedAt: 0 };
    const hint = { trackId: visualTrack.id, time: 4, duration: 5 };
    const sequenced = sequenceDrops(project, hint, [video, image, music]);

    if (sequenced.length !== 3) {
      dropProblems.push(`sequencing 3 files produced ${sequenced.length} placements`);
    } else {
      if (sequenced[0].trackId !== visualTrack.id || Math.abs(sequenced[0].start - 4) > 1e-6) {
        dropProblems.push("the first dropped file must land exactly under the pointer");
      }
      const expectedSecond = 4 + defaultClipDuration(video);
      if (Math.abs(sequenced[1].start - expectedSecond) > 1e-6) {
        dropProblems.push(
          `the second file should start at ${expectedSecond}s, got ${sequenced[1].start}s`,
        );
      }
      if (sequenced[2].trackId !== audioTrack.id) {
        dropProblems.push("an audio file dropped with videos must be routed to the audio track");
      }
      for (let i = 1; i < sequenced.length; i += 1) {
        if (sequenced[i].start <= sequenced[i - 1].start) {
          dropProblems.push("sequenced drops are not strictly increasing in time");
        }
      }
    }

    // 指针落在锁定轨道上时改投同类可用轨道，而不是拒绝。
    const locked = { ...visualTrack, id: "locked-visual", locked: true };
    const unlocked = { ...visualTrack, id: "free-visual" };
    const withLocked = { ...project, tracks: [locked, unlocked, audioTrack] };
    const rerouted = sequenceDrops(withLocked, { trackId: locked.id, time: 0, duration: 5 }, [video]);
    if (rerouted.length !== 1 || rerouted[0].trackId !== unlocked.id) {
      dropProblems.push(
        `a drop on a locked track should reroute to a usable one (got ${rerouted[0]?.trackId})`,
      );
    }
  }

  // ---- addClips：一批片段 + 新素材只占一步撤销 ----
  const batchTrack = createTrack("visual", "V");
  useEditor.getState().loadProject({ ...createProject(), tracks: [batchTrack] });
  const batchHistory = useEditor.getState().past.length;
  const fresh: Asset = { id: "fresh", kind: "image", name: "fresh", src: "fresh.png", addedAt: 0 };
  const batch = [0, 1, 2].map((i) => ({
    trackId: batchTrack.id,
    clip: clipForAsset(fresh, 10 + i * 4),
  }));
  useEditor.getState().addClips(batch, [fresh]);
  const batched = useEditor.getState();
  if (batched.project.tracks[0].clips.length !== 3) {
    dropProblems.push(`addClips inserted ${batched.project.tracks[0].clips.length} clips, expected 3`);
  }
  if (!batched.project.assets.some((a) => a.id === "fresh")) {
    dropProblems.push("addClips must register the freshly imported asset in the same step");
  }
  if (batched.selection.length !== 3) {
    dropProblems.push(`addClips selected ${batched.selection.length} clips, expected 3`);
  }
  if (batched.past.length !== batchHistory + 1) {
    dropProblems.push(
      `addClips took ${batched.past.length - batchHistory} undo steps, expected 1`,
    );
  }
}

if (dropProblems.length === 0) {
  console.log(
    "  PASS  alt-drag copies in one undo step, and a multi-file drop routes and spaces itself",
  );
} else {
  for (const problem of dropProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Timeline geometry, marquee selection and the clipboard
 *
 * The store is plain zustand, so its actions can be driven directly here — a
 * paste can be checked for relative spacing, track routing and undo granularity
 * without a browser.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("timeline geometry & clipboard");
const tlProblems: string[] = [];

{
  const template = TEMPLATES[0];
  const built = buildFromTemplate(template, defaultSlotValues(template), []);
  const store = useEditor.getState();
  store.newProject(built);

  const project = useEditor.getState().project;
  const clips = project.tracks.flatMap((t) => t.clips);
  const layout = layoutRows(project);

  // Rows must be contiguous and cover exactly the tracks (plus one audio header).
  const realRows = layout.rows.filter((r) => !r.section);
  if (realRows.length !== project.tracks.length) {
    tlProblems.push(`layout has ${realRows.length} rows for ${project.tracks.length} tracks`);
  }
  let cursor = RULER_H;
  for (const row of layout.rows) {
    if (Math.abs(row.top - cursor) > 1e-6) {
      tlProblems.push(`row "${row.track.name}" starts at ${row.top}, expected ${cursor}`);
      break;
    }
    cursor += row.height;
  }
  if (Math.abs(layout.totalHeight - cursor) > 1e-6) {
    tlProblems.push("layout total height does not match the sum of its rows");
  }

  // Every clip needs a rectangle, and a marquee over everything must select
  // exactly the clips on unlocked, visible tracks.
  const rects = clipRects(layout, 60);
  if (rects.length !== clips.length) {
    tlProblems.push(`clipRects returned ${rects.length} rects for ${clips.length} clips`);
  }
  const everything: Box = { x: 0, y: 0, w: 100000, h: layout.totalHeight };
  const all = clipIdsInBox(rects, everything);
  if (all.length !== rects.length) {
    tlProblems.push(`select-all marquee caught ${all.length} of ${rects.length} clips`);
  }
  const nowhere: Box = { x: 0, y: 0, w: 1, h: 1 };
  if (clipIdsInBox(rects, nowhere).length !== 0) {
    tlProblems.push("an empty marquee selected clips");
  }
  // A rectangle drawn exactly over one clip must catch it.
  const probe = rects[rects.length - 1];
  const exact: Box = { x: probe.x + 1, y: probe.y + 1, w: probe.w - 2, h: probe.h - 2 };
  const caught = clipIdsInBox(rects, exact);
  if (!caught.includes(probe.clipId)) {
    tlProblems.push("a marquee drawn over a clip did not select it");
  }

  // Edit points: sorted, unique, and covering every clip boundary.
  const points = editPoints(project);
  for (let i = 1; i < points.length; i += 1) {
    if (points[i] <= points[i - 1]) tlProblems.push("edit points are not strictly increasing");
  }
  for (const clip of clips) {
    if (!points.includes(clip.start)) tlProblems.push(`edit points miss the start of "${clip.name}"`);
    if (!points.includes(clip.start + clip.duration)) {
      tlProblems.push(`edit points miss the end of "${clip.name}"`);
    }
  }

  // ---- clipboard ----
  store.selectAll();
  const selectedCount = useEditor.getState().selection.length;
  if (selectedCount !== clips.length) {
    tlProblems.push(`selectAll chose ${selectedCount} of ${clips.length} clips`);
  }

  // Copy two clips with a known gap and paste them at 40s.
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const pair = [ordered[0], ordered[1]];
  const gap = pair[1].start - pair[0].start;
  store.select(pair.map((c) => c.id), "replace");
  store.copySelection();
  const countBefore = useEditor.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0);
  const historyBefore = useEditor.getState().past.length;

  store.pasteClipboard(40);
  const after = useEditor.getState();
  const pasted = after.selection
    .map((id) => findClip(after.project, id))
    .filter((c): c is NonNullable<typeof c> => !!c);

  if (pasted.length !== 2) {
    tlProblems.push(`paste produced ${pasted.length} clips instead of 2`);
  } else {
    const sorted = [...pasted].sort((a, b) => a.start - b.start);
    if (Math.abs(sorted[0].start - 40) > 1e-6) {
      tlProblems.push(`paste started at ${sorted[0].start}s instead of 40s`);
    }
    if (Math.abs(sorted[1].start - sorted[0].start - gap) > 1e-6) {
      tlProblems.push("paste did not preserve the relative spacing of the copied clips");
    }
    for (const clip of pasted) {
      if (pair.some((p) => p.id === clip.id)) tlProblems.push("paste reused an existing clip id");
    }
  }

  const countAfterPaste = after.project.tracks.reduce((n, t) => n + t.clips.length, 0);
  if (countAfterPaste !== countBefore + 2) {
    tlProblems.push(`clip count went ${countBefore} → ${countAfterPaste}, expected +2`);
  }

  // A paste must be a single undo step.
  useEditor.getState().undo();
  const countAfterUndo = useEditor
    .getState()
    .project.tracks.reduce((n, t) => n + t.clips.length, 0);
  if (countAfterUndo !== countBefore) {
    tlProblems.push(`one undo left ${countAfterUndo} clips, expected ${countBefore}`);
  }
  if (useEditor.getState().past.length !== historyBefore) {
    tlProblems.push("paste consumed more than one history entry");
  }

  console.log(`  ${project.tracks.length} tracks · ${clips.length} clips · ${points.length} edit points`);
}

if (tlProblems.length === 0) {
  console.log("  PASS  layout, marquee hit-testing, edit points and paste are correct");
} else {
  for (const problem of tlProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Waveform peaks and ripple editing
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("waveform peaks & ripple editing");
const editProblems: string[] = [];

{
  // ---- peaks ----
  const samples = new Float32Array(800);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 5) * 0.5;
  samples[400] = -1; // a single loud transient

  const peaks = peaksFromChannels([samples], 16);
  if (peaks.length !== 16) editProblems.push(`peaks length ${peaks.length}, expected 16`);
  let loudest = 0;
  for (const value of peaks) {
    if (!Number.isFinite(value)) {
      editProblems.push("peaks contain a non-finite value");
      break;
    }
    if (value < 0 || value > 1.0001) editProblems.push(`peak ${value} out of range`);
    loudest = Math.max(loudest, value);
  }
  if (Math.abs(loudest - 1) > 1e-6) editProblems.push("peaks were not normalised to 1");

  const silent = peaksFromChannels([new Float32Array(400)], 8);
  for (const value of silent) {
    if (!Number.isFinite(value) || value !== 0) {
      editProblems.push("silent input produced a non-zero or invalid peak");
      break;
    }
  }
  if (peaksFromChannels([], 8).length !== 8) {
    editProblems.push("empty channel list did not return the requested bucket count");
  }

  // ---- ripple delete & close gaps ----
  const track = createTrack("visual", "T");
  const a = createTextClip({ text: "A", start: 0, duration: 2 });
  const b = createTextClip({ text: "B", start: 3, duration: 4 });
  const c = createTextClip({ text: "C", start: 8, duration: 2 });
  track.clips = [a, b, c];
  useEditor.getState().loadProject({ ...createProject(), tracks: [track] });

  useEditor.getState().rippleDelete([b.id]);
  const afterRipple = useEditor.getState().project.tracks[0].clips;
  const findById = (id: string) => afterRipple.find((clip) => clip.id === id);

  if (findById(b.id)) editProblems.push("ripple delete left the removed clip behind");
  if (Math.abs((findById(a.id)?.start ?? -1) - 0) > 1e-6) {
    editProblems.push("ripple delete moved a clip that started before the removed one");
  }
  // C started at 8; 4 seconds were removed before it, so it lands on 4.
  if (Math.abs((findById(c.id)?.start ?? -1) - 4) > 1e-6) {
    editProblems.push(
      `ripple delete left C at ${findById(c.id)?.start}, expected 4 (shifted by the removed 4s)`,
    );
  }

  useEditor.getState().closeGaps(track.id);
  const packed = [...useEditor.getState().project.tracks[0].clips].sort((x, y) => x.start - y.start);
  let cursor = 0;
  for (const clip of packed) {
    if (Math.abs(clip.start - cursor) > 1e-6) {
      editProblems.push(`close gaps left "${clip.name}" at ${clip.start}, expected ${cursor}`);
      break;
    }
    cursor += clip.duration;
  }
}

if (editProblems.length === 0) {
  console.log("  PASS  peaks normalise safely and ripple/close-gap arithmetic is exact");
} else {
  for (const problem of editProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Volume envelopes and asset relinking
 *
 * Two failure modes that are invisible until the final file: a fade that the
 * preview plays but the export does not, and a relink that repairs the media
 * pool but orphans every clip on the timeline.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("volume envelopes & relinking");
const audioProblems: string[] = [];

{
  // ---- envelope shape ----
  const duration = 4;
  const animation: Record<string, Array<{ time: number; value: number | string; easing: string }>> = {
    "props.volume": [
      { time: 0, value: 0, easing: "linear" },
      { time: 1, value: 1, easing: "easeOutQuad" },
      { time: duration - 1, value: 1, easing: "easeInQuad" },
      { time: duration, value: 0, easing: "linear" },
    ],
  };

  const envelope = buildVolumeEnvelope(animation as never, duration, 1);
  if (envelope.length < 10) audioProblems.push(`envelope only has ${envelope.length} points`);
  if (envelope[0]?.value !== 0) audioProblems.push("envelope does not start silent");
  const lastPoint = envelope[envelope.length - 1];
  if (Math.abs(lastPoint.time - duration) > 1e-6) {
    audioProblems.push(`envelope ends at ${lastPoint.time}s, expected ${duration}s`);
  }
  if (Math.abs(lastPoint.value) > 1e-6) audioProblems.push("envelope does not end silent");

  const middle = envelope.find((p) => Math.abs(p.time - duration / 2) < 0.006);
  if (!middle || Math.abs(middle.value - 1) > 0.02) {
    audioProblems.push(`midpoint gain is ${middle?.value}, expected ~1`);
  }
  for (const point of envelope) {
    if (!Number.isFinite(point.value) || point.value < -0.001 || point.value > 1.001) {
      audioProblems.push(`envelope point ${point.time}s = ${point.value} out of range`);
      break;
    }
  }

  if (buildVolumeEnvelope({} as never, duration, 0.5).length !== 0) {
    audioProblems.push("a clip without volume keyframes should have no envelope");
  }

  // ---- a base volume of 0 must not silence a fade-in ----
  const audioTrack = createTrack("audio", "Music");
  const faded = createAudioClip({ assetId: "a1", start: 0, duration: 4, props: { volume: 0 } });
  faded.animation = { "props.volume": animation["props.volume"] as never };
  audioTrack.clips = [faded];

  const silent = createAudioClip({ assetId: "a1", start: 6, duration: 4, props: { volume: 0 } });
  audioTrack.clips.push(silent);

  const asset: Asset = {
    id: "a1",
    kind: "audio",
    name: "music",
    src: "music.mp3",
    hasAudio: true,
    duration: 30,
    addedAt: 0,
  };
  const mixed = {
    ...createProject(),
    assets: [asset],
    tracks: [audioTrack],
  };

  const audible = collectAudibleClips(mixed);
  if (audible.length !== 1) {
    audioProblems.push(
      `collectAudibleClips returned ${audible.length} clips; expected only the faded one (a base volume of 0 plus a fade-in must still be audible)`,
    );
  }
  if (audible[0] && audible[0].envelope.length === 0) {
    audioProblems.push("the collected clip lost its volume envelope");
  }

  // ---- relinking keeps clips attached ----
  const stillImage = createImageClip({ assetId: "i1", start: 0, duration: 2 });
  const imageAsset: Asset = {
    id: "i1",
    kind: "image",
    name: "shot",
    src: "old.png",
    path: "/old.png",
    addedAt: 0,
  };
  useEditor.getState().loadProject({
    ...createProject(),
    assets: [imageAsset],
    tracks: [{ ...createTrack("visual", "V"), clips: [stillImage] }],
  });

  useEditor
    .getState()
    .relinkAsset("i1", { path: "/new.png", src: "new.png", width: 100, height: 50 });

  const relinked = useEditor.getState().project;
  const relinkedAsset = relinked.assets.find((a) => a.id === "i1");
  if (!relinkedAsset) audioProblems.push("relink removed the asset");
  if (relinkedAsset?.src !== "new.png") {
    audioProblems.push(`relink left src as ${relinkedAsset?.src}, expected new.png`);
  }
  if (relinkedAsset?.width !== 100) audioProblems.push("relink did not refresh the metadata");
  if (relinked.tracks[0]?.clips[0]?.props.assetId !== "i1") {
    audioProblems.push("relink orphaned the clip from its asset");
  }
}

if (audioProblems.length === 0) {
  console.log("  PASS  fades survive into the mix and relinking keeps clips attached");
} else {
  for (const problem of audioProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Dragging keyframes on the timeline
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("keyframe dragging");
const kfProblems: string[] = [];

{
  const clip = createTextClip({ text: "T", start: 0, duration: 4 });
  clip.animation = {
    opacity: [
      { time: 0, value: 0, easing: "linear" },
      { time: 1, value: 1, easing: "linear" },
      { time: 2, value: 1, easing: "linear" },
    ],
    "transform.y": [
      { time: 0, value: 0, easing: "linear" },
      { time: 1, value: 50, easing: "linear" },
    ],
  };
  useEditor.getState().loadProject({
    ...createProject(),
    tracks: [{ ...createTrack("visual", "V"), clips: [clip] }],
  });

  const timesOf = (path: string): number[] => {
    const current = useEditor.getState().project.tracks[0].clips[0];
    return (current.animation[path] ?? []).map((f) => f.time);
  };

  // One move relocates the moment on *every* animated property.
  useEditor.getState().moveKeyframesAt(clip.id, 1, 1.5);
  const opacityAfter = timesOf("opacity");
  const yAfter = timesOf("transform.y");
  if (Math.abs(opacityAfter[1] - 1.5) > 1e-6) {
    opacityAfter.length === 3
      ? kfProblems.push(`opacity keyframe moved to ${opacityAfter[1]}, expected 1.5`)
      : kfProblems.push("opacity lost keyframes");
  }
  if (yAfter.length !== 2 || Math.abs(yAfter[1] - 1.5) > 1e-6) {
    kfProblems.push(`transform.y keyframes are [${yAfter.join(", ")}], expected [0, 1.5]`);
  }
  if (Math.abs(opacityAfter[2] - 2) > 1e-6) {
    kfProblems.push("moving one moment disturbed a different keyframe");
  }

  // A drag is many move events. They must be absolute, not cumulative: a naive
  // implementation would walk the keyframe far past where the pointer went.
  const historyBefore = useEditor.getState().past.length;
  let currentTime = 1.5;
  for (let step = 1; step <= 10; step += 1) {
    const target = 1.5 + step * 0.15;
    useEditor.getState().moveKeyframesAt(clip.id, currentTime, target, { history: false });
    currentTime = target;
  }
  const dragged = timesOf("opacity");
  const finalMoved = dragged.find((t) => t > 2.5);
  if (finalMoved === undefined || Math.abs(finalMoved - 3) > 1e-6) {
    kfProblems.push(
      `after a 10-step drag the keyframe sits at ${finalMoved ?? "nowhere"}, expected 3`,
    );
  }
  if (!dragged.some((t) => Math.abs(t - 2) < 1e-6)) {
    kfProblems.push("the drag also moved a keyframe it was not holding");
  }
  for (let i = 1; i < dragged.length; i += 1) {
    if (dragged[i] < dragged[i - 1] - 1e-9) {
      kfProblems.push("keyframes are no longer sorted after dragging");
      break;
    }
  }
  if (useEditor.getState().past.length !== historyBefore) {
    kfProblems.push("a history-free drag step still pushed an undo entry");
  }
}

if (kfProblems.length === 0) {
  console.log("  PASS  keyframe drags are absolute, scoped and leave no stray history");
} else {
  for (const problem of kfProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Crash recovery and track management
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("autosave & track management");
const recoveryProblems: string[] = [];

{
  // ---- autosave round trip (localStorage stubbed for Node) ----
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, String(value));
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };

  const template = TEMPLATES[0];
  const built = buildFromTemplate(template, defaultSlotValues(template), []);

  if (readAutosave() !== null) recoveryProblems.push("readAutosave found a record before any write");
  if (!writeAutosave(built, "C:/shows/promo.qookiv")) {
    recoveryProblems.push("writeAutosave reported failure on working storage");
  }

  const restored = readAutosave();
  if (!restored) {
    recoveryProblems.push("readAutosave returned nothing after a successful write");
  } else {
    if (restored.filePath !== "C:/shows/promo.qookiv") {
      recoveryProblems.push(`autosave lost the file path (${restored.filePath})`);
    }
    if (recoveryClipCount(restored.project) !== recoveryClipCount(built)) {
      recoveryProblems.push("autosave changed the number of clips");
    }
    if (restored.project.name !== built.name) recoveryProblems.push("autosave changed the name");
    if (typeof restored.savedAt !== "number" || restored.savedAt <= 0) {
      recoveryProblems.push("autosave has no usable timestamp");
    }
  }

  // A truncated or hand-edited record must repair rather than throw.
  backing.set(AUTOSAVE_KEY, JSON.stringify({ savedAt: 1234, project: { name: "Half" } }));
  const repaired = readAutosave();
  if (!repaired) recoveryProblems.push("a partial autosave was rejected instead of repaired");
  else if (repaired.project.name !== "Half") recoveryProblems.push("repair lost the project name");

  backing.set(AUTOSAVE_KEY, "definitely not json");
  if (readAutosave() !== null) recoveryProblems.push("corrupt JSON produced a record");

  clearAutosave();
  if (readAutosave() !== null) recoveryProblems.push("clearAutosave left the record behind");

  // Storage that refuses to write must report failure, not throw.
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => undefined,
  };
  if (writeAutosave(built, null)) {
    recoveryProblems.push("writeAutosave claimed success when storage threw");
  }

  // ---- track management ----
  const visualA = createTrack("visual", "A");
  visualA.clips = [createTextClip({ text: "a", start: 0, duration: 1 })];
  const visualB = createTrack("visual", "B");
  const audio = createTrack("audio", "Music");
  useEditor.getState().loadProject({ ...createProject(), tracks: [visualA, visualB, audio] });

  const store = useEditor.getState();

  // Adding a layer track must land above the audio section, not after it.
  store.addTrack("visual");
  const withNew = useEditor.getState().project.tracks;
  const lastVisual = withNew.map((t) => t.kind).lastIndexOf("visual");
  const firstAudio = withNew.findIndex((t) => t.kind === "audio");
  if (firstAudio >= 0 && lastVisual > firstAudio) {
    recoveryProblems.push("a new visual track was inserted after the audio track");
  }

  // Reorder swaps only within the same kind.
  useEditor.getState().loadProject({ ...createProject(), tracks: [visualA, visualB, audio] });
  useEditor.getState().moveTrack(visualA.id, "up");
  const reordered = useEditor.getState().project.tracks;
  if (reordered[0]?.id !== visualB.id || reordered[1]?.id !== visualA.id) {
    recoveryProblems.push(
      `moveTrack produced [${reordered.map((t) => t.name).join(", ")}], expected [B, A, Music]`,
    );
  }
  if (reordered[2]?.kind !== "audio") {
    recoveryProblems.push("moveTrack displaced a track of a different kind");
  }

  // At the top of its kind, moving up must be a no-op rather than a wrap-around.
  const before = useEditor.getState().project.tracks.map((t) => t.name).join(",");
  useEditor.getState().moveTrack(visualA.id, "up");
  if (useEditor.getState().project.tracks.map((t) => t.name).join(",") !== before) {
    recoveryProblems.push("moving the topmost track up was not a no-op");
  }

  // Duplicating a track must not share clip objects with the original.
  useEditor.getState().loadProject({ ...createProject(), tracks: [visualA, visualB, audio] });
  const sourceClipId = useEditor.getState().project.tracks[0].clips[0].id;
  useEditor.getState().duplicateTrack(visualA.id);
  const copy = useEditor.getState().project.tracks[1];
  if (copy.clips.length !== 1) recoveryProblems.push("duplicated track lost its clips");
  if (copy.clips[0]?.id === sourceClipId) {
    recoveryProblems.push("duplicated track reused the original clip id");
  }
  if (useEditor.getState().project.tracks[0].clips.length !== 1) {
    recoveryProblems.push("duplicating a track disturbed the original");
  }

  // Clearing a track keeps the track but drops its clips.
  const trackCountBefore = useEditor.getState().project.tracks.length;
  useEditor.getState().clearTrack(visualA.id);
  const after = useEditor.getState().project.tracks;
  if (after.length !== trackCountBefore) recoveryProblems.push("clearTrack removed the track itself");
  if ((after.find((t) => t.id === visualA.id)?.clips.length ?? -1) !== 0) {
    recoveryProblems.push("clearTrack left clips behind");
  }
}

if (recoveryProblems.length === 0) {
  console.log("  PASS  autosave round-trips and track management is section-safe");
} else {
  for (const problem of recoveryProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Media pool ordering and export estimates
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("media sorting & export estimates");
const poolProblems: string[] = [];

{
  const make = (
    id: string,
    name: string,
    kind: Asset["kind"],
    extra: Partial<Asset> = {},
  ): Asset => ({ id, name, kind, src: `${id}.bin`, addedAt: 0, ...extra });

  const pool: Asset[] = [
    make("a", "beta", "video", { duration: 5, bytes: 5_000_000, addedAt: 30 }),
    make("b", "alpha", "image", { bytes: 200_000, addedAt: 10 }),
    make("c", "gamma", "audio", { duration: 12, bytes: 900_000, addedAt: 20 }),
    make("d", "delta", "video", { duration: undefined, bytes: undefined, addedAt: 40 }),
  ];

  const snapshot = pool.map((a) => a.id).join(",");
  sortAssets(pool, "duration");
  if (pool.map((a) => a.id).join(",") !== snapshot) {
    poolProblems.push("sortAssets mutated the caller's array");
  }

  const byDuration = sortAssets(pool, "duration").map((a) => a.id);
  if (byDuration.join(",") !== "c,a,b,d") {
    poolProblems.push(`duration sort gave [${byDuration.join(",")}], expected [c,a,b,d]`);
  }

  const bySize = sortAssets(pool, "size").map((a) => a.id);
  if (bySize.join(",") !== "a,c,b,d") {
    poolProblems.push(`size sort gave [${bySize.join(",")}], expected [a,c,b,d]`);
  }

  const byRecent = sortAssets(pool, "recent").map((a) => a.id);
  if (byRecent.join(",") !== "d,a,c,b") {
    poolProblems.push(`recency sort gave [${byRecent.join(",")}], expected [d,a,c,b]`);
  }

  const byName = sortAssets(pool, "name").map((a) => a.name);
  if (byName[0] !== "alpha" || byName[byName.length - 1] !== "gamma") {
    poolProblems.push(`name sort gave [${byName.join(",")}]`);
  }

  // An asset with unknown metadata must never be treated as the smallest.
  if (sortAssets(pool, "duration")[3]?.id !== "d") {
    poolProblems.push("an asset with unknown duration did not sort last");
  }

  if (!matchesQuery(pool[0], "BET")) poolProblems.push("query matching is not case-insensitive");
  if (!matchesQuery(pool[0], "  ")) poolProblems.push("a blank query should match everything");
  if (matchesQuery(pool[0], "zzz")) poolProblems.push("a non-matching query matched");
  if (formatBytes(0) !== "" || formatBytes(undefined) !== "") {
    poolProblems.push("formatBytes should render nothing for unknown sizes");
  }
  if (formatBytes(5 * 1024 * 1024) !== "5.0 MB") {
    poolProblems.push(`formatBytes(5MB) = ${formatBytes(5 * 1024 * 1024)}`);
  }

  // ---- export estimate ----
  // The dialog's estimate must scale with frame rate, since bitrate does.
  const bitrate30 = defaultVideoBitrate(1920, 1080, 30);
  const bitrate120 = defaultVideoBitrate(1920, 1080, 120);
  if (!(bitrate120 > bitrate30)) {
    poolProblems.push("1080p120 is not estimated as a higher bitrate than 1080p30");
  }
  const estimate30 = ((bitrate30 + 192_000) * 32) / 8;
  const estimate120 = ((bitrate120 + 192_000) * 32) / 8;
  if (!(estimate30 > 0) || !Number.isFinite(estimate120)) {
    poolProblems.push("the size estimate is not a finite positive number");
  }
  // A 32s 1080p30 promo should land in a plausible range, not gigabytes.
  if (estimate30 < 2 * 1024 * 1024 || estimate30 > 400 * 1024 * 1024) {
    poolProblems.push(`32s 1080p30 estimate looks wrong: ${(estimate30 / 1048576).toFixed(1)} MB`);
  }
}

if (poolProblems.length === 0) {
  console.log("  PASS  pool ordering is stable and missing metadata sorts last");
} else {
  for (const problem of poolProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Filmstrip sampling
 *
 * Frames are requested on a quantised grid so two clips over the same footage
 * share cache entries instead of each pulling their own. If the quantiser is not
 * idempotent, or the tile times drift outside the clip's source range, the strip
 * silently shows the wrong frames.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("filmstrip sampling");
const stripProblems: string[] = [];

{
  const video = (duration: number | undefined): Asset => ({
    id: "v1",
    kind: "video",
    name: "clip",
    src: "v1.mp4",
    duration,
    addedAt: 0,
  });

  const long = video(30);
  if (Math.abs(thumbnailStep(long) - 0.5) > 1e-9) {
    stripProblems.push(`30s asset step is ${thumbnailStep(long)}, expected 0.5`);
  }
  if (Math.abs(thumbnailStep(video(2)) - 0.25) > 1e-9) {
    stripProblems.push("a short asset should fall back to the 0.25s minimum step");
  }
  if (thumbnailStep(video(undefined)) < 0.25) {
    stripProblems.push("an asset with unknown duration must still have a sane step");
  }

  // Idempotent, and neighbouring times inside one cell collapse together.
  for (const time of [0, 0.13, 0.5, 7.31, 29.9, 120]) {
    const once = quantizeThumbnailTime(long, time);
    const twice = quantizeThumbnailTime(long, once);
    if (Math.abs(once - twice) > 1e-9) {
      stripProblems.push(`quantising ${time} twice moved it (${once} → ${twice})`);
    }
    if (once < 0) stripProblems.push(`quantising ${time} produced a negative time`);
  }
  if (quantizeThumbnailTime(long, 0.26) !== quantizeThumbnailTime(long, 0.74)) {
    stripProblems.push("two times inside the same cell did not share a cache key");
  }
  if (quantizeThumbnailTime(long, 10) === quantizeThumbnailTime(long, 10.5)) {
    stripProblems.push("times a full cell apart collapsed to the same key");
  }

  // Tile counts: never zero, never unbounded.
  if (tileCount(1) !== 1 || tileCount(0) !== 1 || tileCount(Number.NaN) !== 1) {
    stripProblems.push("tileCount should return 1 for degenerate widths");
  }
  if (tileCount(720) !== 10) stripProblems.push(`tileCount(720) = ${tileCount(720)}, expected 10`);
  if (tileCount(100000) !== 14) {
    stripProblems.push(`tileCount is not capped: ${tileCount(100000)}`);
  }
  if (!(tileCount(1440) > tileCount(720))) {
    stripProblems.push("tileCount does not grow with width");
  }

  // Source times must stay inside the clip's own range and increase.
  const trimmed = createTextClip({ text: "t", start: 0, duration: 4 });
  trimmed.trimIn = 10;
  trimmed.speed = 1;
  const tiles = 4;
  const times = Array.from({ length: tiles }, (_, i) => tileSourceTime(trimmed, i, tiles));
  for (let i = 1; i < times.length; i += 1) {
    if (!(times[i] > times[i - 1])) {
      stripProblems.push(`tile times are not increasing: [${times.join(", ")}]`);
      break;
    }
  }
  if (times[0] < 10 || times[times.length - 1] > 14) {
    stripProblems.push(`tile times escaped the source range: [${times.join(", ")}]`);
  }
  if (times[0] <= 10) {
    stripProblems.push("the first tile should sample at the tile centre, not the in-point");
  }

  // A speed change stretches the sampled span accordingly.
  const fast = { ...trimmed, speed: 2 };
  const fastLast = tileSourceTime(fast, tiles - 1, tiles);
  if (!(fastLast > times[times.length - 1])) {
    stripProblems.push("tile sampling ignores playback speed");
  }
}

if (stripProblems.length === 0) {
  console.log("  PASS  filmstrip frames tile the clip without leaving its source range");
} else {
  for (const problem of stripProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

console.log("========================");
console.log("timeline keyframe markers");
const markerProblems: string[] = [];
{
  /*
   * 形状（矩形/色块）上的尺寸过渡必须**看得见**：关键帧菱形画在片段那层画布上，而那块
   * 画布曾经只给 image/video/audio/device 挂——`shape` 被排除，于是"尺寸过渡没有标记"
   * （最常做尺寸过渡的正是形状）。这里把"要不要挂画布"和"标记长什么样"都钉住。
   */
  const shape = createShapeClip({ start: 0, duration: 4 });
  shape.animation = {
    "props.width": [
      { time: 0.5, value: 400, easing: "hold" },
      { time: 1.1, value: 900, easing: "easeOut" },
    ],
  };

  if (!shouldShowArtwork(shape)) {
    markerProblems.push("a shape with keyframes must still get its marker layer");
  }

  const markers = keyframeMarkers(shape);
  if (markers.length !== 2) {
    markerProblems.push(`a size transition produced ${markers.length} markers, expected 2`);
  }
  if (!markers.every((marker) => marker.kind === "size")) {
    markerProblems.push("width/height keyframes must be drawn as size markers");
  }
  if (markers[0]?.time !== 0.5 || markers[1]?.time !== 1.1) {
    markerProblems.push("size markers must sit at the keyframe times");
  }

  // 普通关键帧仍然是菱形；同一时刻两者都有时画菱形。
  const mixed = createShapeClip({ start: 0, duration: 4 });
  mixed.animation = {
    "props.width": [{ time: 1.1, value: 900, easing: "easeOut" }],
    "filters.blur": [{ time: 1.1, value: 4, easing: "easeOut" }],
  };
  const merged = keyframeMarkers(mixed);
  if (merged.length !== 1) {
    markerProblems.push(`markers at one instant must merge into one, got ${merged.length}`);
  }
  if (merged[0]?.kind !== "other") {
    markerProblems.push("a plain keyframe must win the shared instant (diamond, not size glyph)");
  }

  // 没有媒体也没有动画的形状不该多挂一层画布。
  if (shouldShowArtwork(createShapeClip({ start: 0, duration: 4 }))) {
    markerProblems.push("a plain shape must not get an empty marker layer");
  }

  // 有媒体的片段照旧。
  if (!shouldShowArtwork(createVideoClip({ assetId: "v1", start: 0, duration: 4 }))) {
    markerProblems.push("a media clip must keep its artwork layer");
  }
}

if (markerProblems.length === 0) {
  console.log("  PASS  size transitions are marked on every clip kind, and edge markers are visible");
} else {
  for (const problem of markerProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Playback sync
 *
 * Two bugs shipped here: media kept playing after its clip ended, and the
 * per-frame drift correction turned into a seek storm that stuttered the
 * preview. Both are asserted below against a stub element that counts calls.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("playback sync");
const syncProblems: string[] = [];

{
  installMediaStubs();
  const pool = new MediaPool();

  const videoAsset: Asset = {
    id: "v1",
    kind: "video",
    name: "take",
    src: "v1.mp4",
    duration: 30,
    hasAudio: true,
    addedAt: 0,
  };
  const musicAsset: Asset = {
    id: "m1",
    kind: "audio",
    name: "music",
    src: "m1.mp3",
    duration: 30,
    hasAudio: true,
    addedAt: 0,
  };
  pool.sync([videoAsset, musicAsset]);

  // The pool only drives elements whose metadata arrived.
  pool.getVideoElement("v1")?.dispatch("loadedmetadata");
  pool.getAudioElement("m1")?.dispatch("loadedmetadata");

  const videoClip = createVideoClip({ assetId: "v1", start: 0, duration: 2 });
  const musicClip = createAudioClip({ assetId: "m1", start: 1, duration: 2 });
  const project: Project = {
    ...createProject(),
    assets: [videoAsset, musicAsset],
    tracks: [
      { ...createTrack("visual", "V"), clips: [videoClip] },
      { ...createTrack("audio", "M"), clips: [musicClip] },
    ],
  };

  const videoEl = pool.getVideoElement("v1");
  const musicEl = pool.getAudioElement("m1");
  if (!videoEl || !musicEl) syncProblems.push("the pool did not create the media elements");

  // ---- inside the clips: both should be running ----
  pool.playVideos(project, 1.5);
  pool.playAudio(project, 1.5);
  if (videoEl?.paused !== false) syncProblems.push("the video did not start while its clip is live");
  if (musicEl?.paused !== false) syncProblems.push("the music did not start while its clip is live");

  // ---- past both clips: both must stop ----
  pool.playVideos(project, 5);
  pool.playAudio(project, 5);
  if (videoEl?.paused !== true) {
    syncProblems.push("the video kept playing after its clip ended");
  }
  if (musicEl?.paused !== true) {
    syncProblems.push("the music kept playing after its clip ended");
  }

  // ---- the clip windows differ: only the live one runs ----
  pool.playVideos(project, 1.5);
  pool.playAudio(project, 0.5); // music starts at 1s, so it is not live yet
  if (musicEl?.paused !== true) {
    syncProblems.push("music played before its clip started");
  }
  if (videoEl?.paused !== false) {
    syncProblems.push("stopping the music also stopped the video");
  }

  // ---- a persistent, unlanded drift is corrected once, not every few frames ----
  pool.playAudio(project, 1.5); // get it running
  musicEl!.ignoreSeeks = true;
  musicEl!.setTimeRaw(999);
  musicEl!.seekCount = 0;
  for (let i = 0; i < 60; i += 1) {
    pool.playAudio(project, 1.5 + i * 0.016);
  }
  musicEl!.ignoreSeeks = false;
  if (musicEl!.seekCount > 2) {
    syncProblems.push(
      `a stuck seek was re-issued ${musicEl!.seekCount} times over 60 frames; that is the seek storm that stutters playback`,
    );
  }
  if (musicEl!.seekCount === 0) {
    syncProblems.push("a large persistent drift was never corrected");
  }

  // ---- an element advancing in step with the clock must not be seeked at all ----
  pool.playAudio(project, 1.5);
  musicEl!.setTimeRaw(1.5);
  musicEl!.seekCount = 0;
  for (let i = 0; i < 60; i += 1) {
    musicEl!.advance(0.016); // advance with the clock
    pool.playAudio(project, 1.5 + i * 0.016);
  }
  if (musicEl!.seekCount !== 0) {
    syncProblems.push(
      `an in-sync element was seeked ${musicEl!.seekCount} times; playback would stutter`,
    );
  }

  // ---- the compositor must never seek a playing element ----
  pool.playVideos(project, 1.5); // video live and running
  videoEl!.seekCount = 0;
  for (let i = 0; i < 60; i += 1) {
    const playhead = 1.5 + i * 0.016;
    // A playing element reports its position quantised to video frames, so it
    // sits up to a frame behind the playhead. The seek tolerance is 0.6 of a
    // frame — *tighter* than that granularity — so comparing the two while
    // playing is guaranteed to look "out of sync" on every single frame.
    videoEl!.setTimeRaw(playhead - 1 / 30);
    pool.getVideo("v1", playhead);
  }
  if (videoEl!.seekCount !== 0) {
    syncProblems.push(
      `the compositor seeked a playing video ${videoEl!.seekCount} times over 60 frames; that is the stutter`,
    );
  }

  // ---- paused (scrub/export): an exact seek is correct and expected ----
  pool.pauseVideos();
  videoEl!.setTimeRaw(0);
  videoEl!.seekCount = 0;
  pool.getVideo("v1", 4);
  if (videoEl!.seekCount !== 1) {
    syncProblems.push(
      `a paused element at the wrong position was seeked ${videoEl!.seekCount} times, expected exactly 1`,
    );
  }

  // ---- scrubbing while paused seeks exactly, which is correct ----
  pool.pauseAudio();
  if (musicEl!.paused !== true) syncProblems.push("pauseAudio did not stop the music");
  if (videoEl?.paused !== true) syncProblems.push("pauseAudio also stopped the video");
  pool.pauseVideos();
  if (videoEl?.paused !== true) syncProblems.push("pauseVideos did not stop the video");

  pool.releaseAll();

  /*
   * ---- 片段比素材长：停住最后一帧，绝不允许重放 ----
   *
   * 元数据时长比可解码流长（VFR 容器常见），或素材长度探测不到时按默认时长建片段，
   * 都会出现"播放头走到素材之外"。旧实现里元素播完 → 同步循环每 4 帧纠正一次，
   * 而 `play()` 又把它拉回开头重放 —— 画面和声音于是在同一段无限反复。
   */
  {
    const shortPool = new MediaPool();
    shortPool.sync([videoAsset]);
    const el = shortPool.getVideoElement("v1");
    el?.dispatch("loadedmetadata");
    if (!el) {
      syncProblems.push("the pool did not create the element for the short-source case");
    } else {
      el.duration = 2; // 素材只有 2 秒，而片段有 5 秒
      el.setTimeRaw(2); // 已经播到结尾
      el.pause();
      const longClip = createVideoClip({ assetId: "v1", start: 0, duration: 5 });
      const longProject: Project = {
        ...createProject(),
        assets: [videoAsset],
        tracks: [{ ...createTrack("visual", "V"), clips: [longClip] }],
      };

      el.playCalls = 0;
      el.seekCount = 0;
      for (let i = 0; i < 30; i += 1) shortPool.playVideos(longProject, 3 + i * 0.016);

      if (el.playCalls > 0) {
        syncProblems.push(
          `an element that ran out of source was played ${el.playCalls} times; the spec rewinds it, so the picture replays`,
        );
      }
      if (el.paused !== true) {
        syncProblems.push("a clip longer than its media must leave the element paused");
      }
      if (Math.abs(el.currentTime - 2) > 0.05) {
        syncProblems.push(
          `the frozen element sat at ${el.currentTime.toFixed(2)}s instead of the last frame (~2s)`,
        );
      }
      if (el.seekCount > 1) {
        syncProblems.push(
          `holding the last frame took ${el.seekCount} seeks; it must settle in one`,
        );
      }

      // 继续推进播放头：位置与播放次数都必须一动不动（repeat 循环必须死透）。
      const frozenAt = el.currentTime;
      for (let i = 0; i < 30; i += 1) shortPool.playVideos(longProject, 4 + i * 0.016);
      if (el.playCalls > 0 || Math.abs(el.currentTime - frozenAt) > 1e-6) {
        syncProblems.push(
          `the frozen element moved again (playCalls ${el.playCalls}, ${frozenAt.toFixed(2)}s → ${el.currentTime.toFixed(2)}s)`,
        );
      }
      shortPool.releaseAll();
    }
  }

  /*
   * ---- 同一个素材被多个重叠片段引用：只能有一个主人 ----
   *
   * 复制一段到上层轨道、两段在时间上重叠时，两个片段每帧各报一个目标位置，元素会被
   * 来回拖 —— 画面在两个位置之间反复跳。主人必须是**最上层**（画面上看得见的那个）。
   */
  {
    const sharedPool = new MediaPool();
    sharedPool.sync([videoAsset]);
    const el = sharedPool.getVideoElement("v1");
    el?.dispatch("loadedmetadata");
    if (!el) {
      syncProblems.push("the pool did not create the element for the shared-asset case");
    } else {
      const lower = createVideoClip({ assetId: "v1", start: 0, duration: 6 });
      // `trimIn` 不在片段工厂的参数里，只能建好之后再写——这里刻意让上层片段取素材
      // 后段，两个片段对同一个元素的"目标位置"因此差 20 秒。
      const upper = createVideoClip({ assetId: "v1", start: 4, duration: 6 });
      upper.trimIn = 20;
      const sharedProject: Project = {
        ...createProject(),
        assets: [videoAsset],
        tracks: [
          { ...createTrack("visual", "下"), clips: [lower] },
          { ...createTrack("visual", "上"), clips: [upper] },
        ],
      };

      // 播放头 5s 时上层片段的源时间 = 20 + (5 - 4) = 21s，元素从这里开始、跟着走。
      el.setTimeRaw(21);
      el.pause();
      el.seekCount = 0;
      el.playCalls = 0;
      for (let i = 0; i < 60; i += 1) {
        sharedPool.playVideos(sharedProject, 5 + i * 0.016);
        el.advance(0.016);
      }

      if (el.seekCount !== 0) {
        syncProblems.push(
          `two overlapping clips sharing one asset caused ${el.seekCount} seeks; the element is being dragged between them`,
        );
      }
      if (Math.abs(el.currentTime - (21 + 60 * 0.016)) > 0.05) {
        syncProblems.push(
          `the element tracked ${el.currentTime.toFixed(2)}s, but the topmost clip wants 21s onwards`,
        );
      }
      sharedPool.releaseAll();
    }
  }

  /*
   * ---- 精确 seek 必须落在被要求的位置 ----
   *
   * 曾经有几处直接写 `el.currentTime` 却不记录目标，`seeked` 处理器于是判成"seek 没
   * 落地"，把元素**拽回上一个目标**：要求它去 2s，它停在 0s。播放中每次漂移纠正都会被
   * 自己撤销，表现出来就是"画面和声音在同一段一直重复"。
   */
  {
    const lagPool = new MediaPool();
    lagPool.sync([videoAsset]);
    const el = lagPool.getVideoElement("v1");
    el?.dispatch("loadedmetadata");
    if (!el) {
      syncProblems.push("the pool did not create the element for the seek-bookkeeping case");
    } else {
      const clip = createVideoClip({ assetId: "v1", start: 0, duration: 20 });
      const lagProject: Project = {
        ...createProject(),
        assets: [videoAsset],
        tracks: [{ ...createTrack("visual", "V"), clips: [clip] }],
      };

      el.setTimeRaw(0);
      el.pause();
      el.seekCount = 0;
      lagPool.playVideos(lagProject, 2);
      if (Math.abs(el.currentTime - 2) > 0.05) {
        syncProblems.push(
          `a scrub asked for 2s but the element settled at ${el.currentTime.toFixed(2)}s; an unrecorded seek is being undone`,
        );
      }

      // 真跳变（拖动播放头、时间线绕回）必须立刻把素材拽到新位置（允许往回）。
      const before = el.seekCount;
      lagPool.playVideos(lagProject, 0.5, { exact: true });
      if (el.seekCount === before) {
        syncProblems.push("a real jump must still seek the media, even backwards");
      }
      lagPool.releaseAll();
    }
  }

  /*
   * ---- 「界面演示」里的录像必须和视频图层走同一条链路 ----
   *
   * 设备层（`device`）本来就能画视频帧（`device.ts` 会调 `media.getVideo`），但
   * `MediaPool` 只认 `kind === "video"`：设备片段引用的视频既不会被 seek 也不会被
   * 播放，导出时 `settle()` 也等不到它，于是嵌在卡片里的录像永远停在第一帧。
   * 这一条断言把"设备片段也算视频的主人"钉住。
   */
  {
    const devPool = new MediaPool();
    devPool.sync([videoAsset]);
    const devEl = devPool.getVideoElement("v1");
    devEl?.dispatch("loadedmetadata");
    if (!devEl) {
      syncProblems.push("the pool did not create the element for the device-video case");
    } else {
      const deviceClip = createDeviceClip({
        duration: 4,
        props: { assetId: "v1", width: 1105, height: 506 },
      });
      const devProject: Project = {
        ...createProject(),
        assets: [videoAsset],
        tracks: [{ ...createTrack("visual", "S"), clips: [deviceClip] }],
      };

      // 1) 播到片段里面：设备外壳里的录像必须真的在跑。
      devEl.setTimeRaw(0);
      devEl.pause();
      devPool.playVideos(devProject, 2);
      if (devEl.paused !== false) {
        syncProblems.push("a screen recording inside a device frame never started playing");
      }
      if (devEl.muted !== true) {
        syncProblems.push("a screen recording inside a device frame must be muted");
      }

      // 2) 播到片段之后：必须停下，否则卡片的尾巴会继续出声/跑帧。
      devPool.playVideos(devProject, 6);
      if (devEl.paused !== true) {
        syncProblems.push("a device screen recording kept playing after its clip ended");
      }

      // 3) 导出路径：`settle()` 必须把它 seek 到确切时间（否则导出的那一帧是旧的）。
      devEl.seekCount = 0;
      void devPool.settle(devProject, 3).then(() => {
        if (devEl.seekCount === 0) {
          syncProblems.push("settle() ignored the device clip, so exports would be a frame behind");
        }
      });
      devPool.releaseAll();
    }
  }

  /*
   * ---- 两个视频一起播：纠正一个不许把另一个带卡 ----
   *
   * 曾经让时钟去"追随领先最远的素材"（想修窗口被节流导致的时钟落后）。那只在同时只有
   * 一个元素时成立：两个视频一起播时，另一个会被判成落后并每 500ms 被 seek 一次 ——
   * 就是"两个视频一起播，其中一个一直卡"。现在时钟丢时间由时钟自己解决，元素只按各自的
   * 持久漂移纠正。
   */
  {
    const twoPool = new MediaPool();
    const second: Asset = {
      id: "v2",
      kind: "video",
      name: "second",
      src: "v2.mp4",
      duration: 30,
      hasAudio: true,
      addedAt: 0,
    };
    twoPool.sync([videoAsset, second]);
    const a = twoPool.getVideoElement("v1");
    const b = twoPool.getVideoElement("v2");
    a?.dispatch("loadedmetadata");
    b?.dispatch("loadedmetadata");
    if (!a || !b) {
      syncProblems.push("the pool did not create both video elements");
    } else {
      const clipA = createVideoClip({ assetId: "v1", start: 0, duration: 10 });
      const clipB = createVideoClip({ assetId: "v2", start: 0, duration: 10 });
      const twoProject: Project = {
        ...createProject(),
        assets: [videoAsset, second],
        tracks: [
          { ...createTrack("visual", "A"), clips: [clipA] },
          { ...createTrack("visual", "B"), clips: [clipB] },
        ],
      };

      // 起步：两个都进入播放（各精确对齐一次），然后让 A 领先 0.3s（解码缓冲的正常余量）。
      a.setTimeRaw(2);
      b.setTimeRaw(2);
      a.pause();
      b.pause();
      twoPool.playVideos(twoProject, 2);
      a.setTimeRaw(2.3);
      a.seekCount = 0;
      b.seekCount = 0;

      for (let i = 0; i < 60; i += 1) {
        twoPool.playVideos(twoProject, 2 + i * 0.016);
        a.advance(0.016);
        b.advance(0.016);
      }

      if (b.seekCount !== 0) {
        syncProblems.push(
          `the in-sync video was seeked ${b.seekCount} times because the other one led; that is the "one of two videos stutters" bug`,
        );
      }
      if (a.seekCount !== 0) {
        syncProblems.push(
          `a 0.3s decode-buffer lead caused ${a.seekCount} seeks; it must be chased with the rate trim, not with seeks`,
        );
      }
      if (!(a.playbackRate < 1)) {
        syncProblems.push(
          `the leading video plays at ${a.playbackRate}, expected a slower trim so it waits for the clock`,
        );
      }
      if (Math.abs(b.playbackRate - 1) > 0.005) {
        syncProblems.push(
          `the in-sync video plays at ${b.playbackRate}, expected exactly the clip speed`,
        );
      }
      twoPool.releaseAll();
    }
  }

  /*
   * ---- 反复"暂停/继续"不许把偏移攒起来 ----
   *
   * 每次继续都会留下一点起播延迟（元素位置对齐了，但解码器要几十毫秒才真正开始走）。
   * 只"容忍"它 → 永远不追平、一次一次攒；用 seek 去修 → 又制造新的起播延迟，越修越糟
   * （状态栏"每秒纠正 3 次"就是这么来的）。所以播放中的纠偏必须是**速度微调**。
   * 这里模拟 6 次暂停/继续，每次注入 0.08s 起播延迟，并让元素按它自己的 `playbackRate`
   * 前进（浏览器就是这样），断言偏移被追平、且一次 seek 都没有。
   */
  {
    const cyclePool = new MediaPool();
    cyclePool.sync([videoAsset]);
    const el = cyclePool.getVideoElement("v1");
    el?.dispatch("loadedmetadata");
    if (!el) {
      syncProblems.push("the pool did not create the element for the pause/resume cycle case");
    } else {
      const clip = createVideoClip({ assetId: "v1", start: 0, duration: 20 });
      const cycleProject: Project = {
        ...createProject(),
        assets: [videoAsset],
        tracks: [{ ...createTrack("visual", "V"), clips: [clip] }],
      };

      el.pause();
      el.setTimeRaw(0);
      cyclePool.playVideos(cycleProject, 0);
      el.seekCount = 0;

      let clock = 0;
      let offset = 0;
      let trimSeen = false;
      for (let cycle = 0; cycle < 6; cycle += 1) {
        // 继续：位置先对齐到播放头，然后解码器有 0.08s 才真正开始走。
        el.paused = false;
        el.setTimeRaw(clock);
        for (let i = 0; i < 90; i += 1) {
          clock += 0.016;
          cyclePool.playVideos(cycleProject, clock);
          if (i >= 5) {
            el.advance(0.016 * el.playbackRate);
            if (el.playbackRate > 1.001) trimSeen = true;
          }
        }
        offset = clock - el.currentTime;
        cyclePool.pauseVideos();
      }

      if (Math.abs(offset) > 0.06) {
        syncProblems.push(
          `after 6 pause/resume cycles the element trailed by ${offset.toFixed(3)}s; each continue leaves start-up latency and it must be chased, not accumulated`,
        );
      }
      if (el.seekCount !== 0) {
        syncProblems.push(
          `pause/resume cycles caused ${el.seekCount} seeks; the rate trim should have handled them`,
        );
      }
      if (!trimSeen) {
        syncProblems.push("the start-up latency was never chased with a rate trim");
      }
      if (Math.abs(el.playbackRate - 1) > 0.005) {
        syncProblems.push(
          `the element was left playing at ${el.playbackRate}; once caught up it must return to the clip speed`,
        );
      }
      cyclePool.releaseAll();
    }
  }

  /*
   * ---- 时钟不许在长帧里丢时间 ----
   *
   * "播放同步每秒纠正 3 次"的**根**在这里：时钟原来把每帧的时间增量裁到 0.25s，而窗口在
   * 后台时 rAF 会被节流到 ~1Hz —— 于是时钟只按真实时间的四分之一走，素材却按真实时间播，
   * 差距永远存在，纠正永远做不完。这里直接驱动引擎的帧回调：跳过 1.5s 后时钟必须前进 1.5s。
   */
  {
    const engine = new PlaybackEngine();
    engine.duration = 30;
    engine.loop = false;
    engine.play();
    const t0 = performance.now();
    drainRaf(t0);
    const before = engine.time;
    drainRaf(t0 + 1500);
    const advanced = engine.time - before;
    if (Math.abs(advanced - 1.5) > 0.02) {
      syncProblems.push(
        `a 1.5s frame gap advanced the clock by ${advanced.toFixed(3)}s; losing wall time there is what keeps the drift correction running forever`,
      );
    }
    engine.pause();
  }

  /*
   * ---- 暂停→继续：不许因此进入"seek→起播延迟→再 seek"的自我维持循环 ----
   *
   * 恢复播放走的也是"暂停态精确对齐"那条路，而容差原来是 0.04：暂停的元素按自己的帧
   * 量化报告位置，24/25fps 素材一帧就有 0.04s，于是**每次继续都先 seek 一次**；seek 又
   * 带来起播延迟，时钟不等它，4 帧后判定"落后"再 seek —— 所有元素一起中招，状态栏就会
   * 一直报"每秒纠正 3 次"。这里盯两件事：继续时不许 seek；起播延迟不许被当成漂移。
   */
  {
    const resumePool = new MediaPool();
    const asset24: Asset = {
      id: "v24",
      kind: "video",
      name: "24fps",
      src: "v24.mp4",
      duration: 30,
      fps: 24,
      hasAudio: true,
      addedAt: 0,
    };
    resumePool.sync([asset24]);
    const el = resumePool.getVideoElement("v24");
    el?.dispatch("loadedmetadata");
    if (!el) {
      syncProblems.push("the pool did not create the element for the resume case");
    } else {
      const clip = createVideoClip({ assetId: "v24", start: 0, duration: 20 });
      const resumeProject: Project = {
        ...createProject(),
        assets: [asset24],
        tracks: [{ ...createTrack("visual", "V"), clips: [clip] }],
      };

      // 元素还在播时按暂停（`pauseVideos` 才记下"刚停下"）。
      el.setTimeRaw(3);
      el.paused = false;
      resumePool.pauseVideos();

      // 立刻继续：元素比播放头晚 0.03s（一帧之内），不许 seek。
      el.seekCount = 0;
      resumePool.playVideos(resumeProject, 3.03);
      if (el.seekCount !== 0) {
        syncProblems.push(
          `resuming seeked the element ${el.seekCount} times for a sub-frame offset; every continue then restarts the decoder`,
        );
      }

      // 起播延迟（元素刚起来，稳定落后 0.15s）不许被当成漂移去 seek。
      el.setTimeRaw(3.03);
      el.paused = false;
      el.seekCount = 0;
      for (let i = 0; i < 120; i += 1) {
        resumePool.playVideos(resumeProject, 3.2 + i * 0.016);
        el.advance(0.016);
      }
      if (el.seekCount !== 0) {
        syncProblems.push(
          `a start-up latency of 0.15s was corrected ${el.seekCount} times; that correction costs more than it fixes`,
        );
      }

      // 但真正的漂移仍然必须纠正，而且**纠正会停下来**（不能每秒都在纠正）。
      el.setTimeRaw(3);
      el.paused = false;
      el.seekCount = 0;
      let correctionsInLastSecond = 0;
      for (let i = 0; i < 180; i += 1) {
        const before = el.seekCount;
        resumePool.playVideos(resumeProject, 5 + i * 0.016);
        if (el.seekCount > before && i > 120) correctionsInLastSecond += 1;
      }
      if (el.seekCount === 0) {
        syncProblems.push("a 2s drift during playback must still be corrected");
      }
      if (correctionsInLastSecond > 0) {
        syncProblems.push(
          `${correctionsInLastSecond} corrections in the last two seconds: corrections must settle, not repeat forever`,
        );
      }
      resumePool.releaseAll();
    }
  }

  /*
   * ---- 胶片条抽帧必须用自己的解码池 ----
   *
   * 抽帧是"seek 同一个 video 元素"实现的，而它曾经用的是**预览的池**：一暂停，抽帧
   * 队列就按设计结束等待、开始 seek 预览正在显示的元素，预览又把它拽回播放头，两边
   * 打架 —— 暂停那一帧被拽去画胶片，再按播放时元素还在 seek 中途，于是"暂停/起播卡
   * 一下"。这里直接盯接线：请求胶片帧只许动胶片池的元素。
   */
  {
    playback.pause();
    const previewPool = new MediaPool();
    const filmPool = new MediaPool();
    previewPool.sync([videoAsset]);
    filmPool.sync([videoAsset]);
    const previewEl = previewPool.getVideoElement("v1");
    const filmEl = filmPool.getVideoElement("v1");
    previewEl?.dispatch("loadedmetadata");
    filmEl?.dispatch("loadedmetadata");
    if (!previewEl || !filmEl) {
      syncProblems.push("the pools did not create their video elements");
    } else {
      previewEl.setTimeRaw(0);
      filmEl.setTimeRaw(0);
      previewEl.seekCount = 0;
      filmEl.seekCount = 0;

      // 抽帧队列会同步走到第一次 seek 赋值，所以这里不需要等异步完成。
      requestThumbnail(videoAsset, filmPool, 3);

      if (filmEl.seekCount === 0) {
        syncProblems.push("asking for a filmstrip frame did not touch the filmstrip pool");
      }
      if (previewEl.seekCount !== 0) {
        syncProblems.push(
          `filmstrip extraction seeked the preview's element ${previewEl.seekCount} times; pausing would fight the paused frame`,
        );
      }
      previewPool.releaseAll();
      filmPool.releaseAll();
    }
  }

  /*
   * ---- 暂停本身不许 seek ----
   *
   * 暂停的元素按**自己的帧**量化报告位置，所以"刚停下"的漂移天然有 0~1 帧，而紧容差是
   * 0.6/fps —— 于是几乎每次暂停都会 seek 一次。seek 会拆掉解码器流水线，下一次播放得
   * 重新预热：用户看到的就是"暂停/继续卡一下，而且暂停继续次数越多越明显"。
   * 但擦洗与逐帧步进仍然必须精确，所以只放过"刚停下"的那一次取帧。
   */
  {
    const pausePool = new MediaPool();
    const asset24: Asset = {
      id: "v24",
      kind: "video",
      name: "24fps",
      src: "v24.mp4",
      duration: 30,
      fps: 24,
      hasAudio: true,
      addedAt: 0,
    };
    pausePool.sync([asset24]);
    const el = pausePool.getVideoElement("v24");
    el?.dispatch("loadedmetadata");
    if (!el) {
      syncProblems.push("the pool did not create the element for the pause case");
    } else {
      // 元素正跑在 3.000s（它自己的帧起点），播放头在帧内 3.030s（0.72 帧的漂移）。
      // 注意顺序：真实路径是"元素还在播时按暂停"，`pauseVideos` 才会记下"刚停下"。
      el.setTimeRaw(3);
      el.paused = false;
      pausePool.pauseVideos();
      el.seekCount = 0;
      pausePool.getVideo("v24", 3.03);
      if (el.seekCount !== 0) {
        syncProblems.push(
          `pausing seeked the element ${el.seekCount} times although it already shows the right frame; resuming then re-primes the decoder`,
        );
      }

      // 紧接着擦洗（同一帧的漂移）：必须精确 seek。
      el.setTimeRaw(3);
      pausePool.getVideo("v24", 3.03);
      if (el.seekCount === 0) {
        syncProblems.push("a scrub while paused must still seek exactly");
      }

      // 逐帧步进（整整一帧）也必须 seek，否则步进会看着没反应。
      const afterScrub = el.seekCount;
      el.setTimeRaw(3);
      pausePool.getVideo("v24", 3 + 1 / 24);
      if (el.seekCount === afterScrub) {
        syncProblems.push("stepping exactly one frame must still seek");
      }
      pausePool.releaseAll();
    }
  }

  /*
   * ---- 诊断：该说的说清楚，正常播放不许瞎报 ----
   *
   * "看着在卡"至少有三种成因（片段超出素材而停在最后一帧、同步在反复纠正、解码器跟不上），
   * 前两种我们看得见，就报出来；同时保证健康播放**一条都不报**，否则状态栏会变成噪音。
   */
  {
    const diagPool = new MediaPool();
    const issues: Array<{ kind: string; name: string; available?: number; needed?: number }> = [];
    diagPool.onSyncIssue = (issue) => {
      issues.push(issue as unknown as { kind: string; name: string; available?: number; needed?: number });
    };
    diagPool.sync([videoAsset]);
    const el = diagPool.getVideoElement("v1");
    el?.dispatch("loadedmetadata");
    if (!el) {
      syncProblems.push("the pool did not create the element for the diagnostics case");
    } else {
      const clip = createVideoClip({ assetId: "v1", start: 0, duration: 5, name: "短片段的片段" });
      const diagProject: Project = {
        ...createProject(),
        assets: [videoAsset],
        tracks: [{ ...createTrack("visual", "V"), clips: [clip] }],
      };

      // 素材只有 2 秒，片段却要 5 秒 → 报一次，且带上真实长度。
      el.duration = 2;
      el.setTimeRaw(2);
      el.pause();
      for (let i = 0; i < 20; i += 1) diagPool.playVideos(diagProject, 3 + i * 0.016);
      const frozen = issues.filter((issue) => issue.kind === "frozen");
      if (frozen.length !== 1) {
        syncProblems.push(`a frozen tail was reported ${frozen.length} times, expected exactly 1`);
      } else {
        if (Math.abs((frozen[0].available ?? 0) - 2) > 0.02) {
          syncProblems.push(
            `the freeze report should carry the real media length (got ${frozen[0].available})`,
          );
        }
        if ((frozen[0].needed ?? 0) <= 2) {
          syncProblems.push("the freeze report should carry how much source the clip needs");
        }
      }

      // 健康播放：元素在素材范围内、与时钟同步 → 一条都不许报。
      diagPool.pauseAll();
      issues.length = 0;
      el.duration = 30;
      el.setTimeRaw(0);
      el.pause();
      for (let i = 0; i < 20; i += 1) {
        diagPool.playVideos(diagProject, i * 0.016);
        el.advance(0.016);
      }
      if (issues.length > 0) {
        syncProblems.push(`healthy playback reported ${issues.length} sync issues; it must stay quiet`);
      }

      // 只纠正一次也不算"一直在卡"。
      el.setTimeRaw(1);
      el.seekCount = 0;
      for (let i = 0; i < 20; i += 1) diagPool.playVideos(diagProject, i * 0.016);
      if (issues.length > 0) {
        syncProblems.push("a single correction should not be reported as a stutter");
      }
      diagPool.releaseAll();
    }
  }
}

if (syncProblems.length === 0) {
  console.log(
    "  PASS  clips stop at their end, an out-of-source element freezes instead of replaying, one asset has one owner, and drift is corrected without a seek storm",
  );
} else {
  for (const problem of syncProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Asset-to-clip defaults
 *
 * Dropping a video used to produce a clip capped at 20s regardless of the file,
 * so the picture and its audio were cut off at an arbitrary point.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("asset-to-clip defaults");
const clipDefaultProblems: string[] = [];

{
  const asset = (kind: Asset["kind"], duration?: number): Asset => ({
    id: `${kind}-${duration}`,
    kind,
    name: "a",
    src: "a.bin",
    duration,
    addedAt: 0,
  });

  // The clip must follow the file, however long it is.
  if (defaultClipDuration(asset("video", 60)) !== 60) {
    clipDefaultProblems.push(
      `a 60s video produced a ${defaultClipDuration(asset("video", 60))}s clip; the duration must follow the file`,
    );
  }
  if (defaultClipDuration(asset("video", 20.5)) !== 20.5) {
    clipDefaultProblems.push("a 20.5s video was rounded or clamped");
  }
  if (defaultClipDuration(asset("audio", 187)) !== 187) {
    clipDefaultProblems.push(
      `a 187s track produced a ${defaultClipDuration(asset("audio", 187))}s clip`,
    );
  }

  // Only an unknown length falls back, and the fallbacks stay sane.
  if (defaultClipDuration(asset("video")) !== 5) {
    clipDefaultProblems.push("a video with unknown length should fall back to 5s");
  }
  if (defaultClipDuration(asset("audio")) !== 10) {
    clipDefaultProblems.push("audio with unknown length should fall back to 10s");
  }
  if (defaultClipDuration(asset("image")) !== 4) {
    clipDefaultProblems.push("a still image should default to 4s");
  }

  // A placed clip must actually carry that length onto the timeline.
  const placed = clipForAsset(asset("video", 60), 3);
  if (placed.duration !== 60 || placed.start !== 3) {
    clipDefaultProblems.push(
      `clipForAsset produced start=${placed.start} duration=${placed.duration}, expected 3 / 60`,
    );
  }
}

if (clipDefaultProblems.length === 0) {
  console.log("  PASS  a dropped clip is exactly as long as its file");
} else {
  for (const problem of clipDefaultProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Detaching a video's audio
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("detach video audio");
const detachProblems: string[] = [];

{
  installMediaStubs();

  const videoAsset: Asset = {
    id: "v1",
    kind: "video",
    name: "take.mp4",
    src: "v1.mp4",
    duration: 12,
    hasAudio: true,
    addedAt: 0,
  };

  /** A video clip at 2s, 6s long, trimmed 3s in, at 1.5x, with a fade-in. */
  const buildSource = () => {
    const clip = createVideoClip({ assetId: "v1", start: 2, duration: 6 });
    clip.trimIn = 3;
    clip.speed = 1.5;
    clip.props.volume = 0.7;
    clip.animation = {
      "props.volume": [
        { time: 0, value: 0, easing: "linear" },
        { time: 1, value: 0.7, easing: "linear" },
      ],
    };
    const visual = createTrack("visual", "V");
    visual.clips = [clip];
    const project: Project = {
      ...createProject(),
      name: "P",
      assets: [videoAsset],
      tracks: [visual],
    };
    return { project, clipId: clip.id };
  };

  const allClips = (project: Project) => project.tracks.flatMap((t) => t.clips);

  // ---- happy path: the project starts with no audio track at all ----
  const { project, clipId } = buildSource();
  useEditor.getState().loadProject(project);
  if (useEditor.getState().project.tracks.some((t) => t.kind === "audio")) {
    detachProblems.push("the fixture should start with no audio track");
  }

  useEditor.getState().detachAudio(clipId);
  const after = useEditor.getState().project;
  const picture = allClips(after).find((c) => c.id === clipId);
  const sound = allClips(after).find((c) => c.kind === "audio");

  if (!picture) detachProblems.push("the picture clip disappeared");
  if (picture && picture.kind !== "video") detachProblems.push("the picture clip changed kind");
  if (picture && (picture.props as MediaClipProps).muted !== true) {
    detachProblems.push("the picture clip was not muted, so the sound would be heard twice");
  }
  if (picture && (picture.props as MediaClipProps).volume !== 0.7) {
    detachProblems.push("detaching changed the picture clip's volume");
  }

  if (!sound) {
    detachProblems.push("no audio clip was created");
  } else {
    const props = sound.props as MediaClipProps;
    if (sound.kind !== "audio") detachProblems.push("the new clip is not an audio clip");
    if (sound.start !== 2) detachProblems.push(`the sound starts at ${sound.start}, expected 2`);
    if (sound.duration !== 6) {
      detachProblems.push(`the sound is ${sound.duration}s, expected 6`);
    }
    if (sound.trimIn !== 3) detachProblems.push(`trimIn was not carried over (${sound.trimIn})`);
    if (sound.speed !== 1.5) detachProblems.push(`speed was not carried over (${sound.speed})`);
    if (props.assetId !== "v1") detachProblems.push("the sound does not reference the same asset");
    if (props.muted !== false) {
      detachProblems.push("the detached audio is muted, so it would be silent");
    }
    if (props.volume !== 0.7) detachProblems.push(`volume was not carried over (${props.volume})`);
    const frames = sound.animation["props.volume"];
    if (!frames || frames.length !== 2) {
      detachProblems.push("the volume keyframes (the fade) were not carried over");
    }
    // Keyframes must be copies: editing the sound may not disturb the picture.
    if (frames && frames === picture?.animation["props.volume"]) {
      detachProblems.push("the sound shares its keyframe array with the picture");
    }
  }

  if (!after.tracks.some((t) => t.kind === "audio")) {
    detachProblems.push("no audio track was created to host the sound");
  }
  if (after.tracks[after.tracks.length - 1]?.kind !== "audio") {
    detachProblems.push("the new audio track was not placed in the audio section");
  }

  // ---- it is a single undo step ----
  useEditor.getState().undo();
  const undone = useEditor.getState().project;
  if (allClips(undone).some((c) => c.kind === "audio")) {
    detachProblems.push("one undo did not remove the detached sound");
  }
  const restored = allClips(undone).find((c) => c.id === clipId);
  if (restored && (restored.props as MediaClipProps).muted) {
    detachProblems.push("undo did not un-mute the picture");
  }

  // ---- a source with no audio track is refused, not silently duplicated ----
  const silentClip = createVideoClip({ assetId: "v2", start: 0, duration: 4 });
  const silentProject: Project = {
    ...createProject(),
    assets: [{ ...videoAsset, id: "v2", hasAudio: false }],
    tracks: [{ ...createTrack("visual", "V"), clips: [silentClip] }],
  };
  useEditor.getState().loadProject(silentProject);
  useEditor.getState().detachAudio(silentClip.id);
  if (allClips(useEditor.getState().project).length !== 1) {
    detachProblems.push("a file with no audio track still produced a second clip");
  }

  // ---- preview: a detached sound on a VIDEO asset must find an element ----
  const pool = new MediaPool();
  pool.sync([videoAsset]);
  if (pool.getAudioElement("v1") !== null) {
    detachProblems.push("the pool created an audio element for a video asset up front");
  }
  const third = buildSource();
  useEditor.getState().loadProject(third.project);
  useEditor.getState().detachAudio(third.clipId);
  const detached = useEditor.getState().project;

  pool.playAudio(detached, 2.5);
  const soundEl = pool.getAudioElement("v1");
  if (!soundEl) {
    detachProblems.push(
      "a detached sound on a video asset resolved no audio element, so it would play silently",
    );
  } else if (soundEl.paused) {
    detachProblems.push("the detached sound element never started");
  }
  // Past the clip it must stop like any other sound.
  pool.playAudio(detached, 20);
  if (soundEl && !soundEl.paused) {
    detachProblems.push("the detached sound kept playing past its clip");
  }
  pool.releaseAll();
}

if (detachProblems.length === 0) {
  console.log("  PASS  splitting keeps timing, fades and an audible result");
} else {
  for (const problem of detachProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Timeline wheel mapping
 *
 * wheel → horizontal, shift+wheel → vertical, ctrl+wheel → zoom about the
 * pointer. The last one is the reason the listener is registered natively: a
 * passive listener cannot preventDefault, and the webview would zoom instead.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("timeline wheel");
const wheelProblems: string[] = [];

{
  interface FakeWheelEvent {
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    clientX: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    defaultPrevented: boolean;
    preventDefault: () => void;
  }

  /** Minimal scroll container that records what the handler did to it. */
  class FakeScroller {
    /** Real elements clamp, so the fake must too or edge cases read as bugs. */
    private left = 0;
    private top = 0;
    clientWidth = 1000;
    clientHeight = 400;
    passive: boolean | undefined;
    private handlers = new Map<string, (event: FakeWheelEvent) => void>();

    get scrollLeft(): number {
      return this.left;
    }

    set scrollLeft(value: number) {
      this.left = Math.max(0, value);
    }

    get scrollTop(): number {
      return this.top;
    }

    set scrollTop(value: number) {
      this.top = Math.max(0, value);
    }

    addEventListener(type: string, fn: (event: FakeWheelEvent) => void, options?: unknown): void {
      this.handlers.set(type, fn);
      if (options && typeof options === "object" && "passive" in options) {
        this.passive = (options as { passive: boolean }).passive;
      }
    }

    removeEventListener(type: string): void {
      this.handlers.delete(type);
    }

    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight, x: 0, y: 0 };
    }

    /** Dispatches a wheel event and reports whether it was prevented. */
    wheel(init: Partial<FakeWheelEvent>): boolean {
      const event: FakeWheelEvent = {
        deltaX: 0,
        deltaY: 0,
        deltaMode: 0,
        clientX: 400,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        ...init,
      };
      this.handlers.get("wheel")?.(event);
      return event.defaultPrevented;
    }
  }

  const scroller = new FakeScroller();
  const detach = attachTimelineWheel(scroller as unknown as HTMLElement);
  registerTimelineViewport(scroller as unknown as HTMLElement);

  // ---- plain wheel scrolls along the timeline ----
  scroller.scrollLeft = 200;
  scroller.scrollTop = 50;
  let prevented = scroller.wheel({ deltaY: 120 });
  if (!prevented) wheelProblems.push("a plain wheel event was not prevented");
  if (scroller.scrollLeft !== 320) {
    wheelProblems.push(`plain wheel moved scrollLeft to ${scroller.scrollLeft}, expected 320`);
  }
  if (scroller.scrollTop !== 50) wheelProblems.push("plain wheel also scrolled vertically");

  // A trackpad's horizontal gesture must map to the same axis.
  scroller.scrollLeft = 0;
  scroller.wheel({ deltaX: 90, deltaY: 4 });
  if (scroller.scrollLeft !== 90) {
    wheelProblems.push(`a horizontal trackpad gesture scrolled to ${scroller.scrollLeft}, expected 90`);
  }

  // ---- shift + wheel scrolls the tracks ----
  scroller.scrollLeft = 0;
  scroller.scrollTop = 0;
  scroller.wheel({ deltaY: 100, shiftKey: true });
  if (scroller.scrollTop !== 100) {
    wheelProblems.push(`shift+wheel scrolled to ${scroller.scrollTop}, expected 100`);
  }
  if (scroller.scrollLeft !== 0) wheelProblems.push("shift+wheel also scrolled the timeline");

  // ---- line-mode deltas are scaled, not read as a couple of pixels ----
  scroller.scrollTop = 0;
  scroller.wheel({ deltaY: 3, deltaMode: 1, shiftKey: true });
  if (scroller.scrollTop !== 48) {
    wheelProblems.push(`line-mode shift+wheel scrolled ${scroller.scrollTop}, expected 48`);
  }

  // ---- ctrl + wheel zooms about the pointer instead of scrolling ----
  useEditor.getState().loadProject(createProject());
  useEditor.getState().setZoom(60);
  scroller.scrollLeft = 300;
  const zoomBefore = useEditor.getState().zoom;
  prevented = scroller.wheel({ deltaY: -240, ctrlKey: true, clientX: 500 });
  if (!prevented) {
    wheelProblems.push("ctrl+wheel was not prevented, so the webview would zoom the whole page");
  }
  if (useEditor.getState().zoom <= zoomBefore) {
    wheelProblems.push(
      `ctrl+wheel up left zoom at ${useEditor.getState().zoom} (was ${zoomBefore})`,
    );
  }
  if (scroller.scrollLeft !== 300) wheelProblems.push("ctrl+wheel also scrolled the timeline");

  const zoomedIn = useEditor.getState().zoom;
  scroller.wheel({ deltaY: 240, ctrlKey: true, clientX: 500 });
  if (useEditor.getState().zoom >= zoomedIn) {
    wheelProblems.push("ctrl+wheel down did not zoom out");
  }

  // Meta (cmd) behaves the same, and the zoom range is clamped.
  const beforeMeta = useEditor.getState().zoom;
  scroller.wheel({ deltaY: -240, metaKey: true, clientX: 500 });
  if (useEditor.getState().zoom <= beforeMeta) wheelProblems.push("meta+wheel did not zoom");

  useEditor.getState().setZoom(MAX_ZOOM);
  scroller.wheel({ deltaY: -5000, ctrlKey: true, clientX: 500 });
  if (useEditor.getState().zoom !== MAX_ZOOM) {
    wheelProblems.push(`zoom exceeded the maximum (${useEditor.getState().zoom})`);
  }
  useEditor.getState().setZoom(MIN_ZOOM);
  scroller.wheel({ deltaY: 5000, ctrlKey: true, clientX: 500 });
  if (useEditor.getState().zoom !== MIN_ZOOM) {
    wheelProblems.push(`zoom went below the minimum (${useEditor.getState().zoom})`);
  }

  // ---- a scroll container already at its edge must still not leak the event ----
  scroller.scrollLeft = 0;
  prevented = scroller.wheel({ deltaY: -100 });
  if (!prevented || scroller.scrollLeft !== 0) {
    wheelProblems.push("scrolling up at the left edge misbehaved");
  }

  // ---- detaching really removes the listener ----
  detach();
  scroller.scrollLeft = 0;
  scroller.wheel({ deltaY: 200 });
  if (scroller.scrollLeft !== 0) wheelProblems.push("the wheel listener stayed attached after detach");

  registerTimelineViewport(null);
}

if (wheelProblems.length === 0) {
  console.log("  PASS  wheel scrolls horizontally, shift vertically, ctrl zooms about the pointer");
} else {
  for (const problem of wheelProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Magnetic snapping
 *
 * The original implementation only ever snapped a dragged clip's *head*, so
 * butting a clip's tail against the next cut was impossible without knowing its
 * exact length. These assertions cover both edges.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("snapping");
const snapProblems: string[] = [];

{
  const fps = 30;
  const zoom = 100; // 100 px per second, so the 7px tolerance is 0.07s

  const a = createTextClip({ text: "a", start: 2, duration: 3 }); // 2 → 5
  const b = createTextClip({ text: "b", start: 10, duration: 2 }); // 10 → 12
  const project: Project = {
    ...createProject(),
    tracks: [{ ...createTrack("visual", "V"), clips: [a, b] }],
  };

  const targets = collectSnapTimes(project, [], 7.5);

  // Every edge is a target, plus the origin and the playhead.
  for (const expected of [0, 2, 5, 10, 12, 7.5]) {
    if (!targets.some((t) => Math.abs(t - expected) < 1e-9)) {
      snapProblems.push(`snap targets are missing ${expected}`);
    }
  }
  // The dragged clip must not be a target for itself.
  const withoutA = collectSnapTimes(project, [a.id], 7.5);
  if (withoutA.some((t) => Math.abs(t - 2) < 1e-9)) {
    snapProblems.push("a dragged clip is still one of its own snap targets");
  }
  if (withoutA.some((t) => Math.abs(t - 5) < 1e-9)) {
    snapProblems.push("excluding a clip left one of its own edges as a target");
  }
  if (!withoutA.some((t) => Math.abs(t - 10) < 1e-9)) {
    snapProblems.push("excluding one clip removed another clip's edge");
  }

  // ---- head snapping ----
  const head = snapSpan(4.96, 2, targets, zoom, fps);
  if (Math.abs(head.time - 5) > 1e-9) {
    snapProblems.push(`head snap gave ${head.time}, expected 5`);
  }
  if (head.guide === null) snapProblems.push("a successful snap reported no guide");

  // ---- tail snapping: the case that used to be impossible ----
  // Head 7.95 with a 2s clip puts the tail at 9.95, within 5px of the 10s cut.
  // Head-only snapping (the old behaviour) would have left the clip at 7.95.
  const tail = snapSpan(7.95, 2, targets, zoom, fps);
  if (Math.abs(tail.time - 8) > 1e-6) {
    snapProblems.push(
      `tail snap gave ${tail.time}, expected 8 (so the tail lands on the 10s cut)`,
    );
  }
  if (tail.guide === null || Math.abs(tail.guide - 10) > 1e-9) {
    snapProblems.push(`tail snap guided to ${tail.guide}, expected 10`);
  }

  // ---- the closer of the two edges wins ----
  // Head 4.95 is 0.05s (5px) from the 5s cut; the tail is nowhere near anything.
  const headWins = snapSpan(4.95, 2, targets, zoom, fps);
  if (Math.abs(headWins.time - 5) > 1e-6) {
    snapProblems.push(`expected the head to win, got ${headWins.time}`);
  }
  // Head 7.0 is far from every cut; tail 9.95 is 5px from the 10s cut.
  const tailWins = snapSpan(7.0, 2.95, targets, zoom, fps);
  if (Math.abs(tailWins.time - (10 - 2.95)) > 1e-6) {
    snapProblems.push(`expected the tail to win, got ${tailWins.time}`);
  }

  // ---- outside the tolerance nothing is magnetised, only frame-quantised ----
  const far = snapSpan(6.0, 1, targets, zoom, fps);
  if (far.guide !== null) snapProblems.push("a distant drag still reported a magnet guide");
  const frame = 1 / fps;
  if (Math.abs(far.time / frame - Math.round(far.time / frame)) > 1e-6) {
    snapProblems.push(`an unsnapped drag landed off the frame grid at ${far.time}`);
  }

  // ---- tolerance is in *pixels*, so zooming in narrows it in time ----
  // 5.05s is 5px from the 5s cut at 100 px/s, but 20px away at 400 px/s.
  if (snapEdge(5.05, targets, 100, fps).guide === null) {
    snapProblems.push("the magnet failed to reach a target within tolerance");
  }
  if (snapEdge(5.05, targets, 400, fps).guide !== null) {
    snapProblems.push("zooming in did not tighten the magnet (tolerance must be in pixels)");
  }

  // ---- single-edge snapping (trim handles and the playhead) ----
  const edge = snapEdge(1.965, targets, zoom, fps);
  if (Math.abs(edge.time - 2) > 1e-9) {
    snapProblems.push(`edge snap gave ${edge.time}, expected 2`);
  }
  const noEdge = snapEdge(3.3333, [], zoom, fps);
  if (noEdge.guide !== null) snapProblems.push("an empty target list still reported a guide");
  if (Math.abs(noEdge.time - quantizeToFrame(3.3333, fps)) > 1e-9) {
    snapProblems.push("with no targets the result must fall back to the frame grid");
  }

  // ---- a nonsense zoom must not produce NaN or Infinity ----
  const degenerate = snapEdge(5.001, targets, 0, fps);
  if (!Number.isFinite(degenerate.time)) {
    snapProblems.push("a zero zoom produced a non-finite snap result");
  }
  if (!Number.isFinite(quantizeToFrame(1.234, 0))) {
    snapProblems.push("a zero fps produced a non-finite frame quantisation");
  }
}

if (snapProblems.length === 0) {
  console.log("  PASS  either edge snaps to cuts, with a pixel tolerance and a frame fallback");
} else {
  for (const problem of snapProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Drag auto-scroll and scroll-compensated drag deltas
 *
 * Two separate bugs: trimming past the right edge needed a manual scroll, and a
 * drag that scrolled underneath the pointer moved the clip by the wrong amount.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("drag auto-scroll");
const scrollProblems: string[] = [];

{
  class ScrollBox {
    /** Real elements clamp at 0, so the fake must too. */
    private left = 0;
    clientWidth = 1000;
    clientHeight = 400;

    get scrollLeft(): number {
      return this.left;
    }

    set scrollLeft(value: number) {
      this.left = Math.max(0, value);
    }

    getBoundingClientRect() {
      return {
        left: 0,
        top: 0,
        right: this.clientWidth,
        bottom: this.clientHeight,
        width: this.clientWidth,
        height: this.clientHeight,
        x: 0,
        y: 0,
      };
    }
  }

  const box = new ScrollBox();
  registerTimelineViewport(box as unknown as HTMLElement);

  // Left zone starts after the header column, which does not scroll.
  const leftZone = HEADER_W + 46;
  if (autoscrollForPointer(leftZone + 100) !== 0) {
    scrollProblems.push("a pointer in the middle of the timeline started scrolling");
  }
  if (!(autoscrollForPointer(HEADER_W) < 0)) {
    scrollProblems.push("a pointer at the left edge did not scroll backwards");
  }
  if (!(autoscrollForPointer(995) > 0)) {
    scrollProblems.push("a pointer at the right edge did not scroll forwards");
  }
  if (Math.abs(autoscrollForPointer(-500)) > 22) {
    scrollProblems.push("auto-scroll speed is not capped");
  }
  // Deep inside the header must not scroll at all: the header is fixed.
  if (autoscrollForPointer(4) === 0) {
    scrollProblems.push("a pointer inside the header column should still scroll the grid");
  }

  // Ticking actually moves the view, and reports that it is still at the edge.
  box.scrollLeft = 100;
  if (!tickAutoscroll(995)) scrollProblems.push("a tick at the right edge reported no scroll");
  if (box.scrollLeft <= 100) {
    scrollProblems.push(`a tick at the right edge did not advance scrollLeft (${box.scrollLeft})`);
  }
  box.scrollLeft = 0;
  tickAutoscroll(209);
  if (box.scrollLeft !== 0) {
    scrollProblems.push("scrolling left past the origin moved the view");
  }

  // ---- the delta must include how far the view scrolled ----
  const plain = dragDeltaTime({
    clientX: 400,
    startX: 300,
    startScrollLeft: 0,
    scrollLeft: 0,
    zoom: 100,
  });
  if (Math.abs(plain - 1) > 1e-9) {
    scrollProblems.push(`a stationary view gave a delta of ${plain}, expected 1`);
  }

  // The view scrolled 200px right while the pointer never moved: the clip must
  // travel 2s, not 0.
  const scrolled = dragDeltaTime({
    clientX: 300,
    startX: 300,
    startScrollLeft: 0,
    scrollLeft: 200,
    zoom: 100,
  });
  if (Math.abs(scrolled - 2) > 1e-9) {
    scrollProblems.push(
      `a 200px scroll with a stationary pointer gave ${scrolled}s, expected 2`,
    );
  }

  // Scrolling left cancels forward pointer travel.
  const cancel = dragDeltaTime({
    clientX: 400,
    startX: 300,
    startScrollLeft: 100,
    scrollLeft: 0,
    zoom: 100,
  });
  if (Math.abs(cancel - 0) > 1e-9) {
    scrollProblems.push(`a 100px left scroll should have cancelled 100px of travel (got ${cancel})`);
  }

  if (!Number.isFinite(dragDeltaTime({ clientX: 1, startX: 0, startScrollLeft: 0, scrollLeft: 0, zoom: 0 }))) {
    scrollProblems.push("a zero zoom produced a non-finite drag delta");
  }

  registerTimelineViewport(null);
}

if (scrollProblems.length === 0) {
  console.log("  PASS  drags scroll at the edges and follow the view under the pointer");
} else {
  for (const problem of scrollProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Grid width
 *
 * Zoomed out, the content is narrower than the panel. The grid used to stop at
 * the content width, so the rows and the ruler ended partway across and the rest
 * of the timeline was bare background — it looked like the tracks were cut off.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("grid width");
const gridProblems: string[] = [];

{
  const VIEWPORT = 1800;

  // Short project, zoomed right out: the grid must still fill the panel.
  const zoomedOut = gridWidth(8, 4, VIEWPORT);
  if (zoomedOut !== VIEWPORT - HEADER_W) {
    gridProblems.push(
      `a short zoomed-out project gives a grid of ${zoomedOut}px, expected ${VIEWPORT - HEADER_W}`,
    );
  }

  // A long project at a high zoom is unaffected: content still decides.
  const long = gridWidth(300, 30, VIEWPORT);
  if (long !== 303 * 30) {
    gridProblems.push(`a long project gives a grid of ${long}px, expected ${303 * 30}`);
  }

  // Never narrower than the panel, at any zoom or duration.
  for (const [duration, zoom] of [
    [1, 4],
    [8, 6],
    [60, 4],
    [600, 4],
    [0, 600],
  ] as const) {
    const width = gridWidth(duration, zoom, VIEWPORT);
    if (width < VIEWPORT - HEADER_W) {
      gridProblems.push(`gridWidth(${duration}, ${zoom}) = ${width} is narrower than the panel`);
    }
  }

  // Before the container has been measured the content rule still applies.
  if (gridWidth(8, 4, 0) !== 900) {
    gridProblems.push(`an unmeasured viewport should fall back to the content floor, got ${gridWidth(8, 4, 0)}`);
  }
  if (gridWidth(0, 4, 0) !== 900) {
    gridProblems.push("an empty project should still leave a usable grid");
  }

  // The tail after the last clip is what lets a clip be dragged past the end.
  const withTail = gridWidth(100, 10, 0);
  if (withTail <= 1000) {
    gridProblems.push(`no room after the last clip (grid ${withTail}px for 100s at 10px/s)`);
  }

  // Degenerate inputs must not produce NaN.
  for (const width of [
    gridWidth(Number.NaN, 10, VIEWPORT),
    gridWidth(10, 0, VIEWPORT),
    gridWidth(10, 10, Number.NaN),
  ]) {
    if (!Number.isFinite(width)) gridProblems.push("gridWidth produced a non-finite width");
  }
}

if (gridProblems.length === 0) {
  console.log("  PASS  the grid always spans the panel, and content still widens it");
} else {
  for (const problem of gridProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Clips must stay inside their media
 *
 * A clip whose source range runs past the end of its file renders black video or
 * silence with nothing to explain it. The reachable ways in are the inspector's
 * in-point field, relinking to a shorter file, and loading a hand-edited project.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("clip source bounds");
const boundsProblems: string[] = [];

{
  const media = (id: string, kind: "video" | "audio", duration?: number): Asset => ({
    id,
    kind,
    name: id,
    src: `${id}.bin`,
    duration,
    addedAt: 0,
  });

  /** Source seconds a clip consumes. */
  const consumed = (clip: Clip) => clip.trimIn + clip.duration * clip.speed;
  /**
   * A clip is never shorter than one frame (`clampClip` enforces that), so when
   * less than a frame of source is left the fit is off by at most one frame.
   * That is deliberate: a frame of black beats a zero-length clip.
   */
  const slack = (clip: Clip) => (1 / 60) * clip.speed;

  // ---- the inspector's in-point field can push past the end ----
  const tenSeconds = media("v10", "video", 10);
  const clip = createVideoClip({ assetId: "v10", start: 0, duration: 6 });
  const project: Project = {
    ...createProject(),
    assets: [tenSeconds],
    tracks: [{ ...createTrack("visual", "V"), clips: [clip] }],
  };

  // In-point 8 on a 6s clip at 1x needs 14s of a 10s file.
  clip.trimIn = 8;
  const repaired = normalizeProject(project);
  const fixed = repaired.tracks[0].clips[0];
  if (consumed(fixed) > 10 + slack(fixed)) {
    boundsProblems.push(
      `a clip still needs ${consumed(fixed).toFixed(2)}s from a 10s file after normalising`,
    );
  }
  if (fixed.duration <= 0) boundsProblems.push("the repaired clip has no duration");

  // An in-point past the very end is pulled back onto the last frame.
  const wayPast = { ...project, tracks: [{ ...project.tracks[0], clips: [{ ...clip, trimIn: 40, duration: 2 }] }] };
  const pulled = normalizeProject(wayPast).tracks[0].clips[0];
  if (pulled.trimIn >= 10) {
    boundsProblems.push(`an in-point past the end was left at ${pulled.trimIn}`);
  }
  if (consumed(pulled) > 10 + slack(pulled)) {
    boundsProblems.push("a clip starting past the end still overruns the file");
  }

  // ---- relinking to a shorter file must shorten the clips that use it ----
  const short = media("v10", "video", 3);
  const relinked: Project = { ...project, assets: [short], tracks: [{ ...project.tracks[0], clips: [{ ...clip, trimIn: 0, duration: 9 }] }] };
  const afterRelink = normalizeProject(relinked).tracks[0].clips[0];
  if (consumed(afterRelink) > 3 + slack(afterRelink)) {
    boundsProblems.push(
      `after relinking to a 3s file a clip still needs ${consumed(afterRelink).toFixed(2)}s`,
    );
  }

  // ---- speed changes must preserve the invariant, not break it ----
  const speedProject: Project = {
    ...createProject(),
    assets: [tenSeconds],
    tracks: [{ ...createTrack("visual", "V"), clips: [createVideoClip({ assetId: "v10", start: 0, duration: 10 })] }],
  };
  useEditor.getState().loadProject(speedProject);
  const clipId = useEditor.getState().project.tracks[0].clips[0].id;
  for (const speed of [0.5, 2, 4, 8, 0.05]) {
    useEditor.getState().setClipSpeed(clipId, speed);
    const current = useEditor.getState().project.tracks[0].clips[0];
    if (consumed(current) > 10 + slack(current)) {
      boundsProblems.push(
        `speed ${speed}x left the clip needing ${consumed(current).toFixed(2)}s of a 10s file`,
      );
    }
  }

  // ---- unknown or absent media is left alone, never clamped to nothing ----
  const unknown = media("v?", "video", undefined);
  const guessProject: Project = {
    ...createProject(),
    assets: [unknown],
    tracks: [{ ...createTrack("visual", "V"), clips: [createVideoClip({ assetId: "v?", start: 0, duration: 12 })] }],
  };
  const untouched = normalizeProject(guessProject).tracks[0].clips[0];
  if (Math.abs(untouched.duration - 12) > 1e-6) {
    boundsProblems.push(
      `a clip on an asset of unknown length was clamped to ${untouched.duration}s`,
    );
  }
  const missing: Project = {
    ...createProject(),
    tracks: [{ ...createTrack("visual", "V"), clips: [createVideoClip({ assetId: "gone", start: 0, duration: 7 })] }],
  };
  if (Math.abs(normalizeProject(missing).tracks[0].clips[0].duration - 7) > 1e-6) {
    boundsProblems.push("a clip pointing at a missing asset was clamped");
  }

  // Stills and shapes have no source to overrun.
  const stillProject: Project = {
    ...createProject(),
    tracks: [{ ...createTrack("visual", "V"), clips: [createImageClip({ assetId: "gone", start: 0, duration: 9 })] }],
  };
  if (Math.abs(normalizeProject(stillProject).tracks[0].clips[0].duration - 9) > 1e-6) {
    boundsProblems.push("a still image was clamped as though it had a source length");
  }

  // ---- the invariant must hold across every real template ----
  for (const template of TEMPLATES) {
    const built = buildFromTemplate(template, defaultSlotValues(template), []);
    for (const track of built.tracks) {
      for (const c of track.clips) {
        const asset = clipAsset(built, c);
        if (!asset?.duration || asset.duration <= 0) continue;
        const needs = c.trimIn + c.duration * c.speed;
        if (needs > asset.duration + 0.02) {
          boundsProblems.push(
            `template ${template.id}: "${c.name}" needs ${needs.toFixed(2)}s of a ${asset.duration.toFixed(2)}s asset`,
          );
        }
      }
    }
  }
}

if (boundsProblems.length === 0) {
  console.log("  PASS  no clip consumes more media than its file holds");
} else {
  for (const problem of boundsProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Export length
 *
 * `effectiveDuration` used to be `max(content, settings.duration)`, and
 * `settings.duration` defaults to 30 and is never updated — so a short edit
 * exported as 30 seconds with black at the end.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("timeline length");
const lengthProblems: string[] = [];

{
  // A project whose clips stop at 8s, with the untouched default of 30.
  const clips = [
    createTextClip({ text: "a", start: 0, duration: 3 }),
    createTextClip({ text: "b", start: 5, duration: 3 }),
  ];
  const short: Project = {
    ...createProject(),
    tracks: [{ ...createTrack("visual", "V"), clips }],
  };
  if (short.settings.duration !== 30) {
    lengthProblems.push("the fixture assumed a default authored duration of 30");
  }

  const length = effectiveDuration(short);
  if (Math.abs(length - 8) > 1e-6) {
    lengthProblems.push(
      `a 3+3s edit reports ${length}s; content must win over the 30s default`,
    );
  }

  // The export plan must agree with it: this is what actually gets rendered.
  const plan = planExport(short, { fps: 30 });
  if (Math.abs(plan.durationSec - 8) > 0.05) {
    lengthProblems.push(
      `the export plan renders ${plan.durationSec.toFixed(2)}s for 8s of content`,
    );
  }
  if (plan.totalFrames !== 240) {
    lengthProblems.push(`the export plan renders ${plan.totalFrames} frames, expected 240`);
  }

  // ---- an empty timeline still has a usable length ----
  const empty = createProject();
  if (Math.abs(effectiveDuration(empty) - 30) > 1e-6) {
    lengthProblems.push(
      `an empty project reports ${effectiveDuration(empty)}s, expected the authored 30s`,
    );
  }
  const zero: Project = { ...createProject(), settings: { ...createProject().settings, duration: 0 } };
  if (!(effectiveDuration(zero) > 0)) {
    lengthProblems.push("a project with no content and no authored length must still be positive");
  }

  // ---- a clip that ends later than the authored length still wins ----
  const long: Project = {
    ...createProject(),
    tracks: [
      { ...createTrack("visual", "V"), clips: [createTextClip({ text: "long", start: 40, duration: 5 })] },
    ],
  };
  if (Math.abs(effectiveDuration(long) - 45) > 1e-6) {
    lengthProblems.push(`trailing content was truncated at ${effectiveDuration(long)}s`);
  }

  // ---- disabled and hidden clips still occupy time, so they still count ----
  const disabled = createTextClip({ text: "d", start: 0, duration: 6 });
  disabled.enabled = false;
  const withDisabled: Project = {
    ...createProject(),
    tracks: [{ ...createTrack("visual", "V"), clips: [disabled] }],
  };
  if (Math.abs(effectiveDuration(withDisabled) - 6) > 1e-6) {
    lengthProblems.push("a disabled clip was ignored when measuring the timeline");
  }

  // ---- every template keeps its declared length ----
  for (const template of TEMPLATES) {
    const built = buildFromTemplate(template, defaultSlotValues(template), []);
    const measured = effectiveDuration(built);
    if (Math.abs(measured - template.duration) > 0.06) {
      lengthProblems.push(
        `template ${template.id} now measures ${measured.toFixed(2)}s, declared ${template.duration}s`,
      );
    }
  }
}

if (lengthProblems.length === 0) {
  console.log("  PASS  the timeline ends with its content, and templates keep their length");
} else {
  for (const problem of lengthProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Project name
 *
 * The title in the titlebar is what names the exported video, the HTML page and
 * the project file, so a rename has to reach all of them.
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("project name");
const nameProblems: string[] = [];

{
  useEditor.getState().loadProject({
    ...createProject(),
    name: "未命名宣传片",
    tracks: [{ ...createTrack("visual", "V"), clips: [createTextClip({ text: "x", start: 0, duration: 2 })] }],
  });

  if (useEditor.getState().dirty) nameProblems.push("a freshly loaded project should be clean");

  useEditor.getState().renameProject("我的产品宣传片");
  const named = useEditor.getState().project;
  if (named.name !== "我的产品宣传片") {
    nameProblems.push(`renameProject stored "${named.name}"`);
  }
  if (!useEditor.getState().dirty) {
    nameProblems.push("renaming did not mark the project dirty, so it could be lost");
  }

  // One rename is one undo step.
  useEditor.getState().undo();
  if (useEditor.getState().project.name !== "未命名宣传片") {
    nameProblems.push("one undo did not restore the previous name");
  }
  useEditor.getState().redo();

  // The name reaches the exported page title.
  const bundle = await exportStandaloneHtml(useEditor.getState().project, {
    mode: "single",
    playerSource: "/* test player */",
  });
  if (!bundle.html.includes("我的产品宣传片")) {
    nameProblems.push("the exported HTML does not carry the project name");
  }

  // A blank name is never stored by the UI; the export still needs a fallback.
  const unnamed: Project = { ...createProject(), name: "" };
  const fallback = await exportStandaloneHtml(unnamed, {
    mode: "single",
    playerSource: "/* test player */",
  });
  if (!fallback.html.includes("qookiv")) {
    nameProblems.push("an unnamed project did not fall back to a default page title");
  }
}

if (nameProblems.length === 0) {
  console.log("  PASS  the title names the project, its undo step and the export");
} else {
  for (const problem of nameProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Whole-app shell render
 *
 * There is no browser here, so the React shell is server-rendered instead. That
 * still executes every component body and every store selector it reaches, which
 * is where an undefined import or a runaway selector shows up. Effects (and
 * therefore canvas work) do not run under SSR — the engine section above covers
 * those.
 *
 * 注意：应用**从首页启动**（`view` 的初值是 `"home"`，只有用户点进去才切到编辑器），
 * 所以这里能渲染到的是首页 + 标题栏，断言也按这个来。编辑器那棵树不是没被覆盖，
 * 而是由下面那些直接驱动 store 的小节覆盖。
 * ------------------------------------------------------------------ */

console.log("========================");
console.log("shell render");
const shellProblems: string[] = [];

try {
  const html = renderToString(createElement(App));
  // `打开` 在标题栏里，首页和编辑器都在；其余是首页自己的。
  for (const marker of ["qv-app", "QookiV", "qv-home", "开始创作", "打开"]) {
    if (!html.includes(marker)) shellProblems.push(`markup is missing "${marker}"`);
  }
  if (html.length < 2000) shellProblems.push(`suspiciously small render (${html.length} chars)`);
  console.log(`  rendered ${html.length} chars of markup`);
} catch (error) {
  shellProblems.push(`renderToString threw: ${String(error)}`);
}

/*
 * 「尺寸过渡」工具的 store 路径。
 *
 * 检查器里那个按钮做的事就是这三行：算增量 → 一次性更新所有选中图层 → 写入提示。
 * 这里直接驱动 store（不经过 React），把最有价值的两条钉住：**整次操作只占一步撤销**，
 * 以及**外框与截图之间的边框厚度保持不变**。JSX 那层只过了类型检查——SSR 下 zustand 读
 * 的是 `getInitialState()` 快照，渲染不到"选中了片段"的分支。
 */
try {
  const frame = createShapeClip({
    name: "外框",
    start: 2,
    duration: 4,
    props: { width: 1121, height: 522, fill: "#241C16" },
  });
  const shot = createDeviceClip({
    name: "截图",
    start: 2,
    duration: 4,
    props: { width: 1105, height: 506 },
  });
  useEditor.getState().loadProject({
    ...createProject(),
    tracks: [{ ...createTrack("visual", "卡"), clips: [frame, shot] }],
  });

  const historyBefore = useEditor.getState().past.length;
  const items = [frame, shot].map((clip) => ({ clip, at: 0 }));
  const plan = planSizeTransition(items, 1, { width: 1330, height: 866 });
  useEditor.getState().updateClips(
    plan.map((p) => p.id),
    (c) => {
      const target = plan.find((entry) => entry.id === c.id);
      if (!target) return c;
      let next = applyNumberTransition({
        clip: c,
        path: "props.width",
        target: target.width,
        at: 0,
        duration: 0.6,
      });
      next = applyNumberTransition({
        clip: next,
        path: "props.height",
        target: target.height,
        at: 0,
        duration: 0.6,
      });
      return next;
    },
  );

  const after = useEditor.getState();
  if (after.past.length !== historyBefore + 1) {
    shellProblems.push(
      `size transition took ${after.past.length - historyBefore} undo steps, expected 1`,
    );
  }
  const widthAt = (name: string, localTime: number): number => {
    const clip = after.project.tracks[0].clips.find((c) => c.name === name);
    if (!clip) return NaN;
    return (resolveClipAt(clip, localTime) as { props: { width: number } }).props.width;
  };
  if (Math.abs(widthAt("截图", 0.6) - 1330) > 1e-6) {
    shellProblems.push(`the screenshot should land on 1330px, got ${widthAt("截图", 0.6).toFixed(1)}`);
  }
  if (Math.abs(widthAt("外框", 0.6) - widthAt("截图", 0.6) - 16) > 1e-6) {
    shellProblems.push(
      `the border thinned: frame ${widthAt("外框", 0.6).toFixed(1)} vs shot ${widthAt("截图", 0.6).toFixed(1)}`,
    );
  }
  console.log(
    `  size transition via store: 截图 ${widthAt("截图", 0).toFixed(0)}→${widthAt("截图", 0.6).toFixed(0)}px, 1 undo step`,
  );
} catch (error) {
  shellProblems.push(`size transition store path threw: ${String(error)}`);
}

// The export pipelines are only reachable through dialogs, so a module-level
// failure there would be invisible until a user opened one.
if (typeof exportVideo !== "function") shellProblems.push("exportVideo is not exported");
if (typeof exportStandaloneHtml !== "function") {
  shellProblems.push("exportStandaloneHtml is not exported");
}

if (shellProblems.length === 0) {
  console.log("  PASS  shell renders and both export pipelines load");
} else {
  for (const problem of shellProblems) console.log(`        - ${problem}`);
  process.exitCode = 1;
}
