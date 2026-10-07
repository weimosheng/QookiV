import type { Asset, Project, Track } from "../../core/types";
import { defaultClipDuration, trackKindForAsset } from "../../services/assetClip";
import type { DropHint } from "../../store/editorStore";
import { HEADER_W } from "./geometry";

/**
 * Resolving where a dragged asset would be dropped.
 *
 * Pointer-based rather than HTML5 drag-and-drop: Tauri's native file-drop handler
 * can swallow HTML5 drag events on Windows, and a pointer drag also gives better
 * feedback (a live insertion line plus a preview of the clip's length).
 */

/** The lane element under a screen point, if any. */
function laneAt(clientX: number, clientY: number): HTMLElement | null {
  const el = document.elementFromPoint(clientX, clientY);
  if (!(el instanceof Element)) return null;
  const lane = el.closest("[data-track-id]");
  return lane instanceof HTMLElement ? lane : null;
}

/**
 * Where an asset would land for a given pointer position, or null.
 *
 * Dropping an audio asset on a visual track (or vice versa) is rerouted to the
 * first compatible track rather than refused, which is what a mature NLE does.
 */
export function resolveDropTarget(
  clientX: number,
  clientY: number,
  project: Project,
  zoom: number,
  asset: Asset,
): DropHint | null {
  const lane = laneAt(clientX, clientY);
  if (!lane) return null;

  const destination = trackForAsset(project, asset, lane.dataset.trackId ?? "");
  if (!destination) return null;

  // Every lane shares the same horizontal origin and scale, so the hovered lane's
  // rectangle gives the right time even when the drop is rerouted to another
  // track, and it stays correct however far the timeline is scrolled.
  const rect = lane.getBoundingClientRect();
  const fps = Math.max(1, project.settings.fps);
  const raw = Math.max(0, (clientX - rect.left) / zoom);
  // Snap the insertion to the frame grid so a drop lands on a real frame.
  const time = Math.round(raw * fps) / fps;

  return {
    trackId: destination.id,
    time,
    duration: defaultClipDuration(asset),
  };
}

/**
 * The track an asset may be dropped on: the one under the pointer when its kind
 * matches, otherwise the first compatible unlocked track.
 *
 * Split out of `resolveDropTarget` so the native file drop (which resolves a
 * *list* of assets from one pointer position) can reuse exactly the same rule —
 * dropping a video and an mp3 together has to route each one to its own kind of
 * track.
 */
export function trackForAsset(
  project: Project,
  asset: Asset,
  preferredTrackId: string,
): Track | null {
  const wanted = trackKindForAsset(asset);
  const preferred = project.tracks.find((t) => t.id === preferredTrackId);
  if (preferred && preferred.kind === wanted && !preferred.locked) return preferred;
  return project.tracks.find((t) => t.kind === wanted && !t.locked && !t.hidden) ?? null;
}

/** One placement produced by `sequenceDrops`. */
export interface SequencedDrop {
  asset: Asset;
  trackId: string;
  start: number;
  duration: number;
}

/**
 * 一次拖入多个文件时的落位：第一个落在指针处，其余依次排在它后面。
 *
 * 每个素材各自按类型找轨道（视频/图片去图层轨，音频去音频轨），所以一次混着拖
 * 视频和音乐也能各归各位；找不到可用轨道的素材会被跳过，而不是硬塞。
 */
export function sequenceDrops(project: Project, hint: DropHint, assets: Asset[]): SequencedDrop[] {
  const out: SequencedDrop[] = [];
  let cursor = hint.time;
  for (const asset of assets) {
    const track = trackForAsset(project, asset, hint.trackId);
    if (!track) continue;
    const duration = defaultClipDuration(asset);
    out.push({ asset, trackId: track.id, start: cursor, duration });
    cursor += duration;
  }
  return out;
}

/** Grid x for a time, used to place the insertion indicator. */
export function timeToGridX(time: number, zoom: number): number {
  return HEADER_W + time * zoom;
}
