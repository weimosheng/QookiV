/**
 * 导出音轨：把时间线上的音频混成一条 48kHz / 立体声 PCM，再编码成 AAC。
 *
 * 设计要点：
 * - 音频永远是「尽力而为」：任何一步失败都只记一条中文警告并降级为无声视频，
 *   绝不因为音频问题让整个导出失败（用户取消除外）。
 * - 先把 AAC 数据全部编码进内存，再由调用方决定是否在 `Muxer` 里声明音轨。
 *   mp4-muxer 的轨道配置在构造时就固定了，只有这样做才能在失败时彻底去掉音轨。
 * - 解码优先走 `fetch(asset.src)` + `decodeAudioData`，比播放元素更可靠。
 */

import { sampleNumber } from "../../core/animation";
import { findAsset } from "../../core/project";
import type { AnimationMap, Project, Seconds } from "../../core/types";
import type { ArrayBufferTarget, Muxer } from "mp4-muxer";
import {
  AAC_CODEC,
  AUDIO_BITRATE,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  errorMessage,
  isAacSupported,
  isAbortError,
  throwIfAborted,
} from "./capabilities";

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

/** 音量包络上的一个采样点（时间为片段内相对时间）。 */
export interface VolumePoint {
  time: Seconds;
  value: number;
}

/** 时间线上参与混音的一段音频（已把片段参数换算成时间线坐标）。 */
export interface AudibleClip {
  clipId: string;
  name: string;
  assetId: string;
  /** 时间线上的起点（秒）。 */
  start: Seconds;
  /** 时间线上的长度（秒）。 */
  duration: Seconds;
  /** 源媒体的入点（秒）。 */
  trimIn: Seconds;
  /** 播放速度倍率，1 为原速。 */
  speed: number;
  /** 基础增益，0..1 为衰减。 */
  volume: number;
  /**
   * 音量包络。为空时使用常量 `volume`；非空时逐点写入增益自动化。
   *
   * 音量关键帧必须走这条路：把 `props.volume` 当成常量会让淡入淡出在导出里彻底
   * 失效（预览听得到、成片听不到，是最难查的一类问题）。
   */
  envelope: VolumePoint[];
}

/** 包络采样步长（秒）。10ms 足以精确表达任何缓动曲线。 */
const ENVELOPE_STEP = 0.01;

/**
 * 把某个片段的音量关键帧采样成包络。
 *
 * 纯函数，便于断言。没有关键帧时返回空数组，调用方回退到常量增益。
 */
export function buildVolumeEnvelope(
  animation: AnimationMap,
  duration: Seconds,
  baseVolume: number,
): VolumePoint[] {
  const frames = animation["props.volume"];
  if (!frames || frames.length === 0) return [];

  const points: VolumePoint[] = [];
  const last = Math.max(0, duration);
  for (let time = 0; time < last - 1e-9; time += ENVELOPE_STEP) {
    points.push({ time, value: sampleNumber(animation, "props.volume", time, baseVolume) });
  }
  // Always close the envelope on the clip's end so the fade actually completes.
  points.push({ time: last, value: sampleNumber(animation, "props.volume", last, baseVolume) });
  return points;
}

/** 一段已编码的 AAC 数据。 */
export interface PreparedAudioChunk {
  chunk: EncodedAudioChunk;
  meta?: EncodedAudioChunkMetadata;
}

/** 预编码完成的音轨；只有它是非 null 且含数据时才在 MP4 里声明音轨。 */
export interface PreparedAudio {
  chunks: PreparedAudioChunk[];
  sampleRate: number;
  numberOfChannels: number;
  durationSec: Seconds;
}

export interface PrepareAudioOptions {
  clips: AudibleClip[];
  /** 导出区间在时间线上的起点（秒），用于对齐画面。 */
  rangeStart: Seconds;
  /** 需要渲染的时长（秒），即导出区间长度。 */
  durationSec: Seconds;
  /** 警告收集器（音频问题只警告，不抛出）。 */
  warnings: string[];
  signal?: AbortSignal;
}

interface AudioSourceEntry {
  /** 解析到的资源地址，空串表示资源缺失。 */
  src: string;
  label: string;
}

/* ------------------------------------------------------------------ *
 * 片段收集（纯函数）
 * ------------------------------------------------------------------ */

/**
 * 收集所有应该发声的片段：
 * - 未静音的音频轨道上的音频片段；
 * - 未静音、未静音轨且未静音的视频片段自带的音频。
 *
 * 隐藏的可视轨道（`track.hidden`）与预览行为保持一致：其视频音频也不发声。
 */
