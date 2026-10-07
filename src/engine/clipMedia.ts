import type { Asset } from "../core/types";
import { playback } from "./PlaybackEngine";
import type { MediaPool } from "./MediaPool";

/**
 * Waveform peaks and filmstrip thumbnails for the timeline.
 *
 * Both are derived once per asset and cached, then shared by every clip that
 * references them. A tiny subscription lets the timeline repaint when data
 * arrives asynchronously — decoding audio and seeking video are both far too slow
 * to do during a render.
 */

const WAVEFORM_BUCKETS = 4096;
const THUMBNAIL_HEIGHT = 96;
/** Upper bound on cached frames; keeps a long project from growing unbounded. */
const MAX_THUMBNAILS = 320;
/** How many source frames a single asset is sampled at across its whole length. */
const THUMBNAILS_PER_ASSET = 60;
/** Seek attempts per frame before giving up on it. */
const MAX_THUMB_ATTEMPTS = 3;

const waveforms = new Map<string, Float32Array>();
const thumbnails = new Map<string, HTMLCanvasElement>();
const waveformPending = new Set<string>();
const thumbAttempts = new Map<string, number>();
const failed = new Set<string>();

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function subscribeClipMedia(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for `useSyncExternalStore`: changes whenever cached art changes. */
export function clipMediaVersion(): number {
  return version;
}

export function getWaveform(assetId: string): Float32Array | undefined {
  return waveforms.get(assetId);
}

/* ------------------------------------------------------------------ *
 * Peaks
 * ------------------------------------------------------------------ */

/**
 * Normalised peak envelope from raw channel data.
 *
 * Pure, so the maths can be asserted without an audio context. The result is
 * scaled so the loudest bucket is 1, which keeps quiet music visible.
 */
export function peaksFromChannels(channels: Float32Array[], buckets: number): Float32Array {
  const out = new Float32Array(Math.max(1, buckets));
  if (channels.length === 0 || channels[0].length === 0) return out;

  const length = channels[0].length;
  const per = Math.max(1, Math.floor(length / out.length));
  let loudest = 1e-6;

  for (let bucket = 0; bucket < out.length; bucket += 1) {
    const start = bucket * per;
    const end = Math.min(length, start + per);
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      for (const channel of channels) {
        const value = Math.abs(channel[i] ?? 0);
        if (value > peak) peak = value;
      }
    }
    out[bucket] = peak;
    if (peak > loudest) loudest = peak;
  }

  for (let bucket = 0; bucket < out.length; bucket += 1) out[bucket] /= loudest;
  return out;
}

/**
 * Decodes an audio asset once and caches its peaks.
 *
 * Only audio assets are decoded: pulling a whole video through `decodeAudioData`
 * to draw a waveform nobody asked for would be wasteful.
 */
export async function ensureWaveform(asset: Asset): Promise<void> {
  if (asset.kind !== "audio") return;
  if (waveforms.has(asset.id) || waveformPending.has(asset.id) || failed.has(asset.id)) return;
  if (typeof OfflineAudioContext === "undefined" || typeof fetch !== "function") return;

  waveformPending.add(asset.id);
  try {
    const response = await fetch(asset.src);
    const bytes = await response.arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 44100);
    const decoded = await context.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c += 1) channels.push(decoded.getChannelData(c));
    waveforms.set(asset.id, peaksFromChannels(channels, WAVEFORM_BUCKETS));
    bump();
  } catch {
    // A missing waveform is cosmetic; never let it break the timeline.
    failed.add(asset.id);
  } finally {
    waveformPending.delete(asset.id);
  }
}

/* ------------------------------------------------------------------ *
 * Filmstrip thumbnails
 * ------------------------------------------------------------------ */

function naturalSize(source: CanvasImageSource): { width: number; height: number } {
  const element = source as unknown as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  return {
    width:
      element.videoWidth || element.naturalWidth || (typeof element.width === "number" ? element.width : 0),
    height:
      element.videoHeight || element.naturalHeight || (typeof element.height === "number" ? element.height : 0),
  };
}

/**
 * Sampling grid for an asset's frames.
 *
 * Quantising the requested time means two clips referencing the same footage —
 * even at different trim points — share cached frames instead of each pulling
 * their own, and it bounds the cache to ~60 entries per asset.
 */
export function thumbnailStep(asset: Asset): number {
  const duration = asset.duration && asset.duration > 0 ? asset.duration : 10;
  return Math.max(0.25, duration / THUMBNAILS_PER_ASSET);
}

