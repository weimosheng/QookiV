import { createClipOfKind } from "./clips";
import { newId } from "./ids";
import { createProject, createProjectSettings, normalizeProject } from "./project";
import { QOOKIX_PRESENTATION } from "./theme";
import type {
  AnimationMap,
  Asset,
  Clip,
  ClipKind,
  Project,
  SlotValue,
  ThemeTokens,
  Track,
  TrackKind,
} from "./types";
import { SCHEMA_VERSION } from "./types";

/**
 * Loading and validation.
 *
 * A project file is user data that may be hand-edited or produced by an older
 * build, so every field is coerced back to a valid value rather than trusted.
 * The reader never throws on a partially valid file — it repairs and reports.
 */

export interface ParseResult {
  project: Project;
  warnings: string[];
}

const CLIP_KINDS: ClipKind[] = [
  "text",
  "image",
  "video",
  "audio",
  "shape",
  "device",
  "background",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function coerceAnimation(raw: unknown): AnimationMap {
  if (!isRecord(raw)) return {};
  const out: AnimationMap = {};
  for (const [path, frames] of Object.entries(raw)) {
    if (!Array.isArray(frames)) continue;
    const list = frames
      .filter(isRecord)
      .map((f) => ({
        time: Math.max(0, num(f.time, 0)),
        value: (typeof f.value === "number" || typeof f.value === "string"
          ? f.value
          : 0) as number | string,
        easing: str(f.easing, "linear") as AnimationMap[string][number]["easing"],
      }))
      .sort((a, b) => a.time - b.time);
    if (list.length > 0) out[path] = list;
  }
  return out;
}

function coerceClip(raw: unknown, warnings: string[]): Clip | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== "string" || !CLIP_KINDS.includes(kind as ClipKind)) {
    warnings.push(`跳过未知片段类型：${String(kind)}`);
    return null;
  }

  const base = createClipOfKind(kind as ClipKind, {});
  const baseProps = base.props as unknown as Record<string, unknown>;
  const rawProps = isRecord(raw.props) ? raw.props : {};

  // Merge nested style objects explicitly so a partial file cannot erase them.
  const props: Record<string, unknown> = { ...baseProps, ...rawProps };
  if (isRecord(baseProps.style) && isRecord(rawProps.style)) {
    const baseStyle = baseProps.style as Record<string, unknown>;
    const rawStyle = rawProps.style as Record<string, unknown>;
    const style: Record<string, unknown> = { ...baseStyle, ...rawStyle };
    if (isRecord(baseStyle.gradient) && isRecord(rawStyle.gradient)) {
      style.gradient = { ...baseStyle.gradient, ...rawStyle.gradient };
    }
    if (isRecord(baseStyle.background) && isRecord(rawStyle.background)) {
      style.background = { ...baseStyle.background, ...rawStyle.background };
    }
    props.style = style;
  }
  if (isRecord(baseProps.gradient) && isRecord(rawProps.gradient) && kind === "background") {
    props.gradient = { ...baseProps.gradient, ...rawProps.gradient };
  }

  const transform = isRecord(raw.transform)
    ? { ...base.transform, ...(raw.transform as object) }
    : base.transform;
  const filters = isRecord(raw.filters)
    ? { ...base.filters, ...(raw.filters as object) }
    : base.filters;

  const clip = {
    ...base,
    ...(raw as object),
    kind,
    id: str(raw.id, base.id),
    name: str(raw.name, base.name),
    start: Math.max(0, num(raw.start, base.start)),
    duration: Math.max(1 / 240, num(raw.duration, base.duration)),
    trimIn: Math.max(0, num(raw.trimIn, 0)),
    speed: num(raw.speed, 1) === 0 ? 1 : num(raw.speed, 1),
    enabled: bool(raw.enabled, true),
    locked: bool(raw.locked, false),
    opacity: Math.max(0, Math.min(1, num(raw.opacity, 1))),
    transform,
    filters,
    animation: coerceAnimation(raw.animation),
    props,
  } as unknown as Clip;

  if (isRecord(raw.transitionIn)) {
    clip.transitionIn = {
      kind: str(raw.transitionIn.kind, "fade") as NonNullable<Clip["transitionIn"]>["kind"],
      duration: Math.max(0, num(raw.transitionIn.duration, 0.4)),
      easing: str(raw.transitionIn.easing, "easeOutCubic") as NonNullable<
        Clip["transitionIn"]
      >["easing"],
    };
  } else {
    delete clip.transitionIn;
  }

  if (isRecord(raw.transitionOut)) {
    clip.transitionOut = {
      kind: str(raw.transitionOut.kind, "fade") as NonNullable<Clip["transitionOut"]>["kind"],
      duration: Math.max(0, num(raw.transitionOut.duration, 0.4)),
      easing: str(raw.transitionOut.easing, "easeOutCubic") as NonNullable<
        Clip["transitionOut"]
      >["easing"],
    };
  } else {
    delete clip.transitionOut;
  }

  return clip;
}

