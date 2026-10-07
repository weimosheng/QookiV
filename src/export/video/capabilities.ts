/**
 * 导出能力探测与编码参数选择。
 *
 * 这里负责三件事：
 * 1. 探测 WebView 是否支持导出所需的编解码器（H.264 / AAC 等）；
 * 2. 根据分辨率与帧率推导 H.264 级别（Level）并给出可用的 codec 字符串候选；
 * 3. 放几个整条导出管线共用的小工具（取消错误、错误信息格式化）。
 *    这些工具放在本文件是为了让 `exportVideo.ts` 与 `audio.ts` 之间不产生循环依赖。
 *
 * 本文件除 `resolveAvcCodec` / `detectVideoCapabilities` 之外全部是纯函数，
 * 因此可以脱离浏览器环境单独验证。
 */

/* ------------------------------------------------------------------ *
 * 音频参数
 * ------------------------------------------------------------------ */

/** 导出音轨统一使用的采样率。 */
export const AUDIO_SAMPLE_RATE = 48000;
/** 导出音轨的声道数。 */
export const AUDIO_CHANNELS = 2;
/** 导出音轨的目标码率（bit/s）。 */
export const AUDIO_BITRATE = 192000;
/** AAC-LC 在 WebCodecs 中的 codec 字符串。 */
export const AAC_CODEC = "mp4a.40.2";

/* ------------------------------------------------------------------ *
 * 取消与错误工具
 * ------------------------------------------------------------------ */

/** 用户主动取消导出时使用的固定文案，UI 可据此识别取消。 */
export const EXPORT_CANCELLED_MESSAGE = "已取消导出";

/** 构造一个带 `AbortError` 名称的取消错误。 */
export function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException(EXPORT_CANCELLED_MESSAGE, "AbortError");
  }
  const error = new Error(EXPORT_CANCELLED_MESSAGE);
  error.name = "AbortError";
  return error;
}

/** 判断错误是否来自用户取消（跨 realm 安全，只检查 `name`）。 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { name?: unknown }).name === "AbortError";
}

/** 信号已中止时抛出取消错误；否则什么也不做。 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal && signal.aborted) throw createAbortError();
}

/** 把任意抛出值整理成可读的中文错误信息。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  try {
    const text = String(error);
    return text && text !== "[object Object]" ? text : "未知错误";
  } catch {
    return "未知错误";
  }
}

/* ------------------------------------------------------------------ *
 * H.264 级别
 * ------------------------------------------------------------------ */

interface AvcLevel {
  /** 级别编号：4.0 记作 40，在 codec 字符串中以十六进制出现（28）。 */
  level: number;
  /** 单帧最大宏块数（16x16）。 */
  maxMacroblocks: number;
  /** 每秒最大宏块数。 */
  maxMacroblocksPerSecond: number;
}

/** H.264 各级别的宏块约束（来自 ITU-T H.264 表 A-1）。 */
const AVC_LEVELS: AvcLevel[] = [
  { level: 30, maxMacroblocks: 1620, maxMacroblocksPerSecond: 40500 },
  { level: 31, maxMacroblocks: 3600, maxMacroblocksPerSecond: 108000 },
  { level: 32, maxMacroblocks: 5120, maxMacroblocksPerSecond: 216000 },
  { level: 40, maxMacroblocks: 8192, maxMacroblocksPerSecond: 245760 },
  { level: 41, maxMacroblocks: 8192, maxMacroblocksPerSecond: 245760 },
  { level: 42, maxMacroblocks: 8704, maxMacroblocksPerSecond: 522240 },
  { level: 50, maxMacroblocks: 22080, maxMacroblocksPerSecond: 589824 },
  { level: 51, maxMacroblocks: 36864, maxMacroblocksPerSecond: 983040 },
  { level: 52, maxMacroblocks: 36864, maxMacroblocksPerSecond: 2073600 },
  { level: 60, maxMacroblocks: 139264, maxMacroblocksPerSecond: 4177920 },
  { level: 61, maxMacroblocks: 139264, maxMacroblocksPerSecond: 8355840 },
  { level: 62, maxMacroblocks: 139264, maxMacroblocksPerSecond: 16711680 },
];

