import { createBackgroundClip, createClipOfKind } from "../core/clips";
import type { TextVariant } from "../core/clips";
import { createTrack } from "../core/project";
import { mergeAnimations } from "../core/motion";
import type {
  AnimationMap,
  Asset,
  BackgroundClip,
  BackgroundClipProps,
  Clip,
  ClipKind,
  Project,
  Seconds,
  SlotRecord,
  SlotValue,
  ThemeTokens,
  Track,
  TrackKind,
  Transition,
  TransitionKind,
} from "../core/types";
import { createProjectSettings } from "../core/project";
import type { BuildContext, PromoTemplate, SlotValues } from "./types";
import { defaultSlotValues } from "./types";

/**
 * Authoring toolkit for templates.
 *
 * Templates are written as a sequence of scenes on named tracks. The builders
 * here keep placement arithmetic out of the template files, so a template reads
 * like a shot list rather than a pile of numbers.
 */

/* ------------------------------------------------------------------ *
 * Slot accessors
 * ------------------------------------------------------------------ */

export function sStr(values: SlotValues, id: string, fallback = ""): string {
  const v = values[id];
  return typeof v === "string" ? v : fallback;
}

export function sNum(values: SlotValues, id: string, fallback = 0): number {
  const v = values[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function sBool(values: SlotValues, id: string, fallback = false): boolean {
  const v = values[id];
  return typeof v === "boolean" ? v : fallback;
}

export function sColor(values: SlotValues, id: string, fallback: string): string {
  const v = values[id];
  return typeof v === "string" && v.trim().length > 0 ? v : fallback;
}

/** Resolves an asset slot, falling back to the first imported asset. */
export function sAsset(
  values: SlotValues,
  id: string,
  ctx: BuildContext,
  kind: "image" | "video" | "audio" = "image",
): Asset | undefined {
  const v = values[id];
  if (typeof v === "string" && v) {
    const found = ctx.assets.find((a) => a.id === v);
    if (found) return found;
  }
  return kind === "image"
    ? ctx.firstImage ?? ctx.firstVideo
    : kind === "video"
      ? ctx.firstVideo
      : ctx.firstAudio;
}

/* ------------------------------------------------------------------ *
 * Track building
 * ------------------------------------------------------------------ */

/** A visual or audio track whose clips are placed along a moving cursor. */
export class TrackBuilder {
  readonly track: Track;
  private cursor = 0;

  constructor(kind: TrackKind, name: string) {
    this.track = createTrack(kind, name);
  }

  /** Moves the cursor to an absolute time. */
  at(time: Seconds): this {
    this.cursor = Math.max(0, time);
    return this;
  }

  /** Advances the cursor. */
  gap(seconds: Seconds): this {
    this.cursor = Math.max(0, this.cursor + seconds);
    return this;
  }

  /** Appends a clip at the cursor and advances past it. */
  push(clip: Clip, gapAfter = 0): this {
    this.track.clips.push({ ...clip, start: this.cursor });
    this.cursor += clip.duration + gapAfter;
    return this;
  }

  /** Places a clip at an explicit time without moving the cursor. */
  place(clip: Clip, start: Seconds): this {
    this.track.clips.push({ ...clip, start: Math.max(0, start) });
    return this;
  }

  get end(): Seconds {
    return this.track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  }
}

/* ------------------------------------------------------------------ *
 * Clip helpers
 * ------------------------------------------------------------------ */

export interface ClipOptions {
  start?: Seconds;
  duration?: Seconds;
  name?: string;
  enter?: AnimationMap;
  exit?: AnimationMap;
  transitionIn?: Transition;
  transitionOut?: Transition;
  extra?: AnimationMap;
}

/** Creates any clip kind with animations and transitions folded in. */
export function makeClip(
  kind: ClipKind,
  opts: ClipOptions & {
    assetId?: string;
    text?: string;
    variant?: TextVariant;
    props?: Record<string, unknown>;
    theme?: ThemeTokens;
  },
): Clip {
  const clip = createClipOfKind(kind, {
    start: opts.start ?? 0,
    duration: opts.duration,
    name: opts.name,
    assetId: opts.assetId,
    text: opts.text,
    variant: opts.variant,
    props: opts.props,
    theme: opts.theme,
  });
  clip.animation = mergeAnimations(opts.enter, opts.extra, opts.exit);
  if (opts.transitionIn) clip.transitionIn = opts.transitionIn;
  if (opts.transitionOut) clip.transitionOut = opts.transitionOut;
  return clip;
}

/** Convenience transition descriptor. */
export function tr(kind: TransitionKind, duration = 0.5): Transition {
  return { kind, duration, easing: "easeOutCubic" };
}

/** A full-frame background scene block. */
export function makeBackground(
  theme: ThemeTokens,
  duration: Seconds,
  overrides: Partial<BackgroundClipProps> = {},
  start: Seconds = 0,
): BackgroundClip {
  const clip = createBackgroundClip({
    start,
    duration,
    theme,
    props: {
      color: theme.bg0,
      gradient: { enabled: true, from: theme.bg1, to: theme.bg0, angle: 135 },
      ...overrides,
    },
  });
  return clip;
}

/* ------------------------------------------------------------------ *
 * Project assembly
 * ------------------------------------------------------------------ */

/**
 * Builds the project shell for a template: settings from the template's aspect
 * and duration, its theme, and a set of named tracks in paint order.
 */
export function buildTemplateProject(
  template: PromoTemplate,
  values: SlotValues,
  ctx: BuildContext,
  tracks: Track[],
  opts: { background?: Clip[] } = {},
): Project {
  const resolved = { ...defaultSlotValues(template), ...values };
  const settings = createProjectSettings(settingsForAspect(template.aspect));
  settings.duration = template.duration;

  const withBackground = [...tracks];
  if (opts.background && opts.background.length > 0) {
    withBackground.unshift({
      ...createTrack("visual", "背景"),
      clips: opts.background,
    });
  }

  const firstAudio = ctx.firstAudio;
  if (firstAudio && !withBackground.some((t) => t.kind === "audio")) {
    const audioClip = createClipOfKind("audio", {
      assetId: firstAudio.id,
      duration: Math.min(template.duration, firstAudio.duration ?? template.duration),
      name: firstAudio.name,
      props: { volume: 0.6, fit: "none" },
    });
    withBackground.push({ ...createTrack("audio", "背景音乐"), clips: [audioClip] });
  }

  return {
    id: "",
    schemaVersion: 1,
    name: template.name,
    settings,
    theme: ctx.theme,
    assets: ctx.assets,
    tracks: withBackground,
    templateId: template.id,
    slots: resolved,
    detachedClipIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Project;
}

function settingsForAspect(aspect: PromoTemplate["aspect"]) {
  switch (aspect) {
    case "9:16":
      return { width: 1080, height: 1920, aspect, fps: 30 };
    case "1:1":
      return { width: 1080, height: 1080, aspect, fps: 30 };
    case "4:5":
      return { width: 1080, height: 1350, aspect, fps: 30 };
    case "21:9":
      return { width: 2560, height: 1080, aspect, fps: 30 };
    case "16:9":
    default:
      return { width: 1920, height: 1080, aspect, fps: 30 };
  }
}

/** Reads a numeric slot with clamping, used by templates for tunable pacing. */
export function sClamped(values: SlotValues, id: string, fallback: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, sNum(values, id, fallback)));
}

/** Reads a string-array slot. */
export function sList(values: SlotValues, id: string, fallback: string[]): string[] {
  const v = values[id];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return fallback;
}

/** Typed accessor for a slot value used in a switch-like context. */
export function sRaw(values: SlotValues, id: string): SlotValue | undefined {
  return values[id];
}

/* ------------------------------------------------------------------ *
 * 列表槽位（可增删的面板 / 条目）
 * ------------------------------------------------------------------ */

/**
 * 读取一个 `list` 槽位：把它规整成"条目数组"。
 *
 * 表单里存进来的是 `SlotRecord[]`，但存档可能来自旧版本、也可能被人手改过，
 * 所以这里做一次清洗：只保留对象条目、丢掉 `null`/字符串之类的垃圾。模板因此
 * 可以放心 `panels.map(...)`，不必到处写类型判断。
 */
export function sRecords(values: SlotValues, id: string, fallback: SlotRecord[] = []): SlotRecord[] {
  const v = values[id];
  if (!Array.isArray(v)) return fallback;
  const out: SlotRecord[] = [];
  for (const entry of v) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out.push(entry as SlotRecord);
    }
  }
  return out.length > 0 ? out : fallback;
}