export function quantizeThumbnailTime(asset: Asset, sourceTime: number): number {
  const step = thumbnailStep(asset);
  return Math.max(0, Math.round(sourceTime / step) * step);
}

function thumbnailKey(assetId: string, time: number): string {
  return `${assetId}@${time.toFixed(3)}`;
}

/** A cached frame for the quantised version of `sourceTime`, if present. */
export function getThumbnailAt(asset: Asset, sourceTime: number): HTMLCanvasElement | undefined {
  return thumbnails.get(thumbnailKey(asset.id, quantizeThumbnailTime(asset, sourceTime)));
}

function drawToCanvas(source: CanvasImageSource, size: { width: number; height: number }): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!size.width || !size.height) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.height = THUMBNAIL_HEIGHT;
    canvas.width = Math.max(1, Math.round((size.width / size.height) * THUMBNAIL_HEIGHT));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    // A video element can refuse a draw mid-seek; the caller retries later.
    return null;
  }
}

function store(canvas: HTMLCanvasElement, key: string): void {
  thumbnails.set(key, canvas);
  if (thumbnails.size > MAX_THUMBNAILS) {
    // Map preserves insertion order, so the first key is the oldest entry.
    const oldest = thumbnails.keys().next().value;
    if (oldest !== undefined && oldest !== key) thumbnails.delete(oldest);
  }
  bump();
}

/**
 * A frame that is still waiting on a seek.
 *
 * `pumpThumbnails` drains this one job at a time: firing every request at once
 * would make a single video element thrash between targets and produce a strip of
 * identical (wrong) frames.
 */
const thumbQueue: Array<{ asset: Asset; time: number; key: string }> = [];
let pumping = false;
let retryScheduled = false;

/**
 * Makes sure a frame is cached for `sourceTime`, queueing a seek when needed.
 *
 * Returns true when the frame is available *now*, so the caller can draw it
 * immediately and simply try again later otherwise.
 */
export function requestThumbnail(asset: Asset, pool: MediaPool, sourceTime: number): boolean {
  if (asset.kind !== "image" && asset.kind !== "video") return true;
  if (failed.has(asset.id) || typeof document === "undefined") return true;

  if (asset.kind === "image") {
    const key = thumbnailKey(asset.id, 0);
    if (!thumbnails.has(key)) {
      const source = pool.getImage(asset.id);
      if (!source) return false;
      const canvas = drawToCanvas(source, pool.getSize(asset.id) ?? naturalSize(source));
      if (!canvas) return false;
      store(canvas, key);
    }
    return true;
  }

  const time = quantizeThumbnailTime(asset, sourceTime);
  const key = thumbnailKey(asset.id, time);
  if (thumbnails.has(key)) return true;

  const attempts = thumbAttempts.get(key) ?? 0;
  if (attempts >= MAX_THUMB_ATTEMPTS) return true;
  if (thumbQueue.some((job) => job.key === key)) return false;

  thumbQueue.push({ asset, time, key });
  void pumpThumbnails(pool);
  return false;
}

async function pumpThumbnails(pool: MediaPool): Promise<void> {
  if (pumping) return;
  pumping = true;
  let deferred = false;
  try {
    while (thumbQueue.length > 0) {
      // The pump seeks the same video element the preview plays from, so running
      // it mid-playback would visibly stutter the picture. Background frame
      // extraction waits for a pause and reschedules itself.
      if (playback.playing) {
        deferred = true;
        break;
      }

      const job = thumbQueue.shift();
      if (!job) break;
      const { asset, time, key } = job;
      if (thumbnails.has(key) || failed.has(asset.id)) continue;

      thumbAttempts.set(key, (thumbAttempts.get(key) ?? 0) + 1);
      await pool.seekTo(asset.id, time);
      // `seekTo` resolves even on a broken file, so verify a frame is really there.
      if (!pool.isReady(asset.id)) continue;

      const source = pool.getVideo(asset.id, time);
      if (!source) continue;
      const canvas = drawToCanvas(source, pool.getSize(asset.id) ?? naturalSize(source));
      if (canvas) store(canvas, key);
    }
  } finally {
    pumping = false;
  }

  if (deferred && typeof window !== "undefined" && !retryScheduled) {
    // One pending retry is enough: every clip retries on its own timer, so
    // scheduling per call would pile up a queue of timers that all do nothing.
    retryScheduled = true;
    window.setTimeout(() => {
      retryScheduled = false;
      void pumpThumbnails(pool);
    }, 700);
  }
}

/** How many frames are cached, for diagnostics. */
export function thumbnailCacheSize(): number {
  return thumbnails.size;
}
