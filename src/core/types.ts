/**
 * QookiV core domain model.
 *
 * Framework-agnostic: nothing in `src/core` may import React, the DOM store,
 * or any UI module. Both the live preview and the offline exporter consume
 * this exact model, which is what keeps "what you see" equal to "what you get".
 */

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

/** A duration or position on the project timeline, in seconds. */
export type Seconds = number;

/** A position inside a clip's own local time, in seconds from its in-point. */
export type LocalSeconds = number;

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

export type AssetKind = "video" | "image" | "audio";

export interface Asset {
  id: string;
  kind: AssetKind;
  /** Display name shown in the media pool. */
  name: string;
  /**
   * Resolvable source. In the desktop app this is a Tauri `asset:` URL; in the
   * stand-alone HTML export it is rewritten to a data URL or relative path.
   */
  src: string;
  /** OS path the asset was imported from, when known. */
  path?: string;
  /** Intrinsic media duration in seconds (video/audio only). */
  duration?: Seconds;
  width?: number;
  height?: number;
  /** Nominal source frame rate, used to pick sensible seek steps. */
  fps?: number;
  hasAudio?: boolean;
  /** Byte size on disk, used by the export size estimator. */
  bytes?: number;
  addedAt: number;
}

/* ------------------------------------------------------------------ *
 * Colour & transform primitives
 * ------------------------------------------------------------------ */

/** `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgba(...)`. */
export type Color = string;

export interface Transform {
  /** Offset from the layer origin, in project pixels. */
  x: number;
  y: number;
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  /**
   * Anchor in normalised 0..1 layer coordinates. 0.5/0.5 rotates and scales
   * about the layer centre, which is what promo templates almost always want.
   */
  anchorX: number;
  anchorY: number;
}

export interface FilterState {
  /** Gaussian blur radius in project pixels. */
  blur: number;
  /** 1 = unchanged. */
  brightness: number;
  contrast: number;
  saturate: number;
  /** 0..1 desaturation toward greyscale, applied after `saturate`. */
  grayscale: number;
  hueRotate: number;
  /** Drop shadow behind the layer, in project pixels. */
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  shadowColor: Color;
}

/* ------------------------------------------------------------------ *
 * Animation
 * ------------------------------------------------------------------ */

export type EasingName =
  | "linear"
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInQuart"
  | "easeOutQuart"
  | "easeInOutQuart"
  | "easeInExpo"
  | "easeOutExpo"
  | "easeInOutExpo"
  | "easeOutBack"
  | "easeInBack"
  | "easeInOutBack"
  | "easeOutElastic"
  | "easeOutBounce"
  | "hold";

export type AnimatedValue = number | Color;

export interface Keyframe {
  /** Clip-local time in seconds, measured from the clip's start. */
  time: LocalSeconds;
  value: AnimatedValue;
  /** Easing applied on the segment leading *into* this keyframe. */
  easing: EasingName;
}

/**
 * Maps a dotted property path (`transform.x`, `opacity`, `props.radius`) to its
 * keyframe list. Paths are resolved against the clip object by the animation
 * resolver, so adding a new animated property needs no changes here.
 */
export type AnimationMap = Record<string, Keyframe[]>;

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export type TransitionKind =
  | "fade"
  | "slideLeft"
  | "slideRight"
  | "slideUp"
  | "slideDown"
  | "wipeLeft"
  | "wipeRight"
  | "circleOpen"
  | "pixelate"
  | "blurDissolve"
  | "zoomBlur";

export interface Transition {
  kind: TransitionKind;
  /** Length of the blend in seconds. */
  duration: Seconds;
  easing: EasingName;
}

/* ------------------------------------------------------------------ *
 * Clip payloads — one variant per clip kind
 * ------------------------------------------------------------------ */

export type TextAlign = "left" | "center" | "right";

export interface TextGradient {
  enabled: boolean;
  from: Color;
  to: Color;
  /**
   * Optional midpoint stop, drawn between `from` and `to`.
   *
   * Untyped legacy projects simply do not have it, and an empty string means
   * "no midpoint", so the original two-stop ramp is what every existing
   * gradient still renders as. Templates use it for a soft-edged band
   * (transparent → colour → transparent) that a two-stop ramp cannot express.
   */
  mid?: Color;
  /** Where the midpoint stop sits, 0..1 along the ramp. */
  midOffset?: number;
  /** Degrees. 90 = left to right. */
  angle: number;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** CSS letter-spacing in em. */
  letterSpacing: number;
  /** Multiplier of font size. */
  lineHeight: number;
  align: TextAlign;
  /** Wrap width in project pixels; 0 disables wrapping. */
  maxWidth: number;
  color: Color;
  gradient: TextGradient;
  /** Outline. */
  strokeWidth: number;
  strokeColor: Color;
  /** Soft glow behind the glyphs. */
  glowBlur: number;
  glowColor: Color;
  italic: boolean;
  uppercase: boolean;
  /** Rounded backdrop plate drawn behind the text block. */
  background: {
    enabled: boolean;
    color: Color;
    paddingX: number;
    paddingY: number;
    radius: number;
  };
}

