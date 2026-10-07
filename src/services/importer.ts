import { newId } from "../core/ids";
import type { Asset, AssetKind } from "../core/types";
import { MEDIA_FILTERS, baseName, extensionOf, fileSize, isTauri, pickMediaFiles, stripExtension, toAssetUrl } from "./tauri";

/**
 * Media import.
 *
 * Assets are described by metadata the timeline needs (duration, intrinsic size,
 * frame rate) which is probed from a throwaway media element, so a clip can be
 * trimmed to the real length the moment it lands on a track.
 */

const VIDEO_EXT = ["mp4", "mov", "webm", "mkv", "m4v", "avi", "ogv"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "svg"];
const AUDIO_EXT = ["mp3", "wav", "aac", "m4a", "ogg", "flac", "opus"];

export function kindForPath(path: string): AssetKind | null {
  const ext = extensionOf(path);
  if (VIDEO_EXT.includes(ext)) return "video";
  if (IMAGE_EXT.includes(ext)) return "image";
  if (AUDIO_EXT.includes(ext)) return "audio";
  return null;
}

export const MEDIA_ACCEPT = MEDIA_FILTERS[0].extensions.map((e) => `.${e}`).join(",");

interface Probe {
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  fps?: number;
}

/**
 * Reads intrinsic media metadata by loading the source in a detached element.
 * Resolves with whatever could be determined before the timeout.
 */
function probe(url: string, kind: AssetKind, timeoutMs = 8000): Promise<Probe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Probe) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };
    const timer = window.setTimeout(() => done({}), timeoutMs);

    if (kind === "image") {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => done({});
      img.src = url;
      return;
    }

    if (kind === "audio") {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.onloadedmetadata = () =>
        done({ duration: Number.isFinite(audio.duration) ? audio.duration : undefined });
      audio.onerror = () => done({});
      audio.src = url;
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      done({
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
        width: video.videoWidth,
        height: video.videoHeight,
        hasAudio: detectAudioTrack(video),
      });
    video.onerror = () => done({});
    video.src = url;
  });
}

/**
 * Best-effort audio-track detection.
 *
 * `webkitAudioDecodedByteCount` only becomes meaningful after some decoding, so
 * a fresh metadata load cannot see it. Chromium exposes `audioTracks` behind a
 * flag, and `mozHasAudio` only in Firefox. When nothing is available we assume
 * audio is present, which is the safer default for a promo video: the mixer just
 * gets silence if the file has none.
 */
function detectAudioTrack(video: HTMLVideoElement): boolean {
  const legacy = video as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length: number };
  };
  if (typeof legacy.mozHasAudio === "boolean") return legacy.mozHasAudio;
  if (legacy.audioTracks && typeof legacy.audioTracks.length === "number") {
    return legacy.audioTracks.length > 0;
  }
  return true;
}

/**
 * Builds `Asset` records for a list of absolute paths.
 *
 * Unsupported extensions are skipped rather than producing broken clips.
 */
export async function importPaths(paths: string[]): Promise<Asset[]> {
  const assets: Asset[] = [];
  for (const path of paths) {
    const kind = kindForPath(path);
    if (!kind) continue;

    const url = await toAssetUrl(path);
    const meta = await probe(url, kind);
    const bytes = isTauri() ? await fileSize(path).catch(() => undefined) : undefined;

    assets.push({
      id: newId("asset"),
      kind,
      name: stripExtension(baseName(path)),
      src: url,
      path,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      hasAudio: kind === "video" ? meta.hasAudio : kind === "audio",
      fps: meta.fps,
      bytes,
      addedAt: Date.now(),
    });
  }
  return assets;
}

/** Opens the native picker and imports whatever the user selected. */
export async function pickAndImport(): Promise<Asset[]> {
  const paths = await pickMediaFiles();
  if (paths.length === 0) return [];
  return importPaths(paths);
}

/**
 * Imports files dropped onto the window. Tauri reports absolute paths, so the
 * assets keep a `path` and can be re-read (and copied) at export time.
 */
export async function importDroppedPaths(paths: string[]): Promise<Asset[]> {
  return importPaths(paths);
}

/** Registers an already-loaded object URL (used by the browser dev fallback). */
export function assetFromBrowserFile(file: File, url: string): Asset | null {
  const kind = kindForPath(file.name);
  if (!kind) return null;
  return {
    id: newId("asset"),
    kind,
    name: stripExtension(file.name),
    src: url,
    duration: undefined,
    bytes: file.size,
    addedAt: Date.now(),
  };
}
