import { paintOrderTracks } from "../core/project";
import type { Asset, Project, Seconds } from "../core/types";
import type { MediaProvider } from "../render/types";

/**
 * 播放器专用的媒体池。
 *
 * 与编辑器里的 `MediaPool` 保持同样的语义（视频帧只来自"真正 seek 到位"的
 * 元素），但刻意做得更薄：不依赖编辑器 store、不依赖任何第三方库，整个文件
 * 只服务导出的单页播放器。
 */

interface ImageEntry {
  el: HTMLImageElement;
  ready: boolean;
  failed: boolean;
}

interface VideoEntry {
  el: HTMLVideoElement;
  metaReady: boolean;
  /** 正在被 seek 到的源时间。 */
  target: number;
  seeking: boolean;
  failed: boolean;
  /** 元素是否被允许自由播放（帧精度交给播放器而不是 seek）。 */
  freeRun: boolean;
  /** 元素已 settle 在 `target` 时被调用。 */
  waiters: Array<() => void>;
}

interface AudioEntry {
  el: HTMLAudioElement;
  metaReady: boolean;
  failed: boolean;
}

/** 某个素材在 `time` 时刻实际要显示的参数；同一素材取最上层的那个剪辑。 */
export interface ClipPlayback {
  assetId: string;
  sourceTime: Seconds;
  speed: number;
  volume: number;
  muted: boolean;
}

/**
 * 跨域资源才需要显式声明 CORS；data:/blob:/相对路径自带同源语义，
 * 给它们加 `crossOrigin` 反而可能让服务器拒绝返回。
 */