export function collectAudibleClips(project: Project): AudibleClip[] {
  const out: AudibleClip[] = [];

  for (const track of project.tracks) {
    if (track.kind === "audio") {
      if (track.muted) continue;
      for (const clip of track.clips) {
        if (clip.kind !== "audio") continue;
        if (!clip.enabled) continue;
        if (!clip.props.assetId) continue;
        if (clip.duration <= 0) continue;
        const envelope = buildVolumeEnvelope(clip.animation, clip.duration, clip.props.volume);
        // With a volume envelope a base value of 0 is legitimate (a fade-in
        // starts there), so only the constant case may be skipped.
        if (envelope.length === 0 && clip.props.volume <= 0) continue;
        if (!hasUsableAudio(project, clip.props.assetId)) continue;
        out.push({
          clipId: clip.id,
          name: clip.name,
          assetId: clip.props.assetId,
          start: clip.start,
          duration: clip.duration,
          trimIn: clip.trimIn,
          speed: clip.speed,
          volume: clip.props.volume,
          envelope,
        });
      }
      continue;
    }

    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.kind !== "video") continue;
      if (!clip.enabled) continue;
      if (!clip.props.assetId) continue;
      if (clip.props.muted) continue;
      if (clip.duration <= 0) continue;
      const envelope = buildVolumeEnvelope(clip.animation, clip.duration, clip.props.volume);
      if (envelope.length === 0 && clip.props.volume <= 0) continue;
      if (!hasUsableAudio(project, clip.props.assetId)) continue;
      out.push({
        clipId: clip.id,
        name: clip.name,
        assetId: clip.props.assetId,
        start: clip.start,
        duration: clip.duration,
        trimIn: clip.trimIn,
        speed: clip.speed,
        volume: clip.props.volume,
        envelope,
      });
    }
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** 资源明确声明没有音轨时直接跳过，避免无谓的解码告警。 */
function hasUsableAudio(project: Project, assetId: string): boolean {
  const asset = findAsset(project, assetId);
  if (!asset) return false;
  return asset.hasAudio !== false;
}

/* ------------------------------------------------------------------ *
 * 混音
 * ------------------------------------------------------------------ */

/** 把一个资源文件解码成 AudioBuffer；失败时抛出。 */
async function decodeAsset(context: BaseAudioContext, src: string): Promise<AudioBuffer> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`无法读取音频文件（HTTP ${response.status}）`);
  const bytes = await response.arrayBuffer();
  return await context.decodeAudioData(bytes);
}

/**
 * 用 OfflineAudioContext 把时间线区间渲染成一条 PCM 缓冲。
 * 越界的片段（在导出区间之外的头部/尾部）会被裁掉，并正确换算源媒体偏移。
 */
async function renderTimelineAudio(
  project: Project,
  clips: AudibleClip[],
  options: PrepareAudioOptions,
): Promise<AudioBuffer> {
  const sources = new Map<string, AudioSourceEntry>();
  for (const clip of clips) {
    if (sources.has(clip.assetId)) continue;
    const asset = findAsset(project, clip.assetId);
    if (!asset || !asset.src) {
      options.warnings.push(`未找到音频资源：${clip.name}，已跳过该片段。`);
      sources.set(clip.assetId, { src: "", label: clip.name });
      continue;
    }
    sources.set(clip.assetId, { src: asset.src, label: asset.name || clip.name });
  }

  const sampleRate = AUDIO_SAMPLE_RATE;
  const channels = AUDIO_CHANNELS;
  const frames = Math.max(1, Math.ceil(options.durationSec * sampleRate));
  const context = new OfflineAudioContext(channels, frames, sampleRate);
  const rangeEnd = options.rangeStart + options.durationSec;
  const cache = new Map<string, AudioBuffer | null>();

  for (const clip of clips) {
    throwIfAborted(options.signal);

    const entry = sources.get(clip.assetId);
    if (!entry || !entry.src) continue;

    let decoded = cache.get(clip.assetId);
    if (decoded === undefined) {
      try {
        decoded = await decodeAsset(context, entry.src);
      } catch (error) {
        decoded = null;
        options.warnings.push(
          `音频解码失败：${entry.label}（${errorMessage(error)}），已跳过该资源。`,
        );
      }
      cache.set(clip.assetId, decoded);
    }
    if (!decoded) continue;

    const from = Math.max(clip.start, options.rangeStart);
    const to = Math.min(clip.start + clip.duration, rangeEnd);
    if (to - from <= 0.0001) continue;

    const speed = clip.speed > 0 ? clip.speed : 1;
    const offset = clip.trimIn + (from - clip.start) * speed;
    if (offset >= decoded.duration) continue;

    const playLength = Math.min((to - from) * speed, decoded.duration - offset);
    if (playLength <= 0) continue;

    const source = context.createBufferSource();
    source.buffer = decoded;
    source.playbackRate.value = speed;

    const gain = context.createGain();
    const clampGain = (value: number) => Math.min(4, Math.max(0, value));

    if (clip.envelope.length > 0) {
      // Automation runs in context time, which here *is* timeline time, so the
      // clip-local envelope offsets by however much of the head was cropped.
      const audibleStart = from - options.rangeStart;
      const localFrom = from - clip.start;
      const localTo = to - clip.start;

      let started = false;
      for (const point of clip.envelope) {
        if (point.time < localFrom - 1e-6) continue;
        if (point.time > localTo + 1e-6) break;
        const when = audibleStart + (point.time - localFrom);
        if (!started) {
          gain.gain.setValueAtTime(clampGain(point.value), when);
          started = true;
        } else {
          gain.gain.linearRampToValueAtTime(clampGain(point.value), when);
        }
      }
      if (!started) gain.gain.value = clampGain(clip.volume);
    } else {
      gain.gain.value = clampGain(clip.volume);
    }

    source.connect(gain);
    gain.connect(context.destination);
    source.start(from - options.rangeStart, Math.max(0, offset), playLength);
  }

  return await context.startRendering();
}

