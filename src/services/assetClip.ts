import { createAudioClip, createImageClip, createVideoClip } from "../core/clips";
import type { Asset, Clip, TrackKind } from "../core/types";

/**
 * Turning a media-pool asset into a timeline clip.
 *
 * Shared by the media panel's "add" button, double-click, and dragging an asset
 * onto the timeline, so all three produce identical clips.
 */

/**
 * Default timeline length for a freshly placed asset.
 *
 * Follows the asset's own length. This used to be capped (video at 20s, audio at
 * 30s), which is why a dropped clip came in shorter than its file and the picture
 * and its audio were cut off at an arbitrary point — the duration probe was fine,
 * the cap was throwing the answer away. Trimming is the editor's job, not the
 * default's.
 */
export function defaultClipDuration(asset: Asset): number {
  if (asset.duration && asset.duration > 0) return asset.duration;
  // Only reached when the probe could not determine a length.
  if (asset.kind === "audio") return 10;
  if (asset.kind === "video") return 5;
  return 4;
}

/** Which kind of track may host this asset. */
export function trackKindForAsset(asset: Asset): TrackKind {
  return asset.kind === "audio" ? "audio" : "visual";
}

export function clipForAsset(asset: Asset, start: number, duration?: number): Clip {
  const length = duration ?? defaultClipDuration(asset);
  const common = { assetId: asset.id, name: asset.name, start, duration: length };

  switch (asset.kind) {
    case "audio":
      return createAudioClip({ ...common, props: { volume: 0.8, fit: "none" } });
    case "video":
      return createVideoClip({ ...common, props: { fit: "cover" } });
    default:
      return createImageClip({ ...common, props: { fit: "cover" } });
  }
}