/** How the glyphs animate in, independent of the clip's keyframes. */
export type TextReveal =
  | "none"
  | "typewriter"
  | "wordRise"
  | "charPop"
  | "maskWipe"
  | "blurIn";

export interface TextClipProps {
  text: string;
  style: TextStyle;
  reveal: TextReveal;
  /** Reveal length in seconds, starting at the clip's in-point. */
  revealDuration: Seconds;
  /** Extra stagger between successive units during a reveal. */
  revealStagger: Seconds;
  /** Caret drawn while a typewriter reveal is running. */
  caret: boolean;
}

export type FitMode = "cover" | "contain" | "fill" | "none";

export interface MediaClipProps {
  assetId: string;
  fit: FitMode;
  /** Corner rounding in project pixels. */
  radius: number;
  /** object-position, 0..1, used when `fit` is cover/contain. */
  focusX: number;
  focusY: number;
  muted: boolean;
  /** 0..2 linear gain. */
  volume: number;
}

export type ShapeKind =
  | "rect"
  | "ellipse"
  | "triangle"
  | "line"
  | "star"
  | "arrow";

export interface ShapeClipProps {
  shape: ShapeKind;
  width: number;
  height: number;
  fill: Color;
  fillGradient: TextGradient;
  strokeWidth: number;
  strokeColor: Color;
  radius: number;
  /** Star/arrow geometry. */
  points: number;
  innerRadius: number;
}

/**
 * A browser/device frame with a screenshot inside — the workhorse of software
 * promo videos.
 */
export type DeviceKind = "browser" | "window" | "phone" | "tablet" | "bare";

export interface DeviceClipProps {
  device: DeviceKind;
  /** Screenshot or screen recording shown inside the frame. */
  assetId: string;
  fit: FitMode;
  width: number;
  height: number;
  /** Chrome colour of the frame. */
  frameColor: Color;
  /** Address-bar text; empty hides the bar for `browser`. */
  url: string;
  /** Draw a subtle 3D tilt. */
  tiltX: number;
  tiltY: number;
  /** Slack border around the screenshot inside the frame. */
  padding: number;
  radius: number;
  shadow: boolean;
  /**
   * 取景偏移：把截图在取景窗里往上推多少（`0..1`）。
   *
   * 用来做"长截图在窗口内从顶滚到底"——`fit: "cover"` 时截图通常比取景窗高，
   * 这个值就是**滚到底的比例**：0 = 顶对齐（默认），1 = 底对齐，中间是线性插值。
   * 渲染层会按"截图实际高度 − 取景窗高度"换算成像素，所以换一张图、换一种画幅，
   * 关键帧都不用改。
   */
  scroll?: number;
}

export interface BackgroundClipProps {
  /** Base colour, drawn beneath the gradient. */
  color: Color;
  gradient: TextGradient;
  /** Animated decorative layer. */
  pattern: "none" | "grid" | "dots" | "noise" | "rays" | "waves" | "pixelGrid";
  patternColor: Color;
  patternScale: number;
  /** Slow drift applied to the pattern, in px/s. */
  patternSpeed: number;
  /** Radial vignette strength, 0..1. */
  vignette: number;
  /** Brand glow blobs. */
  blobs: Array<{
    x: number;
    y: number;
    radius: number;
    color: Color;
    /** Orbit speed in degrees/second. */
    speed: number;
  }>;
}

export type ClipProps =
  | TextClipProps
  | MediaClipProps
  | ShapeClipProps
  | DeviceClipProps
  | BackgroundClipProps;

/* ------------------------------------------------------------------ *
 * Clips
 * ------------------------------------------------------------------ */

export interface ClipBase {
  id: string;
  name: string;
  /** Timeline position of the clip's in-point, in seconds. */
  start: Seconds;
  /** Visible length on the timeline, in seconds. */
  duration: Seconds;
  /** Offset into the source media at which the clip begins, in seconds. */
  trimIn: Seconds;
  /** Playback rate multiplier. 1 = real time. */
  speed: number;
  enabled: boolean;
  locked: boolean;
  opacity: number;
  blendMode: GlobalCompositeOperation;
  transform: Transform;
  filters: FilterState;
  animation: AnimationMap;
  transitionIn?: Transition;
  transitionOut?: Transition;
}

