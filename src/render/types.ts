import type { Project, Seconds, VisualClip } from "../core/types";

/**
 * The renderer's contracts.
 *
 * `MediaProvider` is the single seam between the compositor and decoded media,
 * so the live preview (seek-driven video elements) and the exporter (also
 * seek-driven, but frame-locked) can share every layer renderer unchanged.
 */

export type RenderQuality = "preview" | "export";

export interface MediaProvider {
  /** A decoded still image, or null while loading. */
  getImage(assetId: string): CanvasImageSource | null;
  /**
   * A decoded video frame for the given source time. Implementations are
   * expected to have already seeked the element to a frame boundary.
   */
  getVideo(assetId: string, sourceTime: Seconds): CanvasImageSource | null;
  /** Intrinsic size of an asset, when known. */
  getSize(assetId: string): { width: number; height: number } | null;
  /** False while a frame for this asset is still being decoded. */
  isReady(assetId: string): boolean;
}

/** Intrinsic layer size, before the clip transform is applied. */
export interface LayerBox {
  w: number;
  h: number;
}

export interface MeasureArgs {
  ctx: CanvasRenderingContext2D;
  clip: VisualClip;
  project: Project;
  localTime: Seconds;
  media: MediaProvider;
  quality: RenderQuality;
}

export interface DrawArgs {
  ctx: CanvasRenderingContext2D;
  clip: VisualClip;
  project: Project;
  /** Timeline time being rendered, in seconds. */
  time: Seconds;
  /** Time relative to the clip's in-point, in seconds. */
  localTime: Seconds;
  /** Time within the source media, in seconds. */
  sourceTime: Seconds;
  /** Intrinsic layer size; drawing happens in the rect (0,0,box.w,box.h). */
  box: LayerBox;
  media: MediaProvider;
  quality: RenderQuality;
}

export interface LayerDefinition {
  /** Intrinsic size of the layer, used to place and transform it. */
  measure(args: MeasureArgs): LayerBox;
  /** Paints the layer into the rect (0,0,box.w,box.h) of the current transform. */
  draw(args: DrawArgs): void;
}

/** Fits a source rect into a destination box according to `fit`. */
export function fitRect(
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  fit: "cover" | "contain" | "fill" | "none",
  focusX = 0.5,
  focusY = 0.5,
): { x: number; y: number; w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: dstW, h: dstH };

  if (fit === "fill") return { x: 0, y: 0, w: dstW, h: dstH };

  if (fit === "none") {
    return {
      x: (dstW - srcW) * focusX,
      y: (dstH - srcH) * focusY,
      w: srcW,
      h: srcH,
    };
  }

  const scale =
    fit === "cover" ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (dstW - w) * focusX, y: (dstH - h) * focusY, w, h };
}

/** Draws a "missing media" placeholder; also used for unloaded previews. */
export function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  label: string,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(128,128,144,0.14)";
  ctx.fillRect(0, 0, w, h);
  ctx.setLineDash([18, 14]);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(160,160,180,0.55)";
  ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(210,210,224,0.8)";
  ctx.font = `600 ${Math.max(18, Math.min(w, h) / 14)}px "Segoe UI", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, w / 2, h / 2);
  ctx.restore();
}
