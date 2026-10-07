/**
 * 离线视频导出：渲染 -> 编码 -> 封装 -> 可下载的 MP4。
 *
 * 与实时预览共享同一个 `Renderer`，但使用自己独立的离屏画布，并且每一帧都先
 * `await media.settle(project, t)` 等待视频元素真正 seek 到位，因此导出结果
 * 是帧精确的：what you see is what you get。
 *
 * 流程：
 *   1. prepare —— 计算导出计划（尺寸/帧率/码率/帧数/关键帧间隔）并挑选 AVC 配置；
 *   2. audio   —— 预渲染并预编码音轨（best-effort，失败降级为无声视频）；
 *   3. render  —— 逐帧 settle -> render -> VideoFrame -> VideoEncoder；
 *   4. mux     —— flush 编码器、finalize muxer、输出 Blob；
 *   5. done    —— 进度归 1。
 */

import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import type { MuxerOptions } from "mp4-muxer";
import { effectiveDuration } from "../../core/time";
import type { Project, Seconds } from "../../core/types";
import { Renderer, createRenderTarget } from "../../render/Renderer";
import type { MediaProvider } from "../../render/types";
import { collectAudibleClips, prepareAudioTrack, pushPreparedAudio } from "./audio";
import type { PreparedAudio } from "./audio";
import {
  errorMessage,
  resolveAvcCodec,
  throwIfAborted,
} from "./capabilities";

/* ------------------------------------------------------------------ *
 * 公开类型
 * ------------------------------------------------------------------ */

/**
 * 导出所需的媒体源。`src/engine/MediaPool.ts` 的 `MediaPool` 在结构上就满足它。
 *
 * 这里刻意使用结构化类型而不是直接 `import` 那个类：
 * 导出模块真正依赖的契约只有「实现 MediaProvider + 能把视频 seek 到确切时间」，
 * 这样引擎模块内部的重命名/拆分不会牵连导出模块，调用方传 `MediaPool`
 * 或它导出的单例都依然类型兼容。
 */
export interface ExportMediaSource extends MediaProvider {
  /** 把 `time` 处所有可见视频 seek 到确切源时间，并等真正解码完成（帧精确的保证）。 */
  settle(project: Project, time: Seconds): Promise<void>;
}

export interface VideoExportOptions {
  width: number;
  height: number;
  fps: number;
  /** 每秒比特数。默认按分辨率与帧率推导。 */
  bitrate?: number;
  /** 显式指定导出区间；默认整条时间线。 */
  range?: { start: number; end: number };
  includeAudio?: boolean;
  keyframeIntervalSec?: number;
  onProgress?: (progress: VideoExportProgress) => void;
  signal?: AbortSignal;
}

export interface VideoExportProgress {
  phase: "prepare" | "render" | "audio" | "mux" | "done";
  frame: number;
  totalFrames: number;
  /** 0..1 的整体进度。 */
  ratio: number;
  message: string;
}

export interface VideoExportResult {
  blob: Blob;
  bytes: number;
  frames: number;
  durationSec: number;
  hasAudio: boolean;
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 导出计划（纯函数，便于单独验证）
 * ------------------------------------------------------------------ */

export interface ExportPlan {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  /** 导出区间起点（秒，含）。 */
  start: Seconds;
  /** 导出区间终点（秒，不含）。 */
  end: Seconds;
  totalFrames: number;
  durationSec: Seconds;
  /** 每隔多少帧一个关键帧。 */
  keyframeEvery: number;
  includeAudio: boolean;
  /** 传入区间非法（被自动改为整条时间线）时为 true。 */
  rangeAdjusted: boolean;
}

/** 默认关键帧间隔（秒）。 */
const DEFAULT_KEYFRAME_INTERVAL = 2;
/** 每像素每帧的比特数，按屏幕内容（文字、UI）观感调过。 */
const BITS_PER_PIXEL_PER_FRAME = 0.12;
const MIN_BITRATE = 2000000;
const MAX_BITRATE = 80000000;
const MAX_FPS = 240;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** H.264 的 yuv420 要求宽高为偶数。 */
function evenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded - (rounded % 2);
}

/** 按分辨率与帧率推导一个合理的默认码率（bit/s）。 */
export function defaultVideoBitrate(width: number, height: number, fps: number): number {
  const pixels = Math.max(1, Math.round(width)) * Math.max(1, Math.round(height));
  const rate = Math.max(1, fps);
  const raw = pixels * rate * BITS_PER_PIXEL_PER_FRAME;
  const clamped = clampNumber(raw, MIN_BITRATE, MAX_BITRATE);
  return Math.round(clamped / 1000) * 1000;
}

