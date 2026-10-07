import { roundRectPath } from "../effects";
import { drawPlaceholder, fitRect } from "../types";
import type { DrawArgs, LayerBox, LayerDefinition, MeasureArgs } from "../types";

/**
 * Image and video layers.
 *
 * Both fill the project frame by default, so a clip can be used full-bleed as a
 * background or scaled down into a picture-in-picture purely through its
 * transform — one code path for both cases.
 */

function sourceSize(source: CanvasImageSource): { w: number; h: number } {
  const s = source as unknown as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number | { baseVal?: { value: number } };
    height?: number | { baseVal?: { value: number } };
  };
  const w = s.videoWidth || s.naturalWidth || (typeof s.width === "number" ? s.width : 0);
  const h = s.videoHeight || s.naturalHeight || (typeof s.height === "number" ? s.height : 0);
  return { w: w || 0, h: h || 0 };
}

function mediaBox(args: MeasureArgs): LayerBox {
  return { w: args.project.settings.width, h: args.project.settings.height };
}

function drawMedia(args: DrawArgs, isVideo: boolean): void {
  const { ctx, clip, box, sourceTime, media } = args;
  if (clip.kind !== "image" && clip.kind !== "video") return;
  const props = clip.props;
  const { w, h } = box;

  ctx.save();

  const hasAsset = !!props.assetId;
  const source = hasAsset
    ? isVideo
      ? media.getVideo(props.assetId, sourceTime)
      : media.getImage(props.assetId)
    : null;

  if (!source) {
    drawPlaceholder(ctx, w, h, hasAsset ? (isVideo ? "视频加载中…" : "图片加载中…") : "未指定素材");
    ctx.restore();
    return;
  }

  let { w: srcW, h: srcH } = sourceSize(source);
  if (!srcW || !srcH) {
    const known = media.getSize(props.assetId);
    if (known) {
      srcW = known.width;
      srcH = known.height;
    }
  }
  if (!srcW || !srcH) {
    srcW = w;
    srcH = h;
  }

  const rect = fitRect(srcW, srcH, w, h, props.fit, props.focusX, props.focusY);

  if (props.radius > 0) {
    roundRectPath(ctx, 0, 0, w, h, props.radius);
    ctx.clip();
  }

  try {
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h);
  } catch {
    // A video element can reject a draw while it is mid-seek; showing the
    // placeholder for one frame is better than aborting the whole render.
    drawPlaceholder(ctx, w, h, "视频解码中…");
  }

  ctx.restore();
}

export const imageLayer: LayerDefinition = {
  measure: mediaBox,
  draw: (args) => drawMedia(args, false),
};

export const videoLayer: LayerDefinition = {
  measure: mediaBox,
  draw: (args) => drawMedia(args, true),
};