function coerceTrack(raw: unknown, warnings: string[]): Track | null {
  if (!isRecord(raw)) return null;
  const kind: TrackKind = raw.kind === "audio" ? "audio" : "visual";
  const clips = Array.isArray(raw.clips)
    ? (raw.clips.map((c) => coerceClip(c, warnings)).filter(Boolean) as Clip[])
    : [];
  return {
    id: str(raw.id, "") || newId("track"),
    name: str(raw.name, kind === "audio" ? "音频" : "图层"),
    kind,
    clips,
    muted: bool(raw.muted, false),
    hidden: bool(raw.hidden, false),
    locked: bool(raw.locked, false),
  };
}

function coerceAsset(raw: unknown): Asset | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (kind !== "video" && kind !== "image" && kind !== "audio") return null;
  const src = str(raw.src, "");
  if (!src) return null;
  return {
    id: str(raw.id, "") || newId("asset"),
    kind,
    name: str(raw.name, "素材"),
    src,
    path: typeof raw.path === "string" ? raw.path : undefined,
    duration: typeof raw.duration === "number" ? raw.duration : undefined,
    width: typeof raw.width === "number" ? raw.width : undefined,
    height: typeof raw.height === "number" ? raw.height : undefined,
    fps: typeof raw.fps === "number" ? raw.fps : undefined,
    hasAudio: typeof raw.hasAudio === "boolean" ? raw.hasAudio : undefined,
    bytes: typeof raw.bytes === "number" ? raw.bytes : undefined,
    addedAt: num(raw.addedAt, Date.now()),
  };
}

export function parseProject(raw: unknown): ParseResult {
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return {
      project: normalizeProject(createProject()),
      warnings: ["文件内容不是有效的工程数据，已新建空白工程"],
    };
  }

  const settings = isRecord(raw.settings) ? raw.settings : {};
  const theme: ThemeTokens = isRecord(raw.theme)
    ? ({ ...QOOKIX_PRESENTATION, ...(raw.theme as object) } as ThemeTokens)
    : QOOKIX_PRESENTATION;

  const tracks = Array.isArray(raw.tracks)
    ? (raw.tracks.map((t) => coerceTrack(t, warnings)).filter(Boolean) as Track[])
    : [];

  const slots: Record<string, SlotValue> = {};
  if (isRecord(raw.slots)) {
    for (const [k, v] of Object.entries(raw.slots)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        slots[k] = v;
      } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        slots[k] = v as string[];
      }
    }
  }

  const project: Project = {
    id: str(raw.id, "") || newId("proj"),
    schemaVersion: SCHEMA_VERSION,
    name: str(raw.name, "未命名宣传片"),
    settings: createProjectSettings({
      width: Math.max(16, Math.round(num(settings.width, 1920))),
      height: Math.max(16, Math.round(num(settings.height, 1080))),
      fps: Math.max(1, Math.min(120, num(settings.fps, 30))),
      aspect: (str(settings.aspect, "16:9") as Project["settings"]["aspect"]) ?? "16:9",
      duration: Math.max(0.5, num(settings.duration, 30)),
      background: str(settings.background, "#000000"),
    }),
    theme,
    assets: Array.isArray(raw.assets)
      ? (raw.assets.map(coerceAsset).filter(Boolean) as Asset[])
      : [],
    tracks: tracks.length > 0 ? tracks : createProject().tracks,
    templateId: typeof raw.templateId === "string" ? raw.templateId : undefined,
    slots,
    detachedClipIds: Array.isArray(raw.detachedClipIds)
      ? raw.detachedClipIds.filter((v): v is string => typeof v === "string")
      : [],
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
  };

  if (raw.schemaVersion !== SCHEMA_VERSION) {
    warnings.push(
      `工程版本为 ${String(raw.schemaVersion ?? "未知")}，已按 v${SCHEMA_VERSION} 读取`,
    );
  }

  return { project: normalizeProject(project), warnings };
}

/** Convenience for callers that only need the project. */
export function parseProjectOrThrow(raw: unknown): Project {
  return parseProject(raw).project;
}