/** 把用户选项与项目设置合成一份确定性的导出计划。 */
export function planExport(project: Project, options: VideoExportOptions): ExportPlan {
  const settings = project.settings;
  const fps = Math.round(
    clampNumber(finite(options.fps, finite(settings.fps, 30)), 1, MAX_FPS),
  );
  const width = evenDimension(finite(options.width, settings.width));
  const height = evenDimension(finite(options.height, settings.height));

  const full = effectiveDuration(project);
  const requestedStart = finite(options.range ? options.range.start : undefined, 0);
  const requestedEnd = finite(options.range ? options.range.end : undefined, full);
  let start = clampNumber(requestedStart, 0, full);
  let end = clampNumber(requestedEnd, 0, full);

  let rangeAdjusted = false;
  if (!(end > start)) {
    start = 0;
    end = full;
    rangeAdjusted = true;
  }

  const totalFrames = Math.max(1, Math.round((end - start) * fps));
  const requestedKeyframe = clampNumber(
    finite(options.keyframeIntervalSec, DEFAULT_KEYFRAME_INTERVAL),
    0.1,
    60,
  );
  const requestedBitrate = finite(options.bitrate, 0);

  return {
    width,
    height,
    fps,
    bitrate:
      requestedBitrate > 0
        ? Math.round(requestedBitrate)
        : defaultVideoBitrate(width, height, fps),
    start,
    end,
    totalFrames,
    durationSec: totalFrames / fps,
    keyframeEvery: Math.max(1, Math.round(requestedKeyframe * fps)),
    includeAudio: options.includeAudio !== false,
    rangeAdjusted,
  };
}

/* ------------------------------------------------------------------ *
 * 进度权重
 * ------------------------------------------------------------------ */

const RATIO_PREPARE = 0.02;
const RATIO_AUDIO_END = 0.12;
const RATIO_RENDER_END = 0.95;
const RATIO_MUX_END = 0.99;

/* ------------------------------------------------------------------ *
 * 导出
 * ------------------------------------------------------------------ */