export interface TextClip extends ClipBase {
  kind: "text";
  props: TextClipProps;
}
export interface ImageClip extends ClipBase {
  kind: "image";
  props: MediaClipProps;
}
export interface VideoClip extends ClipBase {
  kind: "video";
  props: MediaClipProps;
}
export interface AudioClip extends ClipBase {
  kind: "audio";
  props: MediaClipProps;
}
export interface ShapeClip extends ClipBase {
  kind: "shape";
  props: ShapeClipProps;
}
export interface DeviceClip extends ClipBase {
  kind: "device";
  props: DeviceClipProps;
}
export interface BackgroundClip extends ClipBase {
  kind: "background";
  props: BackgroundClipProps;
}

export type VisualClip =
  | TextClip
  | ImageClip
  | VideoClip
  | ShapeClip
  | DeviceClip
  | BackgroundClip;

export type Clip = VisualClip | AudioClip;

export type ClipKind = Clip["kind"];

/** Clips that draw pixels; everything except audio. */
export const VISUAL_KINDS = [
  "text",
  "image",
  "video",
  "shape",
  "device",
  "background",
] as const satisfies readonly ClipKind[];

export function isVisualClip(clip: Clip): clip is VisualClip {
  return clip.kind !== "audio";
}

/* ------------------------------------------------------------------ *
 * Tracks, scenes, project
 * ------------------------------------------------------------------ */

export type TrackKind = "visual" | "audio";

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Bottom-to-top paint order is the array order: index 0 draws first. */
  clips: Clip[];
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}

export type AspectPreset = "16:9" | "9:16" | "1:1" | "4:5" | "21:9";

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  aspect: AspectPreset;
  /** Timeline length in seconds. Clips may extend it; export uses the max. */
  duration: Seconds;
  /** Colour behind every track. */
  background: Color;
}

export interface ThemeTokens {
  mode: "dark" | "light";
  accent: Color;
  accentDeep: Color;
  accentHover: Color;
  bg0: Color;
  bg1: Color;
  bg2: Color;
  text1: Color;
  text2: Color;
  text3: Color;
  /** Body/UI font stack. */
  font: string;
  /** Display font stack used for big promo headlines. */
  fontDisplay: string;
  /** Default corner radius in project pixels for generated surfaces. */
  radius: number;
}

/** A list entry's value: fixed fields, each a primitive or a nested list of them. */
export type SlotRecordValue = string | number | boolean | SlotRecordValue[];
/**
 * `SlotRecord` 的字段在运行时可以再嵌一个 `SlotRecord[]`（面板里套项列表就靠这），
 * 但类型上 `SlotRecordValue` 不含 `SlotRecord`——TypeScript 不允许两个类型别名互相
 * 递归。所以嵌套 list 的默认值用 `as unknown as SlotRecord[]` 断言，读取时
 * 由 `sRecRecords` 做运行时清洗。
 */
export type SlotRecord = Record<string, SlotRecordValue>;

/**
 * Template parameter values, keyed by `TemplateSlot.id`.
 *
 * `SlotRecord[]` backs repeatable sections (the "add a panel" lists): a template can
 * declare a list slot whose entries each carry their own text/image fields, and the
 * whole array round-trips through the project file as plain JSON.
 */
export type SlotValue = string | number | boolean | Color | string[] | SlotRecord[];

export interface Project {
  id: string;
  schemaVersion: number;
  name: string;
  settings: ProjectSettings;
  theme: ThemeTokens;
  assets: Asset[];
  tracks: Track[];
  /** Set when the project came from a template. */
  templateId?: string;
  /**
   * Parameter values for the originating template. Editing a slot re-applies
   * the template while preserving any clip the user has unlinked.
   */
  slots: Record<string, SlotValue>;
  /** Clip ids the user edited by hand and that a slot update must not clobber. */
  detachedClipIds: string[];
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ *
 * Selection & editing helpers
 * ------------------------------------------------------------------ */

export interface ClipRef {
  trackId: string;
  clipId: string;
}

export const DEFAULT_FILTERS: FilterState = {
  blur: 0,
  brightness: 1,
  contrast: 1,
  saturate: 1,
  grayscale: 0,
  hueRotate: 0,
  shadowBlur: 0,
  shadowX: 0,
  shadowY: 0,
  shadowColor: "rgba(0,0,0,0.45)",
};

export const IDENTITY_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  anchorX: 0.5,
  anchorY: 0.5,
};
