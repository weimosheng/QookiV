import { sampleNumber } from "../core/animation";
import { paintOrderTracks } from "../core/project";
import { effectiveDuration } from "../core/time";
import type { Asset, AudioClip, Clip, DeviceClip, Project, Seconds, VideoClip } from "../core/types";
import type { MediaProvider } from "../render/types";

/** HTMLMediaElement.volume only accepts 0..1, unlike the exporter's 0..4 gain. */
function clampUnit(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The video a clip reads, if any.
 *
 * **两种片段都能放视频**：`video` 是视频图层，`device` 是「界面演示」里嵌在设备外壳
 * 中的屏幕录像。它们走的是同一条解码链路，所以"这个片段要驱动哪条视频"必须由同一个
 * 函数回答——只认 `kind === "video"` 的话，设备层的录像既不会被 seek 也不会被播放。
 */
function videoOwner(clip: Clip): { clip: VideoClip | DeviceClip; assetId: string } | null {
  if (clip.kind === "video") return { clip, assetId: clip.props.assetId };
  if (clip.kind === "device") return { clip, assetId: clip.props.assetId };
  return null;
}

/**
 * Owns the decoded media elements for a project and implements `MediaProvider`.
 *
 * Video frames are produced by seeking, never by "play and hope": the preview
 * plays clips in real time for smoothness, but any scrub or export reads a
 * frame that has actually been seeked to the requested time.
 */

/**
 * Per-element playback bookkeeping.
 *
 * The playback clock and the media decoder advance independently, so a little
 * drift is normal and harmless. Correcting it on every frame is not: assigning
 * `currentTime` performs a seek, and a seek per frame is a continuous stream of
 * seeks that never lets the media actually play. That is the "picture and sound
 * stutter" failure, so a correction must both prove the drift is persistent and
 * then wait out a cooldown.
 */
interface SyncState {
  /** Consecutive ticks where drift exceeded the tolerance. */
  driftedTicks: number;
  /** `performance.now()` before which no further seek may be issued. */
  cooldownUntil: number;
  /** Set when the browser refused to start playback (autoplay policy). */
  blocked: boolean;
  /**
   * The position the element was last asked to move to.
   *
   * **Every** seek must go through `assignSeek`, which records it here first. The
   * `seeked` handler decides whether a seek actually landed by comparing the
   * element's position with this value, so a direct `el.currentTime = x` that skips
   * the bookkeeping makes the handler conclude the seek failed and re-seek to the
   * *previous* target — the element gets dragged back every time the drift
   * correction fires, which is exactly "the picture and sound repeat the same
   * few seconds".
   */
  target: number;
  /**
   * Set when playback stops, and consumed by the first paused read of the element.
   *
   * A paused element reports its position quantised to its own frames, so the
   * drift right after pausing is up to a full frame — more than the tight seek
   * tolerance. Without this flag the pause itself seeks the element (tearing down
   * the decoder pipeline, so the next play stutters), and doing it repeatedly is
   * what makes it feel worse every time.
   */
  justPaused: boolean;
  /** One frame of the asset, i.e. the granularity of its reported position. */
  frameTolerance: number;
}

/** Beyond this the picture is visibly off the playhead while scrubbing. */
const SCRUB_TOLERANCE = 0.04;
/**
 * While playing, this much lag counts as "in sync" and the element plays at its
 * own speed. Anything beyond it is chased with a rate trim, never with a seek.
 */
const TRIM_DEADBAND = 0.06;
/**
 * Beyond this the drift is structural (a jump, a stalled decoder) and is worth a
 * seek. Below it a seek would cost more than the error it fixes: it stops
 * playback, drops the decode buffers and needs a fresh start — which is exactly
 * how "seek → start-up latency → further behind → seek" becomes self-sustaining
 * (the preview reported "3 corrections per second" with every video stuttering).
 */
const SEEK_DRIFT = 1;
/** How much of the lag becomes a rate trim, and how far that may go. */
const RATE_TRIM_GAIN = 2;
const MAX_RATE_TRIM = 0.06;
/** Ticks of sustained drift before a correction is worth the seek. */
const DRIFT_TICKS_BEFORE_SEEK = 4;
/** Let the decoder settle after a seek before considering another. */
const SEEK_COOLDOWN_MS = 500;

function newSyncState(): SyncState {
  return {
    driftedTicks: 0,
    cooldownUntil: 0,
    blocked: false,
    target: 0,
    justPaused: false,
    frameTolerance: 1 / 30,
  };
}

/**
 * 播放里"看起来在卡"的可诊断成因。
 *
 * 这两条都不是错误：一个是设计好的行为（片段比素材长时停在最后一帧），一个是同步在
 * 自我纠正。但两者在画面上都表现为"卡"，而且成因完全不同，所以直接报出来，免得靠猜。
 */
export type SyncIssue =
  | {
      kind: "frozen";
      /** 片段名，比素材名更能定位到时间线上的哪一段。 */
      name: string;
      /** 素材实际能播多久。 */
      available: number;
      /** 片段想用到哪儿。 */
      needed: number;
    }
  | {
      kind: "correcting";
      /** 最近被纠正最多的那个片段。 */
      name: string;
      /** 一个报告窗口内的纠正次数。 */
      corrections: number;
    };

/** 一秒内纠正达到这个次数就值得说一声。 */
const CORRECTIONS_PER_REPORT = 3;

interface ImageEntry {
  el: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

interface VideoEntry {
  el: HTMLVideoElement;
  metaReady: boolean;
  seeking: boolean;
  failed: boolean;
  /** Resolved once the element has settled on the requested position. */
  waiters: Array<() => void>;
  sync: SyncState;
}

interface AudioEntry {
  el: HTMLAudioElement;
  metaReady: boolean;
  failed: boolean;
  sync: SyncState;
}

export class MediaPool implements MediaProvider {
  private images = new Map<string, ImageEntry>();
  private videos = new Map<string, VideoEntry>();
  private audios = new Map<string, AudioEntry>();
  private assets = new Map<string, Asset>();
  private fps = new Map<string, number>();
  /** The `src` each element was built from, so a relink can be detected. */
  private srcs = new Map<string, string>();
  /** Assets whose media failed to load — "offline" in NLE terms. */
  private offline = new Set<string>();
  private offlineListeners = new Set<() => void>();
  /** Notified the first time the browser refuses to start playback. */
  onPlaybackBlocked?: (error: unknown) => void;
  /** Notified when playback looks stuck, with enough detail to say why. */
  onSyncIssue?: (issue: SyncIssue) => void;
  /** 已经报过"停在最后一帧"的素材，避免每帧刷屏（每次暂停后清空）。 */
  private frozenReported = new Set<string>();
  /** 最近一秒内的纠正次数与涉及到的片段。 */
  private corrections: number[] = [];
  private lastCorrectedName = "";
  private lastCorrectionReport = 0;

  /* ---------------------------------------------------------------- *
   * Offline (missing media) tracking
   * ---------------------------------------------------------------- */

  onOfflineChange(listener: () => void): () => void {
    this.offlineListeners.add(listener);
    return () => {
      this.offlineListeners.delete(listener);
    };
  }

  isOffline(assetId: string): boolean {
    return this.offline.has(assetId);
  }

  offlineAssetIds(): string[] {
    return Array.from(this.offline);
  }

  private notifyOffline(): void {
    for (const listener of this.offlineListeners) listener();
  }

  private markOffline(assetId: string): void {
    if (this.offline.has(assetId)) return;
    this.offline.add(assetId);
    this.notifyOffline();
  }

  private clearOffline(assetId: string): void {
    if (!this.offline.delete(assetId)) return;
    this.notifyOffline();
  }

  /**
   * 记住"这个素材的一帧有多长"，供暂停/恢复容差使用。
   *
   * 元素的 `currentTime` 是按自己的帧量化的，容差小于一帧就会把"没错"判成"不同步"。
   */
  private syncFrameTolerance(assetId: string): void {
    const frame = 1 / Math.max(1, this.fps.get(assetId) ?? 30);
    const entry = this.videos.get(assetId);
    if (entry) entry.sync.frameTolerance = frame;
    const audio = this.audios.get(assetId);
    if (audio) audio.sync.frameTolerance = frame;
  }

  /**
   * Creates or drops elements so the pool matches `assets`.
   *
   * Takes a plain asset list rather than a project so thumbnails and template
   * previews can reuse the pool without inventing a throwaway project. An asset
   * whose `src` changed is rebuilt, which is what makes relinking work.
   */
  sync(assets: Asset[]): void {
    const wanted = new Map(assets.map((a) => [a.id, a]));

    for (const [id, asset] of wanted) {
      this.assets.set(id, asset);
      if (asset.fps) this.fps.set(id, asset.fps);

      const exists = this.images.has(id) || this.videos.has(id) || this.audios.has(id);
      if (exists) {
        if (this.srcs.get(id) === asset.src) {
          // 素材的帧率可能重链后才知道，随时更新"一帧有多长"（暂停容差要用）。
          this.syncFrameTolerance(id);
          continue;
        }
        this.dropImage(id);
        this.dropVideo(id);
        this.dropAudio(id);
        this.clearOffline(id);
      }
      this.srcs.set(id, asset.src);
      this.create(asset);
      this.syncFrameTolerance(id);
    }

    for (const id of Array.from(this.images.keys())) {
      if (!wanted.has(id)) this.dropImage(id);
    }
    for (const id of Array.from(this.videos.keys())) {
      if (!wanted.has(id)) this.dropVideo(id);
    }
    for (const id of Array.from(this.audios.keys())) {
      if (!wanted.has(id)) this.dropAudio(id);
    }
  }

  /**
   * True while an element still points at something real.
   *
   * Dropping an element clears its `src`, which fires an `error` event; without
   * this guard, tearing down a pool entry would report the asset as offline.
   */
  private stillHasSource(el: HTMLImageElement | HTMLVideoElement | HTMLAudioElement): boolean {
    return !!el.getAttribute("src");
  }

  private create(asset: Asset): void {
    if (typeof document === "undefined") return;
    switch (asset.kind) {
      case "image": {
        const el = new Image();
        el.decoding = "async";
        const entry: ImageEntry = { el, ready: false, failed: false };
        el.onload = () => {
          entry.ready = true;
          this.clearOffline(asset.id);
        };
        el.onerror = () => {
          entry.failed = true;
          if (this.stillHasSource(el)) this.markOffline(asset.id);
        };
        el.src = asset.src;
        this.images.set(asset.id, entry);
        break;
      }
      case "video": {
        const el = document.createElement("video");
        el.preload = "auto";
        el.playsInline = true;
        const entry: VideoEntry = {
          el,
          metaReady: false,
          seeking: false,
          failed: false,
          waiters: [],
          sync: newSyncState(),
        };
        el.addEventListener("loadedmetadata", () => {
          entry.metaReady = true;
          this.clearOffline(asset.id);
        });
        el.addEventListener("seeked", () => {
          entry.seeking = false;
          // 判断"这次 seek 落地没有"必须用**我们要它去的位置**（单一直源），
          // 而不是元素当前的其它读数——见 `SyncState.target` 的注释。
          if (Math.abs(el.currentTime - entry.sync.target) > this.tolerance(asset.id)) {
            this.performSeek(entry);
            return;
          }
          this.flushWaiters(entry);
        });
        el.addEventListener("error", () => {
          entry.failed = true;
          if (this.stillHasSource(el)) this.markOffline(asset.id);
          this.flushWaiters(entry);
        });
        el.src = asset.src;
        this.videos.set(asset.id, entry);
        break;
      }
      case "audio": {
        this.audios.set(asset.id, this.createAudioEntry(asset));
        break;
      }
    }
  }

  private createAudioEntry(asset: Asset): AudioEntry {
    const el = new Audio();
    el.preload = "auto";
    const entry: AudioEntry = { el, metaReady: false, failed: false, sync: newSyncState() };
    el.addEventListener("loadedmetadata", () => {
      entry.metaReady = true;
      this.clearOffline(asset.id);
    });
    el.addEventListener("error", () => {
      entry.failed = true;
      if (this.stillHasSource(el)) this.markOffline(asset.id);
    });
    el.src = asset.src;
    return entry;
  }

  /**
   * The audio element for an asset, created on demand.
   *
   * A video asset normally only gets a video element. Once its audio has been
   * detached onto an audio track, an audio clip references that same video asset
   * and needs its own element: reusing the picture's element would tie the
   * detached sound back to the picture's position, which is the whole thing
   * detaching is supposed to avoid. Without this the split audio plays silently.
   */
  private audioElementFor(assetId: string): AudioEntry | null {
    const existing = this.audios.get(assetId);
    if (existing) return existing;
    const asset = this.assets.get(assetId);
    if (!asset || asset.kind !== "video") return null;
    const entry = this.createAudioEntry(asset);
    this.audios.set(assetId, entry);
    return entry;
  }

  private dropImage(id: string): void {
    const entry = this.images.get(id);
    if (entry) entry.el.src = "";
    this.images.delete(id);
    this.srcs.delete(id);
  }

  private dropVideo(id: string): void {
    const entry = this.videos.get(id);
    if (entry) {
      entry.el.pause();
      entry.el.removeAttribute("src");
      entry.el.load();
    }
    this.videos.delete(id);
    this.srcs.delete(id);
  }

  private dropAudio(id: string): void {
    const entry = this.audios.get(id);
    if (entry) {
      entry.el.pause();
      entry.el.removeAttribute("src");
    }
    this.audios.delete(id);
  }

  releaseAll(): void {
    for (const id of Array.from(this.images.keys())) this.dropImage(id);
    for (const id of Array.from(this.videos.keys())) this.dropVideo(id);
    for (const id of Array.from(this.audios.keys())) this.dropAudio(id);
    this.assets.clear();
    this.fps.clear();
    this.srcs.clear();
    this.offline.clear();
    this.notifyOffline();
  }

  /* ---------------------------------------------------------------- *
   * MediaProvider
   * ---------------------------------------------------------------- */

  getImage(assetId: string): CanvasImageSource | null {
    const entry = this.images.get(assetId);
    if (!entry || !entry.ready || entry.failed) return null;
    return entry.el;
  }

  /**
   * The element to draw for `sourceTime`.
   *
   * While the element is **playing** it owns its own position: `playVideos` keeps
   * it roughly in step with the clock, and the renderer just draws whatever the
   * element currently shows.
   *
   * This check is load-bearing. The compositor runs every frame, and a playing
   * element's `currentTime` never agrees with the playhead to within the seek
   * tolerance (about one frame), so seeking here fired on essentially every
   * frame: a continuous seek storm that broke up both the picture and the
   * element's own audio. Scrubbing and export are unaffected — there the element
   * is paused and an exact seek is exactly what is wanted.
   *
   * The **paused** case is subtler, and is why `sync.justPaused` exists: a paused
   * element reports its position **quantised to its own frames**, so the drift at
   * the instant of pausing is uniformly 0..1 frame — always more than `0.6/fps`.
   * That made roughly every second pause (24fps: nearly every pause) seek the
   * element to a position it was already showing, and each seek tears down the
   * decoder pipeline: the next play had to re-prime it, which the user sees as
   * "pausing and resuming stutters, and the more you do it the worse it gets".
   * So the first read after playback stops tolerates a full frame; every read
   * after that (scrubbing, frame stepping) keeps the tight tolerance, because
   * there the position really did change and must be hit exactly.
   */
  getVideo(assetId: string, sourceTime: Seconds): CanvasImageSource | null {
    const entry = this.videos.get(assetId);
    if (!entry || entry.failed || !entry.metaReady) return null;

    if (entry.el.paused) {
      // 刚停下那一次，一帧之内的偏差就是"没错"——它显示的正是该显示的那一帧。
      // 再往后（擦洗、步进）位置是真的变了，必须精确。
      const tolerance = entry.sync.justPaused
        ? Math.max(this.tolerance(assetId), entry.sync.frameTolerance)
        : this.tolerance(assetId);
      entry.sync.justPaused = false;
      if (!entry.seeking && Math.abs(entry.el.currentTime - sourceTime) > tolerance) {
        this.requestSeek(entry, sourceTime);
      }
    }

    // Returning the element mid-seek shows the previous frame rather than a
    // hole; exporters await `settle()` so they never see a stale frame.
    return entry.el;
  }

  getSize(assetId: string): { width: number; height: number } | null {
    const asset = this.assets.get(assetId);
    if (asset?.width && asset.height) return { width: asset.width, height: asset.height };

    const img = this.images.get(assetId);
    if (img?.ready) return { width: img.el.naturalWidth, height: img.el.naturalHeight };

    const vid = this.videos.get(assetId);
    if (vid?.metaReady) return { width: vid.el.videoWidth, height: vid.el.videoHeight };

    return null;
  }

  isReady(assetId: string): boolean {
    if (!assetId) return true;
    const img = this.images.get(assetId);
    if (img) return img.ready || img.failed;

    const vid = this.videos.get(assetId);
    if (vid) {
      if (vid.failed) return true;
      return vid.metaReady && !vid.seeking;
    }

    const aud = this.audios.get(assetId);
    if (aud) return aud.metaReady || aud.failed;

    // Unknown asset (for example a background layer) is never blocking.
    return true;
  }

  getAudioElement(assetId: string): HTMLAudioElement | null {
    return this.audios.get(assetId)?.el ?? null;
  }

  /** The live video element for an asset, used by tests and diagnostics. */
  getVideoElement(assetId: string): HTMLVideoElement | null {
    return this.videos.get(assetId)?.el ?? null;
  }

  /* ---------------------------------------------------------------- *
   * Seeking
   * ---------------------------------------------------------------- */

  private tolerance(assetId: string): number {
    const fps = this.fps.get(assetId) ?? 30;
    return 0.6 / Math.max(1, fps);
  }

  /**
   * The **only** place allowed to assign `currentTime`.
   *
   * Recording the request in `sync.target` first is what keeps the `seeked` handler
   * honest: it re-seeks whenever the element lands away from that value, so an
   * unrecorded assignment looks like a failed seek and gets undone.
   */
  private assignSeek(entry: { el: HTMLMediaElement; sync: SyncState }, time: number): void {
    const target = Math.max(0, time);
    entry.sync.target = target;
    try {
      entry.el.currentTime = target;
    } catch {
      // Metadata not ready yet; the next query retries.
    }
  }

  private requestSeek(entry: VideoEntry, time: number): void {
    entry.sync.target = Math.max(0, time);
    if (entry.seeking) return;
    this.performSeek(entry);
  }

  private performSeek(entry: VideoEntry): void {
    const el = entry.el;
    if (el.readyState < 1) {
      // Metadata is not in yet; `loadedmetadata` will let the next query retry.
      return;
    }
    entry.seeking = true;
    const target = entry.sync.target;
    try {
      el.currentTime = target;
    } catch {
      entry.seeking = false;
      this.flushWaiters(entry);
    }
  }

  private flushWaiters(entry: VideoEntry): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) w();
  }

  /**
   * Moves a video to `time` and resolves once the frame is actually available.
   * This is the exporter's guarantee of frame accuracy.
   */
  seekTo(assetId: string, time: number): Promise<void> {
    const entry = this.videos.get(assetId);
    if (!entry || entry.failed) return Promise.resolve();
    const target = Math.max(0, time);

    if (!entry.metaReady) {
      return new Promise<void>((resolve) => {
        const onReady = () => {
          entry.el.removeEventListener("loadedmetadata", onReady);
          resolve(this.seekTo(assetId, target));
        };
        entry.el.addEventListener("loadedmetadata", onReady);
        // Do not hang forever on a broken file.
        window.setTimeout(() => {
          entry.el.removeEventListener("loadedmetadata", onReady);
          resolve();
        }, 2500);
      });
    }

    if (!entry.seeking && Math.abs(entry.el.currentTime - target) <= this.tolerance(assetId)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      entry.waiters.push(resolve);
      entry.sync.target = target;
      if (!entry.seeking) this.performSeek(entry);

      // Seek can silently fail on exotic codecs; never block a render forever.
      window.setTimeout(() => {
        const idx = entry.waiters.indexOf(resolve);
        if (idx >= 0) entry.waiters.splice(idx, 1);
        resolve();
      }, 2000);
    });
  }

  /**
   * Seeks every asset needed at `time` and waits for all of them. Used by the
   * exporter before it captures a frame.
   */
  async settle(project: Project, time: Seconds): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    for (const track of paintOrderTracks(project)) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        const local = time - clip.start;
        if (local < 0 || local >= clip.duration) continue;
        const owner = videoOwner(clip);
        if (!owner || !owner.assetId) continue;
        if (this.videos.has(owner.assetId)) {
          jobs.push(this.seekTo(owner.assetId, clip.trimIn + local * clip.speed));
        }
      }
    }
    if (jobs.length > 0) await Promise.all(jobs);
  }

  /* ---------------------------------------------------------------- *
   * Transport control for the live preview
   * ---------------------------------------------------------------- */

  /**
   * Aligns one element with the timeline.
   *
   * While paused (scrubbing) an exact seek is free and keeps the picture locked
   * to the playhead. While playing it is not free — each assignment is a seek —
   * so the drift has to persist before it is worth correcting, and a cooldown
   * lets the decoder settle afterwards.
   */
  private syncElement(
    entry: { el: HTMLMediaElement; sync: SyncState },
    sourceTime: number,
    playing: boolean,
    speed: number,
    allowRewind = false,
    clipName = "",
  ): void {
    const el = entry.el;
    const state = entry.sync;

    // A blocked element is not advancing at all; seeking it would only produce a
    // stream of seeks that never plays anything.
    if (state.blocked) return;

    // Never aim past the end of the file: the browser clamps such a seek to the
    // last frame, which then reads as a permanent drift and invites another seek.
    const end = this.sourceEnd(el);
    const target = end === null ? sourceTime : Math.min(sourceTime, Math.max(0, end - 1 / 60));

    if (!playing || el.paused) {
      /*
       * 暂停态（也是"刚按下继续、元素还没起来"这一帧）：精确对齐。
       *
       * 但容差必须**至少一帧**：暂停的元素按自己的帧量化报告位置，用 0.04 这种紧容差
       * 会让每次"继续"都先 seek 一次，而 seek 又带来起播延迟 —— 于是 seek→延迟→seek
       * 自我维持，所有元素一起卡（状态栏那句"每秒纠正 3 次"）。`justPaused` 就是为此
       * 存在的：它只放过刚停下的那一次。
       */
      const frame = state.frameTolerance;
      const tolerance = state.justPaused ? Math.max(SCRUB_TOLERANCE, frame) : SCRUB_TOLERANCE;
      state.justPaused = false;
      if (Math.abs(el.currentTime - target) > tolerance) this.assignSeek(entry, target);
      state.driftedTicks = 0;
      return;
    }

    /*
     * 播放中：**小漂移用速度微调追平，绝不用 seek**。
     *
     * seek 会停下播放、丢掉解码缓冲、再花几十到一百多毫秒重新起播。用它去修一个同样
     * 量级的滞后是净亏，而且**会自我维持**：seek→起播延迟→更落后→再 seek。每次"暂停/
     * 继续"都会留下一点起播延迟，用 seek 去修就会一次比一次糟（状态栏"每秒纠正 N 次"、
     * 所有视频一起卡）；只"容忍"而不追平，则会一次一次把偏移**攒起来**。
     *
     * 追平靠 `playbackRate`：落后就稍微放快、领先就稍微放慢，回到死区立刻恢复片段本身的
     * 速度（音频 `preservesPitch` 默认开着，听感只是极小的速度变化）。只有 ≥1s 的
     * **结构性**大漂移（真跳变、解码器卡死）才值得 seek。
     */
    const lag = target - el.currentTime;
    const drift = Math.abs(lag);

    if (drift <= TRIM_DEADBAND) {
      state.driftedTicks = 0;
      this.applyRate(el, speed);
      return;
    }

    if (drift < SEEK_DRIFT) {
      const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, lag * RATE_TRIM_GAIN));
      this.applyRate(el, speed * (1 + trim));
      state.driftedTicks = 0;
      return;
    }

    if (allowRewind) {
      // A jump: do not wait for the drift to "prove" itself, and do not let the
      // cooldown delay it either — the playhead is somewhere else now.
      state.driftedTicks = 0;
      state.cooldownUntil = 0;
      this.applyRate(el, speed);
      this.assignSeek(entry, target);
      return;
    }

    const now = this.now();
    if (now < state.cooldownUntil) return;

    state.driftedTicks += 1;
    if (state.driftedTicks < DRIFT_TICKS_BEFORE_SEEK) return;

    state.driftedTicks = 0;
    state.cooldownUntil = now + SEEK_COOLDOWN_MS;
    this.applyRate(el, speed);
    this.assignSeek(entry, target);
    this.noteCorrection(clipName);
  }

  /**
   * 只在真正需要时改 `playbackRate`：每一帧都写会让解码器不断重配。
   *
   * 追平之后必须回到片段本身的速度，否则画面会一直比时间线快/慢一点点。
   */
  private applyRate(el: HTMLMediaElement, rate: number): void {
    const clamped = Math.max(0.05, Math.min(16, rate));
    if (Math.abs(el.playbackRate - clamped) > 0.005) el.playbackRate = clamped;
  }

  /**
   * 记一次同步纠正，并在**一秒内纠正太频繁**时报一声。
   *
   * 正常的对表是偶尔发生（一次 seek 就够）；一秒里好几次意味着元素一直在被拽，
   * 画面上就是"卡"。报出来的信息（是哪个片段）比"我这边看着卡"有用得多。
   */
  private noteCorrection(clipName: string): void {
    this.lastCorrectedName = clipName || this.lastCorrectedName;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.corrections.push(now);
    this.corrections = this.corrections.filter((at) => now - at <= 1000);
    if (this.corrections.length < CORRECTIONS_PER_REPORT) return;
    if (now - this.lastCorrectionReport < 1000) return;
    this.lastCorrectionReport = now;
    const corrections = this.corrections.length;
    this.corrections = [];
    this.onSyncIssue?.({
      kind: "correcting",
      name: this.lastCorrectedName,
      corrections,
    });
  }

  /** Cooldown clock; `performance` where available so it cannot jump. */
  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** How much source the element can actually play, or null when unknown. */
  private sourceEnd(el: HTMLMediaElement): number | null {
    const duration = el.duration;
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  /**
   * Holds an element on its last frame once the timeline has run past the source.
   *
   * This happens whenever the clip is longer than the media: the asset's metadata
   * duration can be longer than the decodable stream (variable-frame-rate
   * containers are the usual culprit), and a file whose length the probe could not
   * determine gets the default clip length.
   *
   * Pausing here is not enough on its own — `startPlayback` must also refuse to
   * play an ended element, because the HTML spec *seeks back to the start* when
   * `play()` is called on one. Together with the drift correction, that produced
   * the "picture and sound repeat the same few seconds forever" loop: the element
   * restarts at 0, four ticks later the correction seeks it back to the end, it
   * ends again, and `play()` rewinds it once more.
   */
  private freezeAtEnd(
    entry: { el: HTMLMediaElement; sync: SyncState },
    end: number,
    context?: { assetId: string; name: string; needed: number },
  ): void {
    const el = entry.el;
    if (!el.paused) el.pause();
    const last = Math.max(0, end - 1 / 60);
    if (Math.abs(el.currentTime - last) > SCRUB_TOLERANCE) {
      this.assignSeek(entry, last);
    }
    entry.sync.driftedTicks = 0;

    // 说清楚"为什么停住"：片段比素材长，画面上就是最后那一帧不动——很容易被当成卡。
    if (context && context.needed > end + 0.05 && !this.frozenReported.has(context.assetId)) {
      this.frozenReported.add(context.assetId);
      this.onSyncIssue?.({
        kind: "frozen",
        name: context.name,
        available: end,
        needed: context.needed,
      });
    }
  }

  /**
   * Starts an element if it is not already running.
   *
   * Keeps trying on every tick rather than latching a failure: the browser may
   * refuse until the user has interacted, and the same call succeeds afterwards.
   */
  private startPlayback(el: HTMLMediaElement, state: SyncState): void {
    // An ended element must never be played again: the spec rewinds it to the
    // start, which turns "the clip outlasts its media" into an endless replay.
    if (el.ended) return;
    if (!el.paused) {
      state.blocked = false;
      return;
    }
    const promise = el.play();
    /*
     * 起播窗口（`play()` 先 resolve、位置后动）不再需要特殊照顾：那点滞后由速度微调
     * 追平，不靠 seek 回避——所以这里什么都不用做。
     */
    if (!promise || typeof promise.then !== "function") return;
    promise.then(
      () => {
        state.blocked = false;
      },
      (error: unknown) => {
        if (state.blocked) return;
        state.blocked = true;
        this.onPlaybackBlocked?.(error);
      },
    );
  }

  /** Assigns only when the value actually changes; repeated writes are not free. */
  private static setIfChanged(el: HTMLMediaElement, key: "volume" | "muted", value: number | boolean): void {
    if (key === "muted") {
      if (el.muted !== value) el.muted = value as boolean;
      return;
    }
    const next = value as number;
    if (Math.abs(el.volume - next) > 0.001) el.volume = next;
  }

  /** Starts every video element that should be playing at `time`. */
  playVideos(project: Project, time: Seconds, opts: { exact?: boolean; rate?: number } = {}): void {
    /*
     * 每条素材在同一时刻只能有一个"主人"。
     *
     * 同一个素材被多个片段引用、且在时间上重叠时（复制一段到上层轨道就会这样），两个
     * 片段每帧各报一个目标位置，元素被来回拖——画面于是在两个位置之间反复跳。让最上层
     * 的那个说了算（`paintOrderTracks` 是从后到前，所以最后写入的覆盖先写入的），它也正是
     * 画面上看得见的那一个。
     */
    const owners = new Map<string, { clip: VideoClip | DeviceClip; sourceTime: number; local: number }>();

    for (const track of paintOrderTracks(project)) {
      if (track.hidden) continue;
      for (const clip of track.clips) {
        if (!clip.enabled) continue;
        const owner = videoOwner(clip);
        if (!owner || !owner.assetId) continue;
        const entry = this.videos.get(owner.assetId);
        if (!entry || !entry.metaReady) continue;
        const local = time - clip.start;
        if (local < 0 || local >= clip.duration) continue;
        owners.set(owner.assetId, {
          clip: owner.clip,
          sourceTime: clip.trimIn + local * clip.speed,
          local,
        });
      }
    }

    for (const [assetId, owner] of owners) {
      const entry = this.videos.get(assetId);
      if (!entry) continue;
      const { clip, sourceTime, local } = owner;
      const el = entry.el;
      /*
       * 设备外壳里的录像**强制静音**。
       *
       * 它是嵌在界面卡片里的屏幕录像，声音既没有意义，又会和视频轨/音轨的混音打架；
       * 参考片里的设备演示也从来没有声音。
       */
      if (clip.kind === "device") {
        MediaPool.setIfChanged(el, "muted", true);
      } else {
        MediaPool.setIfChanged(el, "muted", clip.props.muted);
        // Sample the animated volume: a fade must be audible in the preview, not
        // only in the export.
        MediaPool.setIfChanged(
          el,
          "volume",
          clampUnit(sampleNumber(clip.animation, "props.volume", local, clip.props.volume)),
        );
      }

      const end = this.sourceEnd(el);
      if (end !== null && sourceTime >= end - 1 / 120) {
        this.freezeAtEnd(entry, end, {
          assetId,
          name: clip.name,
          needed: sourceTime,
        });
        continue;
      }

      // Skip the drift correction while a seek is still in flight.
      if (!entry.seeking) {
        this.syncElement(entry, sourceTime, true, clip.speed * (opts.rate ?? 1), opts.exact === true, clip.name);
      }
      this.startPlayback(el, entry.sync);
    }

    // Anything playing that is not being driven right now has run past its clip
    // and must be stopped — otherwise a clip's tail keeps playing after the
    // picture has moved on.
    for (const [assetId, entry] of this.videos) {
      if (!owners.has(assetId) && !entry.el.paused) entry.el.pause();
    }
  }

  /** Pauses every video element; used when playback stops or while scrubbing. */
  pauseVideos(): void {
    for (const entry of this.videos.values()) {
      if (entry.el.paused) continue;
      entry.el.pause();
      // 刚停下：第一次暂停态取帧要容忍整整一帧（见 `SyncState.justPaused`）。
      entry.sync.justPaused = true;
    }
  }
  playAudio(project: Project, time: Seconds, opts: { exact?: boolean; rate?: number } = {}): void {
    // 同一个素材的多个音频片段同样只能有一个主人（理由见 `playVideos`）。
    const owners = new Map<string, { clip: AudioClip; sourceTime: number; local: number }>();

    for (const track of project.tracks) {
      if (track.kind !== "audio" || track.muted) continue;
      for (const clip of track.clips) {
        if (!clip.enabled || clip.kind !== "audio") continue;
        const entry = this.audioElementFor(clip.props.assetId);
        if (!entry) continue;
        const local = time - clip.start;
        if (local < 0 || local >= clip.duration) continue;
        owners.set(clip.props.assetId, {
          clip,
          sourceTime: clip.trimIn + local * clip.speed,
          local,
        });
      }
    }

    for (const [assetId, owner] of owners) {
      const entry = this.audios.get(assetId);
      if (!entry) continue;
      const { clip, sourceTime, local } = owner;
      const el = entry.el;
      MediaPool.setIfChanged(
        el,
        "volume",
        clampUnit(sampleNumber(clip.animation, "props.volume", local, clip.props.volume)),
      );

      const end = this.sourceEnd(el);
      if (end !== null && sourceTime >= end - 1 / 120) {
        this.freezeAtEnd(entry, end, {
          assetId,
          name: clip.name,
          needed: sourceTime,
        });
        continue;
      }

      this.syncElement(entry, sourceTime, true, clip.speed * (opts.rate ?? 1), opts.exact === true, clip.name);
      this.startPlayback(el, entry.sync);
    }

    // Music must stop with its clip, exactly like the picture does.
    for (const [assetId, entry] of this.audios) {
      if (!owners.has(assetId) && !entry.el.paused) entry.el.pause();
    }
  }

  pauseAudio(): void {
    for (const entry of this.audios.values()) {
      if (!entry.el.paused) entry.el.pause();
    }
  }

  pauseAll(): void {
    this.pauseVideos();
    this.pauseAudio();
    // 下一次播放重新开始报"停在最后一帧"，否则同一条素材只会在第一次播放时提示。
    this.frozenReported.clear();
    this.corrections = [];
    // 同步状态不许跨暂停累计：被节流的冷却、以及"浏览器拒绝了自动播放"的标记都清掉，
    // 否则暂停/继续来回几次之后，元素会带着上一次的残留状态继续跑。
    for (const entry of this.videos.values()) this.resetSyncState(entry.sync);
    for (const entry of this.audios.values()) this.resetSyncState(entry.sync);
  }

  /** 清掉一次播放留下的同步残留（冷却、连续漂移计数、被阻止标记）。 */
  private resetSyncState(state: SyncState): void {
    state.driftedTicks = 0;
    state.cooldownUntil = 0;
    state.blocked = false;
  }
}

/** Total timeline length used for the transport slider. */
export function timelineDuration(project: Project): Seconds {
  return effectiveDuration(project);
}