export async function exportVideo(
  project: Project,
  media: ExportMediaSource,
  options: VideoExportOptions,
): Promise<VideoExportResult> {
  const warnings: string[] = [];
  const signal = options.signal;
  throwIfAborted(signal);

  let lastRatio = 0;
  const report = (
    phase: VideoExportProgress["phase"],
    frame: number,
    totalFrames: number,
    ratio: number,
    message: string,
  ): void => {
    if (!options.onProgress) return;
    // 进度只增不减，避免 UI 抖动。
    const safeRatio = Math.min(1, Math.max(lastRatio, clampNumber(ratio, 0, 1)));
    lastRatio = safeRatio;
    try {
      options.onProgress({
        phase,
        frame,
        totalFrames,
        ratio: safeRatio,
        message,
      });
    } catch {
      // 进度回调不应该影响导出。
    }
  };

  const plan = planExport(project, options);
  if (plan.rangeAdjusted) warnings.push("导出范围无效，已改为整条时间线。");

  report("prepare", 0, plan.totalFrames, 0, "正在准备导出…");

  if (typeof VideoEncoder === "undefined") {
    throw new Error("当前环境不支持 WebCodecs（VideoEncoder 不可用），无法导出 MP4 视频。");
  }

  const codec = await resolveAvcCodec({
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    bitrate: plan.bitrate,
  });
  if (!codec) {
    throw new Error(
      "未找到可用的 H.264 (AVC) 编码器配置，无法导出 MP4 视频。请更新系统或显卡驱动后重试。",
    );
  }
  throwIfAborted(signal);
  report("prepare", 0, plan.totalFrames, RATIO_PREPARE, "正在准备编码器…");

  /* ---- 音轨：必须先于 muxer 构造完成，才能决定是否声明音频轨道 ---- */
  let preparedAudio: PreparedAudio | null = null;
  if (plan.includeAudio) {
    const clips = collectAudibleClips(project);
    if (clips.length > 0) {
      report("audio", 0, plan.totalFrames, RATIO_PREPARE, "正在混音并编码音频…");
      preparedAudio = await prepareAudioTrack(project, {
        clips,
        rangeStart: plan.start,
        durationSec: plan.durationSec,
        warnings,
        signal,
      });
    }
  }
  const hasAudio = preparedAudio !== null && preparedAudio.chunks.length > 0;
  throwIfAborted(signal);

  /* ---- 封装器 ---- */
  const target = new ArrayBufferTarget();
  const muxerOptions: MuxerOptions<ArrayBufferTarget> = {
    target,
    video: {
      codec: "avc",
      width: plan.width,
      height: plan.height,
      frameRate: plan.fps,
    },
    fastStart: "in-memory",
  };
  if (hasAudio && preparedAudio) {
    muxerOptions.audio = {
      codec: "aac",
      numberOfChannels: preparedAudio.numberOfChannels,
      sampleRate: preparedAudio.sampleRate,
    };
  }
  const muxer = new Muxer(muxerOptions);
  if (hasAudio && preparedAudio) pushPreparedAudio(muxer, preparedAudio);

  /* ---- 编码器 ---- */
  const encoderErrors: Error[] = [];
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (error) {
        encoderErrors.push(new Error(errorMessage(error)));
      }
    },
    error: (error) => {
      encoderErrors.push(new Error(errorMessage(error)));
    },
  });
  encoder.configure({
    codec,
    width: plan.width,
    height: plan.height,
    bitrate: plan.bitrate,
    framerate: plan.fps,
    latencyMode: "quality",
    avc: { format: "avc" },
  });

  /* ---- 渲染目标：始终是导出流程自己的画布，绝不用预览的画布 ---- */
  const renderCanvas = createRenderTarget(project);
  const renderCtx = renderCanvas.getContext("2d", { alpha: false });
  if (!renderCtx) throw new Error("无法创建导出用的 2D 画布上下文。");

  const needsScale = renderCanvas.width !== plan.width || renderCanvas.height !== plan.height;
  let frameCanvas: HTMLCanvasElement = renderCanvas;
  let scaleCtx: CanvasRenderingContext2D | null = null;
  if (needsScale) {
    const scaled = document.createElement("canvas");
    scaled.width = plan.width;
    scaled.height = plan.height;
    scaleCtx = scaled.getContext("2d", { alpha: false });
    if (!scaleCtx) throw new Error("无法创建导出缩放用的 2D 画布上下文。");
    frameCanvas = scaled;
  }

  const renderer = new Renderer(project, media);
  const frameDurationMicros = Math.round(1000000 / plan.fps);

  try {
    for (let index = 0; index < plan.totalFrames; index++) {
      throwIfAborted(signal);
      if (encoderErrors.length > 0) throw encoderErrors[0];

      const time = plan.start + index / plan.fps;
      await media.settle(project, time);
      throwIfAborted(signal);

      renderer.renderFrame(renderCtx, time, { quality: "export" });
      if (needsScale && scaleCtx) {
        scaleCtx.drawImage(renderCanvas, 0, 0, plan.width, plan.height);
      }

      const frame = new VideoFrame(frameCanvas, {
        timestamp: Math.round((index * 1000000) / plan.fps),
        duration: frameDurationMicros,
      });
      encoder.encode(frame, { keyFrame: index % plan.keyframeEvery === 0 });
      frame.close();

      if (encoder.encodeQueueSize > 8) {
        await waitForEncoderQueue(encoder, encoderErrors);
      } else if (index % 4 === 0) {
        await yieldToEventLoop();
      }
      if (encoderErrors.length > 0) throw encoderErrors[0];

      report(
        "render",
        index + 1,
        plan.totalFrames,
        RATIO_AUDIO_END +
          (RATIO_RENDER_END - RATIO_AUDIO_END) * ((index + 1) / plan.totalFrames),
        `正在渲染第 ${index + 1} / ${plan.totalFrames} 帧`,
      );
    }

    report("mux", plan.totalFrames, plan.totalFrames, RATIO_RENDER_END, "正在完成视频编码…");
    await encoder.flush();
    if (encoderErrors.length > 0) throw encoderErrors[0];
  } catch (error) {
    if (encoder.state !== "closed") {
      try {
        encoder.close();
      } catch {
        // 已经进入错误状态时忽略关闭异常。
      }
    }
    throw error;
  }

  if (encoder.state !== "closed") encoder.close();
  throwIfAborted(signal);

  report("mux", plan.totalFrames, plan.totalFrames, RATIO_MUX_END, "正在封装 MP4 文件…");
  muxer.finalize();

  const buffer = target.buffer;
  const blob = new Blob([buffer], { type: "video/mp4" });
  if (blob.size <= 0) throw new Error("导出失败：生成的 MP4 数据为空。");

  report("done", plan.totalFrames, plan.totalFrames, 1, "导出完成");
  return {
    blob,
    bytes: blob.size,
    frames: plan.totalFrames,
    durationSec: plan.durationSec,
    hasAudio,
    warnings,
  };
}

/** 编码队列过长时等待出队事件，超时兜底以免卡死。 */
async function waitForEncoderQueue(
  encoder: VideoEncoder,
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