/* ------------------------------------------------------------------ *
 * AAC 编码
 * ------------------------------------------------------------------ */

const AUDIO_CHUNK_FRAMES = 1024;

/** 把 PCM 缓冲切成约 1024 帧的 AudioData，逐块交给 AudioEncoder。 */
async function encodeAudioTrack(
  buffer: AudioBuffer,
  options: PrepareAudioOptions,
): Promise<PreparedAudioChunk[]> {
  const errors: Error[] = [];
  const chunks: PreparedAudioChunk[] = [];
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta) chunks.push({ chunk, meta });
      else chunks.push({ chunk });
    },
    error: (error) => {
      errors.push(new Error(errorMessage(error)));
    },
  });

  encoder.configure({
    codec: AAC_CODEC,
    sampleRate,
    numberOfChannels: channels,
    bitrate: AUDIO_BITRATE,
  });

  const total = buffer.length;
  // f32-planar 的排布是「每个声道连续存放」，与 AudioBuffer 的声道布局一致。
  const scratch = new Float32Array(AUDIO_CHUNK_FRAMES * channels);

  try {
    for (let start = 0; start < total; start += AUDIO_CHUNK_FRAMES) {
      throwIfAborted(options.signal);
      if (errors.length > 0) break;

      const count = Math.min(AUDIO_CHUNK_FRAMES, total - start);
      const fallback = buffer.getChannelData(0);
      for (let channel = 0; channel < channels; channel++) {
        const data = channel < buffer.numberOfChannels ? buffer.getChannelData(channel) : fallback;
        scratch.set(data.subarray(start, start + count), channel * count);
      }

      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((start * 1000000) / sampleRate),
        data: scratch.subarray(0, count * channels),
      });

      encoder.encode(audioData);
      audioData.close();

      await drainAudioEncoder(encoder, errors);
      // 定期让出主线程，保证导出过程中界面不卡死。
      if (start % (AUDIO_CHUNK_FRAMES * 16) === 0) await yieldToEventLoop();
    }

    if (errors.length === 0) await encoder.flush();
  } finally {
    if (encoder.state !== "closed") {
      try {
        encoder.close();
      } catch {
        // 关闭失败不影响导出结果。
      }
    }
  }

  if (errors.length > 0) throw errors[0];
  return chunks;
}

/** 编码队列过长时等待出队，避免内存无上限增长。 */
async function drainAudioEncoder(
  encoder: AudioEncoder,
  errors: Error[],
): Promise<void> {
  while (encoder.encodeQueueSize > 8 && errors.length === 0) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        encoder.removeEventListener("dequeue", finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 50);
      encoder.addEventListener("dequeue", finish);
    });
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 预渲染并预编码音轨。
 *
 * 返回 null 表示「本次导出没有音轨」：可能是没有可用片段、环境不支持 AAC，
 * 或者音频链路任意一步失败。失败原因会写入 `options.warnings`。
 * 用户取消（AbortError）会原样向上抛出，由 `exportVideo` 统一处理。
 */
export async function prepareAudioTrack(
  project: Project,
  options: PrepareAudioOptions,
): Promise<PreparedAudio | null> {
  if (options.clips.length === 0) return null;

  if (!(await isAacSupported())) {
    options.warnings.push("当前环境不支持 AAC 音频编码，已导出无声视频。");
    return null;
  }

  try {
    const buffer = await renderTimelineAudio(project, options.clips, options);
    if (buffer.length <= 0) {
      options.warnings.push("音频混音结果为空，已导出无声视频。");
      return null;
    }

    const chunks = await encodeAudioTrack(buffer, options);
    if (chunks.length === 0) {
      options.warnings.push("音频编码没有产生任何数据，已导出无声视频。");
      return null;
    }

    return {
      chunks,
      sampleRate: buffer.sampleRate,
      numberOfChannels: buffer.numberOfChannels,
      durationSec: buffer.duration,
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    options.warnings.push(`音频处理失败：${errorMessage(error)}，已导出无声视频。`);
    return null;
  }
}

/** 把预编码好的音轨写入 muxer（必须在构造 muxer 时已声明 audio 轨道）。 */
export function pushPreparedAudio(
  muxer: Muxer<ArrayBufferTarget>,
  prepared: PreparedAudio,
): void {
  for (const item of prepared.chunks) {
    if (item.meta) muxer.addAudioChunk(item.chunk, item.meta);
    else muxer.addAudioChunk(item.chunk);
  }
}
