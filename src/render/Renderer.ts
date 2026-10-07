import { paintOrderTracks } from "../core/project";
import type { Project, Seconds } from "../core/types";
import { filterString } from "./effects";
import { getLayer } from "./layers";
import { collectPlacements } from "./scene";
import type { LayerPlacement } from "./scene";
import type { MediaProvider, RenderQuality } from "./types";

/**
 * Deterministic scene compositor.
 *
 * `renderFrame(ctx, t)` is a pure function of the project and `t`: no internal
 * clock, no accumulated state. The live preview scrubs with it and the offline
 * exporter walks frames with it, which is the only reason "what you see" and
 * "what you get" can be guaranteed to match.
 *
 * It returns the placements it drew so the preview's drag handles can reuse the
 * exact same geometry rather than recomputing an approximation of it.
 */

export interface RenderFrameOptions {
  quality?: RenderQuality;
  /** Skip the project background fill (used when compositing onto a buffer). */
  skipClear?: boolean;
}

/** Recycles scratch canvases so scrubbing does not thrash the GC. */
class CanvasPool {
  private free: HTMLCanvasElement[] = [];

  acquire(w: number, h: number): HTMLCanvasElement {
    const idx = this.free.findIndex((c) => c.width === w && c.height === h);
    if (idx >= 0) {
      const c = this.free[idx];
      this.free.splice(idx, 1);
      return c;
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  release(canvas: HTMLCanvasElement): void {
    if (this.free.length < 6) this.free.push(canvas);
  }
}

function composeFilter(base: string, extraBlur: number): string {
  if (extraBlur <= 0) return base;
  const blur = `blur(${Math.round(extraBlur * 100) / 100}px)`;
  return base === "none" ? blur : `${base} ${blur}`;
}

export class Renderer {
  private pool = new CanvasPool();

  constructor(
    private project: Project,
    private media: MediaProvider,
  ) {}

  setProject(project: Project): void {
    this.project = project;
  }

  setMedia(media: MediaProvider): void {
    this.media = media;
  }

  get size(): { width: number; height: number } {
    return { width: this.project.settings.width, height: this.project.settings.height };
  }

  /**
   * Draws the whole scene at `time` seconds onto `ctx`.
   *
   * Returns the placements it drew, in paint order. The preview reuses them for
   * direct manipulation, so the selection outline is derived from exactly the
   * geometry that produced the pixels.
   */
  renderFrame(
    ctx: CanvasRenderingContext2D,
    time: Seconds,
    options: RenderFrameOptions = {},
  ): LayerPlacement[] {
    const project = this.project;
    const { width, height } = project.settings;
    const quality = options.quality ?? "preview";

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    if (!options.skipClear) {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = project.settings.background;
      ctx.fillRect(0, 0, width, height);
    }

    const placements = this.placements(ctx, time, quality);
    for (const placement of placements) {
      this.drawPlacement(ctx, placement, quality);
    }

    ctx.restore();
    return placements;
  }

  /** Collects the visible layers without drawing them. */
  placements(
    ctx: CanvasRenderingContext2D,
    time: Seconds,
    quality: RenderQuality = "preview",
  ): LayerPlacement[] {
    return collectPlacements(ctx, this.project, this.media, time, quality);
  }

  /** Renders one already-measured clip. */
  private drawPlacement(
    ctx: CanvasRenderingContext2D,
    placement: LayerPlacement,
    quality: RenderQuality,
  ): void {
    const clip = placement.clip;
    const layer = getLayer(clip.kind);
    if (!layer) return;

    const project = this.project;
    const box = placement.box;
    const ts = placement.transition;

    // ---- pixelate needs an isolation buffer -----------------------------
    if (ts.pixelate > 1) {
      this.drawPixelated(ctx, placement, quality);
      return;
    }

    const t = clip.transform;

    // Project-space reveal window, applied before the layer transform.
    ctx.save();
    if (ts.clipRect) {
      const r = ts.clipRect;
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
    }
    if (ts.circle) {
      ctx.beginPath();
      ctx.arc(ts.circle.cx, ts.circle.cy, Math.max(0, ts.circle.r), 0, Math.PI * 2);
      ctx.clip();
    }

    ctx.globalAlpha = Math.max(0, Math.min(1, clip.opacity * ts.alpha));
    ctx.globalCompositeOperation = clip.blendMode || "source-over";
    ctx.filter = composeFilter(filterString(clip.filters), ts.blur);

    if (clip.filters.shadowBlur > 0) {
      ctx.shadowColor = clip.filters.shadowColor;
      ctx.shadowBlur = clip.filters.shadowBlur;
      ctx.shadowOffsetX = clip.filters.shadowX;
      ctx.shadowOffsetY = clip.filters.shadowY;
    }

    ctx.translate(placement.originX, placement.originY);
    if (t.rotation !== 0) ctx.rotate(placement.rotation);
    const scale = placement.scale;
    if (scale !== 1) ctx.scale(scale, scale);
    ctx.translate(-box.w * t.anchorX, -box.h * t.anchorY);

    layer.draw({
      ctx,
      clip,
      project,
      time: clip.start + placement.localTime,
      localTime: placement.localTime,
      sourceTime: placement.sourceTime,
      box,
      media: this.media,
      quality,
    });

    ctx.restore();
  }

  /** Downsamples the layer to a coarse grid and scales it back up. */
  private drawPixelated(
    ctx: CanvasRenderingContext2D,
    placement: LayerPlacement,
    quality: RenderQuality,
  ): void {
    const { width, height } = this.project.settings;
    const cell = placement.transition.pixelate;

    const full = this.pool.acquire(width, height);
    const fctx = full.getContext("2d");
    if (!fctx) return;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, width, height);
    // Re-draw the same placement with the mosaic switched off, so everything
    // else about the layer (transform, filters, alpha) stays identical.
    this.drawPlacement(
      fctx,
      { ...placement, transition: { ...placement.transition, pixelate: 0 } },
      quality,
    );

    const sw = Math.max(1, Math.ceil(width / cell));
    const sh = Math.max(1, Math.ceil(height / cell));
    const small = this.pool.acquire(sw, sh);
    const sctx = small.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, sw, sh);
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(full, 0, 0, sw, sh);

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, placement.clip.opacity * placement.transition.alpha));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, sw, sh, 0, 0, width, height);
    ctx.restore();

    this.pool.release(full);
    this.pool.release(small);
  }

  /**
   * Ids of assets whose media is not ready at `time`, so the preview can show a
   * "buffering" hint instead of flickering.
   */
  pendingAssets(time: Seconds): string[] {
    const pending: string[] = [];
    for (const track of paintOrderTracks(this.project)) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        const local = time - clip.start;
        if (local < 0 || local >= clip.duration) continue;
        const assetId =
          clip.kind === "video" || clip.kind === "image"
            ? clip.props.assetId
            : clip.kind === "device"
              ? clip.props.assetId
              : "";
        if (assetId && !this.media.isReady(assetId)) pending.push(assetId);
      }
    }
    return pending;
  }
}

/** Creates a canvas sized to the project, ready to be rendered into. */
export function createRenderTarget(project: Project): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = project.settings.width;
  canvas.height = project.settings.height;
  return canvas;
}

/** One-shot convenience used by thumbnails and template previews. */
export function renderToCanvas(
  project: Project,
  media: MediaProvider,
  time: Seconds,
  canvas?: HTMLCanvasElement,
): HTMLCanvasElement {
  const target = canvas ?? createRenderTarget(project);
  if (target.width !== project.settings.width || target.height !== project.settings.height) {
    target.width = project.settings.width;
    target.height = project.settings.height;
  }
  const ctx = target.getContext("2d");
  if (ctx) new Renderer(project, media).renderFrame(ctx, time, { quality: "preview" });
  return target;
}