/** 满足该分辨率与帧率的最低 H.264 级别；超出表格时返回最高级别。 */
export function avcLevelFor(width: number, height: number, fps: number): number {
  const macroblockColumns = Math.ceil(Math.max(1, width) / 16);
  const macroblockRows = Math.ceil(Math.max(1, height) / 16);
  const macroblocks = macroblockColumns * macroblockRows;
  const macroblocksPerSecond = macroblocks * Math.max(1, fps);

  for (let i = 0; i < AVC_LEVELS.length; i++) {
    const level = AVC_LEVELS[i];
    if (macroblocks <= level.maxMacroblocks && macroblocksPerSecond <= level.maxMacroblocksPerSecond) {
      return level.level;
    }
  }
  return AVC_LEVELS[AVC_LEVELS.length - 1].level;
}

/**
 * AVC codec 字符串候选，按优先级排列：
 * High Profile -> Main Profile -> Main@5.0（余量兜底）-> Baseline（最大兼容）。
 * `resolveAvcCodec` 会依次用 `VideoEncoder.isConfigSupported` 探测并取第一个可用的。
 */
export function avcCodecCandidates(width: number, height: number, fps: number): string[] {
  const level = avcLevelFor(width, height, fps);
  const hex = level.toString(16).toUpperCase().padStart(2, "0");
  const candidates = [
    `avc1.6400${hex}`,
    `avc1.4d00${hex}`,
    "avc1.4d0032",
    "avc1.42E01E",
  ];
  const unique: string[] = [];
  for (const codec of candidates) {
    if (unique.indexOf(codec) < 0) unique.push(codec);
  }
  return unique;
}

/* ------------------------------------------------------------------ *
 * 能力探测
 * ------------------------------------------------------------------ */

export interface VideoCapabilities {
  /** H.264 / AVC，MP4 导出的首选。 */
  avc: boolean;
  vp9: boolean;
  av1: boolean;
  /** AAC-LC，MP4 音轨的首选。 */
  aac: boolean;
  opus: boolean;
}

export interface AvcProbeConfig {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

/** 探测单个视频编码配置；不支持或环境缺失时返回 false，绝不抛出。 */
export async function isVideoConfigSupported(config: VideoEncoderConfig): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  try {
    const support = await VideoEncoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}

/** 探测单个音频编码配置；不支持或环境缺失时返回 false，绝不抛出。 */
export async function isAudioConfigSupported(config: AudioEncoderConfig): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    const support = await AudioEncoder.isConfigSupported(config);
    return support.supported === true;
  } catch {
    return false;
  }
}

/** AAC-LC 是否可用于导出音轨。 */
export async function isAacSupported(): Promise<boolean> {
  return isAudioConfigSupported({
    codec: AAC_CODEC,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  });
}

/**
 * 依次探测 AVC 候选，返回第一个可用配置；全部不可用时返回 null。
 * 必须使用 `avc: { format: "avc" }`，这样编码器元数据里才会带 mp4-muxer 需要的 avcC。
 */
export async function resolveAvcCodec(config: AvcProbeConfig): Promise<string | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const candidates = avcCodecCandidates(config.width, config.height, config.fps);
  for (const codec of candidates) {
    const ok = await isVideoConfigSupported({
      codec,
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,
      framerate: config.fps,
      avc: { format: "avc" },
    });
    if (ok) return codec;
  }
  return null;
}

const PROBE_WIDTH = 1920;
const PROBE_HEIGHT = 1080;
const PROBE_FPS = 30;
const PROBE_VIDEO_BITRATE = 8000000;

/** 一次性探测导出所需的全部编解码能力。 */
export async function detectVideoCapabilities(): Promise<VideoCapabilities> {
  const [avc, vp9, av1, aac, opus] = await Promise.all([
    isVideoConfigSupported({
      codec: "avc1.640028",
      width: PROBE_WIDTH,
      height: PROBE_HEIGHT,
      bitrate: PROBE_VIDEO_BITRATE,
      framerate: PROBE_FPS,
      avc: { format: "avc" },
    }),
    isVideoConfigSupported({
      codec: "vp09.00.10.08",
      width: PROBE_WIDTH,
      height: PROBE_HEIGHT,
      bitrate: PROBE_VIDEO_BITRATE,
      framerate: PROBE_FPS,
    }),
    isVideoConfigSupported({
      codec: "av01.0.08M.08",
      width: PROBE_WIDTH,
      height: PROBE_HEIGHT,
      bitrate: PROBE_VIDEO_BITRATE,
      framerate: PROBE_FPS,
    }),
    isAudioConfigSupported({
      codec: AAC_CODEC,
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: AUDIO_BITRATE,
    }),
    isAudioConfigSupported({
      codec: "opus",
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: AUDIO_BITRATE,
    }),
  ]);

  return { avc, vp9, av1, aac, opus };
}
