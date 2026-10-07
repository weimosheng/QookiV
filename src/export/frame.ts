import { mediaPool } from "../engine/sharedPool";
import { createRenderTarget, Renderer } from "../render/Renderer";
import type { Project, Seconds } from "../core/types";

/**
 * Single-frame still export.
 *
 * Runs through the same compositor and the same media pool as the preview and the
 * video exporter, so a saved frame is exactly what the timeline shows. `settle`
 * is awaited first, otherwise a video layer could be captured mid-seek.
 */

export interface FrameExportOptions {
  /** Output resolution multiplier; 1 keeps the project resolution. */
  scale?: number;
  type?: "image/png" | "image/jpeg";
  /** JPEG quality, 0..1. */
  quality?: number;
}

export async function renderFrameImage(
  project: Project,
  time: Seconds,
  options: FrameExportOptions = {},
): Promise<Blob | null> {
  await mediaPool.settle(project, time);

  const target = createRenderTarget(project);
  const ctx = target.getContext("2d");
  if (!ctx) return null;
  new Renderer(project, mediaPool).renderFrame(ctx, time, { quality: "export" });

  const scale = options.scale ?? 1;
  let source: HTMLCanvasElement = target;
  if (scale !== 1) {
    const scaled = document.createElement("canvas");
    scaled.width = Math.max(1, Math.round(target.width * scale));
    scaled.height = Math.max(1, Math.round(target.height * scale));
    const sctx = scaled.getContext("2d");
    if (!sctx) return null;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(target, 0, 0, scaled.width, scaled.height);
    source = scaled;
  }

  return new Promise<Blob | null>((resolve) => {
    source.toBlob(
      (blob) => resolve(blob),
      options.type ?? "image/png",
      options.quality ?? 0.92,
    );
  });
}