function isCrossOrigin(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export class PlayerMediaPool implements MediaProvider {
  private images = new Map<string, ImageEntry>();
  private videos = new Map<string, VideoEntry>();
  private audios = new Map<string, AudioEntry>();
  private assets = new Map<string, Asset>();
  private fps = new Map<string, number>();
  /** 全局静音（自动播放起步时打开）。 */
  private globalMuted = false;

  constructor(project: Project) {
    this.sync(project);
  }

  /* ---------------------------------------------------------------- *
   * 元素生命周期
   * ---------------------------------------------------------------- */

  /** 让池子里的元素与 `project.assets` 完全一致。 */
  sync(project: Project): void {
    const wanted = new Map(project.assets.map((a) => [a.id, a]));

    for (const asset of project.assets) {
      this.assets.set(asset.id, asset);
      if (asset.fps) this.fps.set(asset.id, asset.fps);
      if (this.images.has(asset.id) || this.videos.has(asset.id) || this.audios.has(asset.id)) {
        continue;
      }
      this.create(asset);
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

  private create(asset: Asset): void {
    if (typeof document === "undefined") return;

    switch (asset.kind) {
      case "image": {
        const el = new Image();
        el.decoding = "async";
        if (isCrossOrigin(asset.src)) el.crossOrigin = "anonymous";
        const entry: ImageEntry = { el, ready: false, failed: false };
        el.onload = () => {
          entry.ready = true;
        };
        el.onerror = () => {
          entry.failed = true;
        };
        el.src = asset.src;
        this.images.set(asset.id, entry);
        break;
      }
      case "video": {
        const el = document.createElement("video");
        el.preload = "auto";
        el.playsInline = true;
        // 单页播放器里的视频永远不该被画到界面上，但保留 muted 默认值，
        // 让"自动播放必须静音"这条浏览器策略在元素层面就成立。
        el.muted = true;
        if (isCrossOrigin(asset.src)) el.crossOrigin = "anonymous";
        const entry: VideoEntry = {
          el,
          metaReady: false,
          target: 0,
          seeking: false,
          failed: false,
          freeRun: false,
          waiters: [],
        };
        el.addEventListener("loadedmetadata", () => {
          entry.metaReady = true;
        });
        el.addEventListener("seeked", () => {
          entry.seeking = false;
          if (Math.abs(el.currentTime - entry.target) > this.tolerance(asset.id)) {
            this.performSeek(entry);
            return;
          }
          this.flushWaiters(entry);
        });
        el.addEventListener("error", () => {
          entry.failed = true;
          this.flushWaiters(entry);
        });
        el.src = asset.src;
        this.videos.set(asset.id, entry);
        break;
      }
      case "audio": {
        const el = new Audio();
        el.preload = "auto";
        if (isCrossOrigin(asset.src)) el.crossOrigin = "anonymous";
        const entry: AudioEntry = { el, metaReady: false, failed: false };
        el.addEventListener("loadedmetadata", () => {
          entry.metaReady = true;
        });
        el.addEventListener("error", () => {
          entry.failed = true;
        });
        el.src = asset.src;
        this.audios.set(asset.id, entry);
        break;
      }
      default:
        break;
    }
  }

  private dropImage(id: string): void {
    const entry = this.images.get(id);
    if (entry) entry.el.src = "";
    this.images.delete(id);
  }

  private dropVideo(id: string): void {
    const entry = this.videos.get(id);
    if (entry) {
      entry.el.pause();
      entry.el.removeAttribute("src");
      entry.el.load();
    }
    this.videos.delete(id);
  }

  private dropAudio(id: string): void {
    const entry = this.audios.get(id);
    if (entry) {
      entry.el.pause();
      entry.el.removeAttribute("src");
      entry.el.load();
    }
    this.audios.delete(id);
  }

  /* ---------------------------------------------------------------- *
   * MediaProvider
   * ---------------------------------------------------------------- */

  getImage(assetId: string): CanvasImageSource | null {
    const entry = this.images.get(assetId);
    if (!entry || !entry.ready || entry.failed) return null;
    return entry.el;
  }

  getVideo(assetId: string, sourceTime: Seconds): CanvasImageSource | null {
    const entry = this.videos.get(assetId);
    if (!entry || entry.failed || !entry.metaReady) return null;

    if (!entry.freeRun && !entry.seeking) {
      if (Math.abs(entry.el.currentTime - sourceTime) > this.tolerance(assetId)) {
        this.requestSeek(entry, sourceTime);
      }
    }
    // seek 过程中返回元素本身，画出来的是上一帧而不是空洞；
    // 需要帧精确时调用方会先 `seekAll` 等待 settle。
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

    // 未知素材（例如纯背景层）不阻塞播放。
    return true;
  }

  /* ---------------------------------------------------------------- *
   * seek
   * ---------------------------------------------------------------- */

  private tolerance(assetId: string): number {
    const fps = this.fps.get(assetId) ?? 30;
    return 0.6 / Math.max(1, fps);
  }

  private requestSeek(entry: VideoEntry, time: number): void {
    entry.target = Math.max(0, time);
    if (entry.seeking) return;
    this.performSeek(entry);
  }

  private performSeek(entry: VideoEntry): void {
    const el = entry.el;
    if (el.readyState < 1) return; // 元数据还没到，下一次查询会重试
    entry.seeking = true;
    try {
      el.currentTime = entry.target;
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

  /** 让某个视频精确停在 `time`，并在帧真正可用后才 resolve。 */
  seekTo(assetId: string, time: Seconds): Promise<void> {
    const entry = this.videos.get(assetId);
    if (!entry || entry.failed) return Promise.resolve();

    entry.freeRun = false;
    const target = Math.max(0, time);

    if (!entry.metaReady) {
      return new Promise<void>((resolve) => {
        const onReady = () => {
          entry.el.removeEventListener("loadedmetadata", onReady);
          resolve(this.seekTo(assetId, target));
        };
        entry.el.addEventListener("loadedmetadata", onReady);
        // 坏文件不能让渲染永远卡住。
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
      entry.target = target;
      if (!entry.seeking) this.performSeek(entry);

      // 极端编码下 seek 可能静默失败，绝不无限等待。
      window.setTimeout(() => {
        const idx = entry.waiters.indexOf(resolve);
        if (idx >= 0) entry.waiters.splice(idx, 1);
        resolve();
      }, 2000);
    });
  }

  /** 把 `time` 需要的所有视频一次性 seek 到位；返回后可以安全地画帧。 */
  async seekAll(at: ClipPlayback[]): Promise<void> {
    const jobs: Array<Promise<void>> = [];
    for (const item of at) {
      if (this.videos.has(item.assetId)) jobs.push(this.seekTo(item.assetId, item.sourceTime));
    }
    if (jobs.length > 0) await Promise.all(jobs);
  }

  /* ---------------------------------------------------------------- *
   * 播放
   * ---------------------------------------------------------------- */

  /**
   * 让 `time` 时刻应该播放的视频自由跑起来（按剪辑速度设置 playbackRate），
   * 只在漂移过大时重新 seek —— 与编辑器预览的行为一致，保证画面流畅。
   */
  runVideos(at: ClipPlayback[]): void {
    for (const item of at) {
      const entry = this.videos.get(item.assetId);
      if (!entry || !entry.metaReady || entry.failed) continue;

      const el = entry.el;
      const rate = item.speed > 0 ? item.speed : 1;
      if (Math.abs(el.playbackRate - rate) > 0.01) el.playbackRate = rate;
      el.muted = item.muted;
      el.volume = Math.max(0, Math.min(1, item.volume));

      const drift = Math.abs(el.currentTime - item.sourceTime);
      if (drift > 0.25) {
        // 漂移太大：先精确 seek，等 settle 后再交给下一次 runVideos。
        entry.freeRun = false;
        this.requestSeek(entry, item.sourceTime);
        continue;
      }

      if (entry.seeking) continue;
      entry.freeRun = true;
      if (el.paused) void el.play().catch(() => undefined);
    }
  }

  pauseVideos(): void {
    for (const entry of this.videos.values()) {
      entry.freeRun = false;
      if (!entry.el.paused) entry.el.pause();
    }
  }

  /** 在 `time` 时刻播放音频轨道上的音频剪辑。 */
  runAudio(at: ClipPlayback[]): void {
    for (const item of at) {
      const entry = this.audios.get(item.assetId);
      if (!entry || !entry.metaReady || entry.failed) continue;
      const el = entry.el;
      if (Math.abs(el.currentTime - item.sourceTime) > 0.3) {
        try {
          el.currentTime = item.sourceTime;
        } catch {
          // 忽略：下一帧会再试一次。
        }
      }
      el.muted = this.globalMuted || item.muted;
      // 静音时把增益一并压到 0，避免个别实现下 muted 生效时机偏晚。
      el.volume = this.globalMuted ? 0 : Math.max(0, Math.min(1, item.volume));
      if (el.paused) void el.play().catch(() => undefined);
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
  }

  /** 全局静音开关，用于"先静音自动播放，首次交互再取消静音"。 */
  setMuted(muted: boolean): void {
    this.globalMuted = muted;
    for (const entry of this.videos.values()) entry.el.muted = muted;
    for (const entry of this.audios.values()) entry.el.muted = muted;
  }

  get muted(): boolean {
    return this.globalMuted;
  }

  /** 项目里是否真的存在音频内容（决定要不要显示音量控件）。 */
  hasAudio(project: Project): boolean {
    for (const track of project.tracks) {
      if (track.kind !== "audio" || track.muted) continue;
      for (const clip of track.clips) {
        if (clip.enabled && clip.kind === "audio" && !clip.props.muted) return true;
      }
    }
    return false;
  }

  hasAnyAudio(project: Project): boolean {
    for (const asset of project.assets) {
      if (asset.kind === "audio") return true;
      if (asset.kind === "video" && asset.hasAudio) return true;
    }
    return false;
  }
}

/**
 * 计算 `time` 时刻每个素材应该呈现的最上层剪辑参数。
 *
 * 同一个素材可能被多个剪辑引用（例如同一段录屏出现在两个位置），
 * 这里以绘制顺序的最后一次出现为准，和合成器的结果保持一致。
 */
export function mediaAt(project: Project, time: Seconds): ClipPlayback[] {
  const byAsset = new Map<string, ClipPlayback>();

  for (const track of paintOrderTracks(project)) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.kind !== "video") continue;
      const local = time - clip.start;
      if (local < 0 || local >= clip.duration) continue;

      const video = clip;
      byAsset.set(video.props.assetId, {
        assetId: video.props.assetId,
        sourceTime: video.trimIn + local * video.speed,
        speed: video.speed,
        volume: video.props.volume,
        muted: video.props.muted,
      });
    }
  }

  return Array.from(byAsset.values());
}

/** 音频轨道在 `time` 时刻需要播放的剪辑参数。 */
export function audioAt(project: Project, time: Seconds): ClipPlayback[] {
  const out: ClipPlayback[] = [];

  for (const track of project.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    for (const clip of track.clips) {
      if (!clip.enabled || clip.kind !== "audio") continue;
      const local = time - clip.start;
      if (local < 0 || local >= clip.duration) continue;
      out.push({
        assetId: clip.props.assetId,
        sourceTime: clip.trimIn + local * clip.speed,
        speed: clip.speed,
        volume: clip.props.volume,
        muted: clip.props.muted,
      });
    }
  }

  return out;
}
