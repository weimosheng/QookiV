import { useEffect, useRef, useSyncExternalStore } from "react";
import { findAsset } from "../../core/project";
import type { Clip } from "../../core/types";
import {
  clipMediaVersion,
  ensureWaveform,
  getThumbnailAt,
  getWaveform,
  requestThumbnail,
  subscribeClipMedia,
} from "../../engine/clipMedia";
import { thumbnailPool } from "../../engine/sharedPool";
import { useEditor } from "../../store/editorStore";

/**
 * The artwork layer inside a timeline clip: filmstrip, waveform and keyframe
 * markers.
 *
 * Drawn onto one canvas per clip rather than as DOM, because the waveform has to
 * be resampled to the clip's visible source window (trim point + speed) and a row
 * of elements would be far heavier than a single canvas.
 *
 * Canvas width is capped: at 600 px/s a long clip would otherwise allocate a
 * canvas thousands of pixels wide for a strip 28 px tall.
 */
const MAX_CANVAS_WIDTH = 2400;
/** Preferred on-screen width of one filmstrip frame. */
const TILE_TARGET_WIDTH = 72;
const MAX_TILES = 14;
/** 尺寸变化用的图形颜色（与普通关键帧的琥珀色区分开）。 */
const SIZE_MARKER_COLOR = "#6fb7e6";

/**
 * 尺寸类属性：这些时刻用"⇔"画，区别于普通关键帧的菱形。
 *
 * 手动"尺寸过渡"和模板里的宽高动画写的都是这两个路径，所以标记能覆盖两者。
 */
const SIZE_PATHS = new Set(["props.width", "props.height"]);

export type KeyframeMarker = { time: number; kind: "size" | "other" };

/**
 * 一个片段上所有需要标记的关键帧时刻，按时间排序。
 *
 * 抽成纯函数是为了两件事能共用同一份判断：画布怎么画、以及"这块片段要不要挂那层画布"。
 * **片段的种类不参与判断**——矩形/色块（`shape`）没有胶片条也没有波形，但它完全可能有
 * 关键帧；曾经因为只给 image/video/audio/device 挂画布，形状上的尺寸过渡一个标记都看不见。
 */