/**
 * 读条目里的一个**嵌套 list** 字段（条目里再套一层可增删条目）。
 *
 * 和 `sRecords` 同样的清洗逻辑，只是作用在条目字段上而非顶层槽位。表单里
 * "面板 → 项列表"这种两层结构就靠它读。
 */
export function sRecRecords(record: SlotRecord, id: string, fallback: SlotRecord[] = []): SlotRecord[] {
  const v = record[id];
  if (!Array.isArray(v)) return fallback;
  const out: SlotRecord[] = [];
  for (const entry of v) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      out.push(entry as SlotRecord);
    }
  }
  return out.length > 0 ? out : fallback;
}

/** 读条目里的一个字符串字段。 */
export function sRecStr(record: SlotRecord, id: string, fallback = ""): string {
  const v = record[id];
  return typeof v === "string" ? v : fallback;
}

/** 读条目里的一个数字字段。 */
export function sRecNum(record: SlotRecord, id: string, fallback = 0): number {
  const v = record[id];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 读条目里的一个布尔字段（表单里的开关）。 */
export function sRecBool(record: SlotRecord, id: string, fallback = false): boolean {
  const v = record[id];
  return typeof v === "boolean" ? v : fallback;
}

/**
 * 条目里的图片：优先用这一格选的素材，没选就回落到整条工程的第一张图。
 *
 * "每一个面板里的每一项都能配一张图"就落在这里——条目自己带 `assetId`，
 * 空着时退化成模板原先的行为（所有卡片共用同一张）。
 */
export function sRecAsset(
  record: SlotRecord,
  id: string,
  ctx: BuildContext,
  kind: "image" | "video" = "image",
): Asset | undefined {
  const v = record[id];
  if (typeof v === "string" && v) {
    const found = ctx.assets.find((a) => a.id === v);
    if (found) return found;
  }
  return kind === "image" ? ctx.firstImage ?? ctx.firstVideo : ctx.firstVideo;
}

/** 条目里的图片 id（空字符串表示"用自动回落的素材"）。 */
export function sRecAssetId(record: SlotRecord, id: string, ctx: BuildContext): string {
  return sRecAsset(record, id, ctx)?.id ?? "";
}
