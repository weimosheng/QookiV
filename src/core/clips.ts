import { QOOKIX_PRESENTATION } from "./theme";
import { newId } from "./ids";
import type {
  AudioClip,
  BackgroundClip,
  BackgroundClipProps,
  Clip,
  ClipKind,
  DeviceClip,
  DeviceClipProps,
  ImageClip,
  MediaClipProps,
  ShapeClip,
  ShapeClipProps,
  TextClip,
  TextClipProps,
  TextStyle,
  ThemeTokens,
  Transform,
  VideoClip,
} from "./types";
import { DEFAULT_FILTERS, IDENTITY_TRANSFORM } from "./types";

/* ------------------------------------------------------------------ *
 * Shared clip scaffolding
 * ------------------------------------------------------------------ */

export interface ClipInit {
  start?: number;
  duration?: number;
  name?: string;
  theme?: ThemeTokens;
}

function baseFields(init: ClipInit, fallbackName: string) {
  return {
    id: newId("clip"),
    name: init.name ?? fallbackName,
    start: init.start ?? 0,
    duration: init.duration ?? 3,
    trimIn: 0,
    speed: 1,
    enabled: true,
    locked: false,
    opacity: 1,
    blendMode: "source-over" as GlobalCompositeOperation,
    transform: { ...IDENTITY_TRANSFORM } as Transform,
    filters: { ...DEFAULT_FILTERS },
    animation: {},
  };
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

export type TextVariant = "hero" | "title" | "subtitle" | "body" | "caption" | "badge";

const TEXT_VARIANTS: Record<TextVariant, Partial<TextStyle>> = {
  hero: { fontSize: 148, fontWeight: 800, lineHeight: 1.08, letterSpacing: -0.01 },
  title: { fontSize: 96, fontWeight: 700, lineHeight: 1.16, letterSpacing: -0.005 },
  subtitle: { fontSize: 52, fontWeight: 500, lineHeight: 1.35, letterSpacing: 0 },
  body: { fontSize: 36, fontWeight: 400, lineHeight: 1.55, letterSpacing: 0 },
  caption: { fontSize: 28, fontWeight: 400, lineHeight: 1.5, letterSpacing: 0.01 },
  badge: { fontSize: 26, fontWeight: 600, lineHeight: 1.2, letterSpacing: 0.08 },
};

export function defaultTextStyle(
  theme: ThemeTokens = QOOKIX_PRESENTATION,
  variant: TextVariant = "title",
): TextStyle {
  return {
    fontFamily: theme.fontDisplay,
    fontSize: 96,
    fontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1.16,
    align: "center",
    maxWidth: 1400,
    color: theme.text1,
    gradient: { enabled: false, from: theme.accent, to: theme.accentDeep, angle: 90 },
    strokeWidth: 0,
    strokeColor: theme.bg0,
    glowBlur: 0,
    glowColor: theme.accent,
    italic: false,
    uppercase: false,
    background: {
      enabled: false,
      color: "rgba(0,0,0,0.35)",
      paddingX: 32,
      paddingY: 18,
      radius: 16,
    },
    ...TEXT_VARIANTS[variant],
  };
}

export function createTextClip(
  init: ClipInit & { text?: string; variant?: TextVariant; style?: Partial<TextStyle> } = {},
): TextClip {
  const theme = init.theme ?? QOOKIX_PRESENTATION;
  const style = defaultTextStyle(theme, init.variant ?? "title");
  const props: TextClipProps = {
    text: init.text ?? "在此输入文案",
    style: { ...style, ...init.style },
    reveal: "none",
    revealDuration: 0.8,
    revealStagger: 0.04,
    caret: false,
  };
  return {
    ...baseFields(init, props.text.slice(0, 12) || "文字"),
    kind: "text",
    props,
  };
}

/* ------------------------------------------------------------------ *
 * Media (image / video / audio)
 * ------------------------------------------------------------------ */

export function defaultMediaProps(assetId: string): MediaClipProps {
  return {
    assetId,
    fit: "cover",
    radius: 0,
    focusX: 0.5,
    focusY: 0.5,
    muted: false,
    volume: 1,
  };
}

export function createImageClip(
  init: ClipInit & { assetId: string; props?: Partial<MediaClipProps> } = { assetId: "" },
): ImageClip {
  return {
    ...baseFields(init, init.name ?? "图片"),
    kind: "image",
    duration: init.duration ?? 3,
    props: { ...defaultMediaProps(init.assetId), ...init.props },
  };
}

export function createVideoClip(
  init: ClipInit & { assetId: string; props?: Partial<MediaClipProps> } = { assetId: "" },
): VideoClip {
  return {
    ...baseFields(init, init.name ?? "视频"),
    kind: "video",
    duration: init.duration ?? 5,
    props: { ...defaultMediaProps(init.assetId), ...init.props },
  };
}

export function createAudioClip(
  init: ClipInit & { assetId: string; props?: Partial<MediaClipProps> } = { assetId: "" },
): AudioClip {
  return {
    ...baseFields(init, init.name ?? "音频"),
    kind: "audio",
    duration: init.duration ?? 10,
    props: { ...defaultMediaProps(init.assetId), fit: "none", ...init.props },
  };
}

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

export function createShapeClip(
  init: ClipInit & { props?: Partial<ShapeClipProps> } = {},
): ShapeClip {
  const theme = init.theme ?? QOOKIX_PRESENTATION;
  const props: ShapeClipProps = {
    shape: "rect",
    width: 480,
    height: 320,
    fill: theme.accent,
    fillGradient: { enabled: false, from: theme.accent, to: theme.accentDeep, angle: 135 },
    strokeWidth: 0,
    strokeColor: theme.text1,
    radius: 24,
    points: 5,
    innerRadius: 0.45,
    ...init.props,
  };
  return {
    ...baseFields(init, init.name ?? "形状"),
    kind: "shape",
    props,
  };
}

/* ------------------------------------------------------------------ *
 * Device / browser mock
 * ------------------------------------------------------------------ */

export function createDeviceClip(
  init: ClipInit & { assetId?: string; props?: Partial<DeviceClipProps> } = {},
): DeviceClip {
  const theme = init.theme ?? QOOKIX_PRESENTATION;
  const props: DeviceClipProps = {
    device: "browser",
    assetId: init.assetId ?? "",
    fit: "cover",
    width: 1200,
    height: 720,
    frameColor: theme.mode === "dark" ? "#1b2028" : "#e8eaef",
    url: "qookix.local",
    tiltX: 0,
    tiltY: 0,
    padding: 0,
    radius: 14,
    shadow: true,
    scroll: 0,
    ...init.props,
  };
  return {
    ...baseFields(init, init.name ?? "设备演示"),
    kind: "device",
    props,
  };
}

/* ------------------------------------------------------------------ *
 * Background
 * ------------------------------------------------------------------ */

export function createBackgroundClip(
  init: ClipInit & { props?: Partial<BackgroundClipProps> } = {},
): BackgroundClip {
  const theme = init.theme ?? QOOKIX_PRESENTATION;
  const props: BackgroundClipProps = {
    color: theme.bg0,
    gradient: { enabled: true, from: theme.bg1, to: theme.bg0, angle: 135 },
    pattern: "grid",
    patternColor: "rgba(232,154,75,0.10)",
    patternScale: 64,
    patternSpeed: 12,
    vignette: 0.35,
    blobs: [
      { x: 0.22, y: 0.28, radius: 520, color: "rgba(232,154,75,0.30)", speed: 4 },
      { x: 0.78, y: 0.72, radius: 460, color: "rgba(217,127,51,0.22)", speed: -3 },
    ],
    ...init.props,
  };
  return {
    ...baseFields({ duration: 6, ...init }, init.name ?? "背景"),
    kind: "background",
    props,
  };
}

/* ------------------------------------------------------------------ *
 * Generic factory
 * ------------------------------------------------------------------ */

/** Builds a clip of any kind with defaults, used by the toolbar and templates. */
export function createClipOfKind(
  kind: ClipKind,
  init: ClipInit & {
    assetId?: string;
    text?: string;
    variant?: TextVariant;
    props?: Record<string, unknown>;
  } = {},
): Clip {
  switch (kind) {
    case "text":
      return createTextClip({
        ...init,
        text: init.text,
        variant: init.variant,
        style: init.props as Partial<TextStyle> | undefined,
      });
    case "image":
      return createImageClip({
        ...init,
        assetId: init.assetId ?? "",
        props: init.props as Partial<MediaClipProps> | undefined,
      });
    case "video":
      return createVideoClip({
        ...init,
        assetId: init.assetId ?? "",
        props: init.props as Partial<MediaClipProps> | undefined,
      });
    case "audio":
      return createAudioClip({
        ...init,
        assetId: init.assetId ?? "",
        props: init.props as Partial<MediaClipProps> | undefined,
      });
    case "shape":
      return createShapeClip({ ...init, props: init.props as Partial<ShapeClipProps> | undefined });
    case "device":
      return createDeviceClip({
        ...init,
        assetId: init.assetId,
        props: init.props as Partial<DeviceClipProps> | undefined,
      });
    case "background":
      return createBackgroundClip({
        ...init,
        props: init.props as Partial<BackgroundClipProps> | undefined,
      });
  }
}

export const CLIP_KIND_LABELS: Record<ClipKind, string> = {
  text: "文字",
  image: "图片",
  video: "视频",
  shape: "形状",
  device: "界面演示",
  background: "背景",
  audio: "音频",
};