export function keyframeMarkers(clip: Clip): KeyframeMarker[] {
  const byTime = new Map<number, KeyframeMarker>();
  for (const [path, frames] of Object.entries(clip.animation)) {
    for (const frame of frames) {
      const kind: KeyframeMarker["kind"] = SIZE_PATHS.has(path) ? "size" : "other";
      const existing = byTime.get(frame.time);
      // 同一时刻既有尺寸又有别的动效时，画菱形（普通关键帧信息更少、更常见）。
      if (!existing || existing.kind === "size") byTime.set(frame.time, { time: frame.time, kind });
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** 这个片段是否需要那层画布（胶片条 / 波形 / 关键帧标记）。 */
export function shouldShowArtwork(clip: Clip): boolean {
  const hasMedia =
    clip.kind === "image" ||
    clip.kind === "video" ||
    clip.kind === "audio" ||
    clip.kind === "device";
  return hasMedia || keyframeMarkers(clip).length > 0;
}

export function ClipArtwork({
  clip,
  width,
  height,
  color,
}: {
  clip: Clip;
  width: number;
  height: number;
  color: string;
}) {
  // Subscribe so the strip repaints as frames and waveforms arrive.
  useSyncExternalStore(subscribeClipMedia, clipMediaVersion);

  const project = useEditor((s) => s.project);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const assetId =
    clip.kind === "image" || clip.kind === "video" || clip.kind === "audio"
      ? clip.props.assetId
      : "";
  const asset = findAsset(project, assetId);
  const sourceDuration = asset?.duration && asset.duration > 0 ? asset.duration : 0;

  // Kick off (and retry) the asynchronous work.
  useEffect(() => {
    if (!asset) return;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;

    const attempt = () => {
      if (cancelled) return;
      if (asset.kind === "audio") void ensureWaveform(asset);

      // Ask for the strip one frame at a time; anything still missing returns
      // false and we come back in a moment rather than blocking the render.
      //
      // **必须用 `thumbnailPool`**（画廊也用它），不能用预览那个池：抽帧是靠 seek 同一个
      // video 元素实现的。用预览的池时，一暂停抽帧队列就结束等待、开始 seek 预览正在显示
      // 的元素，预览又把它拽回播放头，两边打架——暂停那一帧被拽去画胶片，再按播放时元素
      // 还在 seek 中途，于是"暂停/起播卡一下"。
      let ready = true;
      if (asset.kind !== "audio") {
        const tiles = tileCount(width);
        for (let i = 0; i < tiles; i += 1) {
          const ok = requestThumbnail(asset, thumbnailPool, tileSourceTime(clip, i, tiles));
          if (!ok) ready = false;
        }
      }

      if (!ready && attempts < 40) {
        attempts += 1;
        timer = window.setTimeout(attempt, 300);
      }
    };

    attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [asset, clip, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cw = Math.max(1, Math.min(Math.round(width), MAX_CANVAS_WIDTH));
    const ch = Math.max(1, Math.round(height));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.filter = "none";
    ctx.globalAlpha = 1;

    // ---- filmstrip ----------------------------------------------------
    if (asset && (asset.kind === "image" || asset.kind === "video")) {
      const tiles = tileCount(width);
      const tileWidth = cw / tiles;
      for (let i = 0; i < tiles; i += 1) {
        const frame = getThumbnailAt(asset, tileSourceTime(clip, i, tiles));
        const x = i * tileWidth;
        if (frame) {
          // Crop to fill the tile, keeping the source aspect ratio.
          const scale = Math.max(tileWidth / frame.width, ch / frame.height);
          const dw = frame.width * scale;
          const dh = frame.height * scale;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, 0, tileWidth, ch);
          ctx.clip();
          ctx.globalAlpha = 0.92;
          ctx.drawImage(frame, x + (tileWidth - dw) / 2, (ch - dh) / 2, dw, dh);
          ctx.restore();
        }
        // A hairline between frames reads as a strip rather than a smear.
        if (i > 0) {
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.fillRect(x, 0, 1, ch);
        }
      }

      // Blend the stills into the clip colour so they read as a strip.
      const fade = ctx.createLinearGradient(cw * 0.55, 0, cw, 0);
      fade.addColorStop(0, withAlpha(color, 0));
      fade.addColorStop(1, withAlpha(color, 0.7));
      ctx.fillStyle = fade;
      ctx.fillRect(cw * 0.55, 0, cw * 0.45, ch);
    }

    // ---- waveform -----------------------------------------------------
    const peaks = assetId ? getWaveform(assetId) : undefined;
    if (peaks && peaks.length > 0 && sourceDuration > 0) {
      const from = clip.trimIn / sourceDuration;
      const to = (clip.trimIn + clip.duration * clip.speed) / sourceDuration;
      const mid = ch / 2;
      const amplitude = Math.max(1, ch / 2 - 2);

      ctx.beginPath();
      for (let x = 0; x < cw; x += 1) {
        const fraction = from + (x / cw) * (to - from);
        const index = Math.max(0, Math.min(peaks.length - 1, Math.floor(fraction * peaks.length)));
        const value = peaks[index] * amplitude;
        ctx.moveTo(x + 0.5, mid - value);
        ctx.lineTo(x + 0.5, mid + value);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // A faint centre line keeps a silent passage legible.
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(cw, mid + 0.5);
      ctx.stroke();
    }

    // ---- keyframe markers ---------------------------------------------
    const markers = keyframeMarkers(clip);
    if (markers.length > 0 && clip.duration > 0) {
      // Sits inside the grab strip rendered by ClipView, so what is drawn and
      // what can be dragged are the same thing.
      const y = ch - 6;
      const radius = 4.5;
      for (const marker of markers) {
        /*
         * 贴边的关键帧必须**夹进画布**而不是跳过：在片段起点做尺寸过渡是最常见的用法，
         * 而 x≈0 会被 `x < 2` 那条判断吃掉，于是"明明有关键帧却看不到标记"。
         */
        const raw = (marker.time / clip.duration) * cw;
        const x = Math.max(radius + 1, Math.min(cw - radius - 1, raw));
        ctx.beginPath();
        if (marker.kind === "size") {
          // 尺寸变化画成"⇔"（两个相背的三角），和普通关键帧的菱形区分开。
          ctx.moveTo(x - 1, y - radius);
          ctx.lineTo(x - 1, y + radius);
          ctx.lineTo(x - radius - 1, y);
          ctx.closePath();
          ctx.moveTo(x + 1, y - radius);
          ctx.lineTo(x + 1, y + radius);
          ctx.lineTo(x + radius + 1, y);
          ctx.closePath();
          ctx.fillStyle = SIZE_MARKER_COLOR;
        } else {
          ctx.moveTo(x, y - radius);
          ctx.lineTo(x + radius, y);
          ctx.lineTo(x, y + radius);
          ctx.lineTo(x - radius, y);
          ctx.closePath();
          ctx.fillStyle = "#e8b84b";
        }
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }, [clip, width, height, color, asset, assetId, sourceDuration]);

  return (
    <canvas
      ref={canvasRef}
      className="qv-clip__art"
      style={{ width: "100%", height: "100%" }}
      aria-hidden
    />
  );
}

/** Exported for the smoke test. */
export function tileCount(clipPixelWidth: number): number {
  if (!Number.isFinite(clipPixelWidth) || clipPixelWidth <= 0) return 1;
  return Math.max(1, Math.min(MAX_TILES, Math.floor(clipPixelWidth / TILE_TARGET_WIDTH)));
}

/**
 * Source time for tile `index`.
 *
 * Sampled at tile centres so a short clip does not show its in-point twice, and
 * clamped inside the clip's own source range.
 */
export function tileSourceTime(clip: Clip, index: number, tiles: number): number {
  const span = clip.duration * clip.speed;
  const fraction = (index + 0.5) / Math.max(1, tiles);
  return Math.max(0, clip.trimIn + span * fraction);
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
