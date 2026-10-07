import { invoke } from "@tauri-apps/api/core";
import type { Project } from "../../core/types";
import type { Asset } from "../../core/types";

/**
 * HTML 导出用的通用工具。
 *
 * 这里的函数要么是纯函数，要么只在"读不到就返回 null"的前提下接触外部资源，
 * 因此可以单独推理、单独测试：导出器不依赖它们抛异常来表达失败。
 */

/* ------------------------------------------------------------------ *
 * 引用关系
 * ------------------------------------------------------------------ */

/**
 * 项目里被任意剪辑引用到的素材（图片/视频/音频剪辑，以及 device 剪辑里的
 * 截图）。未被引用的素材不会进入导出产物，避免把整包素材都塞进网页。
 */
export function assetsUsedByProject(project: Project): Asset[] {
  const used = new Set<string>();

  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.kind === "image" || clip.kind === "video" || clip.kind === "audio") {
        if (clip.props.assetId) used.add(clip.props.assetId);
      } else if (clip.kind === "device") {
        if (clip.props.assetId) used.add(clip.props.assetId);
      }
    }
  }

  if (used.size === 0) return [];
  return project.assets.filter((asset) => used.has(asset.id));
}

/* ------------------------------------------------------------------ *
 * 路径 / MIME
 * ------------------------------------------------------------------ */

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  weba: "audio/webm",
  json: "application/json",
  txt: "text/plain;charset=utf-8",
};

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/ogg": "ogv",
  "video/x-msvideo": "avi",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "application/json": "json",
  "text/plain": "txt",
  "text/html": "html",
  "application/pdf": "pdf",
};

const DATA_URL_RE = /^data:([^,;]+)?(;base64)?,/i;

/** 去掉查询串/哈希并统一成 `/` 分隔，便于按扩展名判断。 */
function normalizePathLike(value: string): string {
  const cut = value.search(/[?#]/);
  const bare = cut >= 0 ? value.slice(0, cut) : value;
  return bare.replace(/\\/g, "/");
}

/** 小写扩展名（不含点）；没有或不像扩展名时返回空串。 */
function extensionOf(path: string): string {
  const bare = normalizePathLike(path);
  const last = bare.slice(bare.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot <= 0 || dot === last.length - 1) return "";
  const ext = last.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/** 从 `data:` URL 头部取 MIME；不是 data URL 时返回空串。 */
function mimeOfDataUrl(value: string): string {
  const match = DATA_URL_RE.exec(value);
  if (!match) return "";
  const mime = (match[1] ?? "").trim().toLowerCase();
  return mime === "text/plain" ? "" : mime;
}

export function mimeForPath(path: string): string {
  if (!path) return "application/octet-stream";
  const dataMime = mimeOfDataUrl(path);
  if (dataMime) return dataMime;
  const ext = extensionOf(path);
  if (!ext) return "application/octet-stream";
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** 扩展名（不含点，小写）；无法判断时返回 `"bin"`。 */
export function extensionForPath(path: string): string {
  const dataMime = mimeOfDataUrl(path);
  if (dataMime) {
    const known = EXTENSION_BY_MIME[dataMime];
    if (known) return known;
    const tail = dataMime.slice(dataMime.indexOf("/") + 1);
    return /^[a-z0-9]+$/.test(tail) ? tail : "bin";
  }

  const ext = extensionOf(path);
  if (ext) return MIME_BY_EXTENSION[ext] ? ext : "bin";

  const mime = mimeForPath(path);
  const known = EXTENSION_BY_MIME[mime];
  return known ?? "bin";
}

/* ------------------------------------------------------------------ *
 * Base64 / Data URL
 * ------------------------------------------------------------------ */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CHUNK = 0x8000;

/**
 * 手写 base64，避免依赖 `btoa` 对二进制字符串的坑。
 *
 * 分块只是为了让超长循环体不至于一次拼接过多字符串；每一块都截断到 3 的
 * 倍数，块与块之间不会出现半个三元组，`=` 填充只在最后一个字节处发生。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const size = bytes.length;
  let out = "";
  let start = 0;

  while (start < size) {
    let end = Math.min(start + BASE64_CHUNK, size);
    // 非最后一块收在 3 的倍数上，剩下的 1~2 个字节留给下一轮。
    if (end < size) end -= (end - start) % 3;
    let chunk = "";

    for (let j = start; j < end; j += 3) {
      const b0 = bytes[j];
      const b1 = j + 1 < size ? bytes[j + 1] : 0;
      const b2 = j + 2 < size ? bytes[j + 2] : 0;
      const triple = (b0 << 16) | (b1 << 8) | b2;
      chunk += BASE64_ALPHABET[(triple >> 18) & 63];
      chunk += BASE64_ALPHABET[(triple >> 12) & 63];
      chunk += j + 1 < size ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
      chunk += j + 2 < size ? BASE64_ALPHABET[triple & 63] : "=";
    }

    out += chunk;
    start = end;
  }

  return out;
}

export function base64ToDataUrl(base64: string, mime: string): string {
  const type = mime || "application/octet-stream";
  return `data:${type};base64,${base64}`;
}

/* ------------------------------------------------------------------ *
 * 读取素材
 * ------------------------------------------------------------------ */

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value);
}

function stripDataUrl(base64: string): string {
  const comma = base64.indexOf(",");
  if (comma < 0) return base64;
  return base64.slice(comma + 1).replace(/\s/g, "");
}

function utf8ToBase64(text: string): string {
  if (typeof TextEncoder !== "function") return "";
  return bytesToBase64(new TextEncoder().encode(text));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve) => {
    if (typeof FileReader !== "function") {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(typeof result === "string" ? stripDataUrl(result) : "");
    };
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

/** 读取到的素材内容：base64 字节 + 能推断出的 MIME。 */
export interface AssetMedia {
  base64: string;
  mime: string;
}

/** `fetch` 任意素材地址；同时尽力从响应头拿到准确 MIME。 */
async function fetchAsMedia(url: string): Promise<AssetMedia | null> {
  if (typeof fetch !== "function" || !url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    // 开发服务器对未知路径会返回 index.html，这绝不能当成素材。
    if (/^text\/html/i.test(contentType)) return null;
    const blob = await response.blob();
    const base64 = await blobToBase64(blob);
    if (!base64) return null;
    return { base64, mime: mimeOfDataUrl(url) || contentType };
  } catch {
    return null;
  }
}

/** 把 `asset://localhost/<encodeURIComponent(path)>` 还原成本地路径。 */
function pathFromAssetProtocol(src: string): string {
  const match = /^asset:\/\/[^/]*\/(.+)$/i.exec(src);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 读取素材内容（base64 + MIME）。
 *
 * 顺序：已经是 data URL 就直接用 → 有本地路径走 Tauri 读盘 → 其余交给 `fetch`
 * （相对路径、`/brand/...`、`asset://` 协议）。任何一步失败都返回 `null`，
 * 由调用方决定是告警还是保留原 `src`。
 */
export async function readAssetMedia(asset: Asset): Promise<AssetMedia | null> {
  const src = asset.src ?? "";

  // 导出场景下 data URL 就是终态，直接复用，省掉一次解码再编码。
  if (isDataUrl(src)) {
    const payload = stripDataUrl(src);
    if (payload.length === 0) return null;
    return { base64: payload, mime: mimeOfDataUrl(src) };
  }

  if (asset.path) {
    try {
      const base64 = await invoke<string>("read_binary_base64", { path: asset.path });
      if (typeof base64 === "string" && base64.length > 0) {
        return { base64: stripDataUrl(base64), mime: mimeForPath(asset.path) };
      }
    } catch {
      // 路径可能已经失效（素材被移动/删除），继续尝试 src。
    }
  }

  if (!src) return null;

  if (src.startsWith("/") || src.startsWith(".") || /^https?:\/\//i.test(src)) {
    return await fetchAsMedia(src);
  }

  if (/^asset:\/\//i.test(src)) {
    const localPath = pathFromAssetProtocol(src);
    if (localPath) {
      try {
        const base64 = await invoke<string>("read_binary_base64", { path: localPath });
        if (typeof base64 === "string" && base64.length > 0) {
          return { base64: stripDataUrl(base64), mime: mimeForPath(localPath) };
        }
      } catch {
        // 继续尝试把协议 URL 本身当路径读。
      }
    }
    try {
      const text = await invoke<string>("read_text_file", { path: src });
      const encoded = text ? utf8ToBase64(text) : "";
      if (encoded) return { base64: encoded, mime: mimeForPath(src) };
    } catch {
      return null;
    }
  }

  return null;
}

/** 读取素材的 base64 内容；读不到返回 `null`（不抛异常）。 */
export async function readAssetBase64(asset: Asset): Promise<string | null> {
  const media = await readAssetMedia(asset);
  return media ? media.base64 : null;
}

/**
 * 解析素材应该使用的 MIME。
 *
 * 优先级：候选地址里的 data URL 头 → 候选地址的扩展名（asset.path 优先，
 * 再退到 src）→ 读取资源时对方声明的类型 → 按素材种类兜底（有些导入路径
 * 既没有扩展名也没有 Content-Type）。
 */
export function resolveMime(asset: Asset, candidates: string[], declared?: string): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const fromData = mimeOfDataUrl(candidate);
    if (fromData) return fromData;
    const ext = extensionOf(candidate);
    if (ext && MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  }

  if (declared && declared !== "application/octet-stream" && declared !== "text/plain") {
    return declared;
  }

  if (asset.kind === "image") return "image/png";
  if (asset.kind === "video") return "video/mp4";
  if (asset.kind === "audio") return "audio/mpeg";
  return "application/octet-stream";
}

/** folder 模式的文件扩展名：优先沿用原始地址，其次按已解析的 MIME 推断。 */
export function extensionForAsset(asset: Asset, mime: string): string {
  const candidates = [asset.path || "", asset.src || ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ext = extensionForPath(candidate);
    if (ext !== "bin") return ext;
  }

  const fromMime = EXTENSION_BY_MIME[mime] ?? "";
  if (fromMime) return fromMime;

  const tail = mime.slice(mime.indexOf("/") + 1);
  return /^[a-z0-9]{1,8}$/.test(tail) ? tail : "bin";
}

/** 生成安全的文件名（扩展名之外的部分）。 */
export function sanitizeFileStem(value: string, fallback: string): string {
  const cleaned = (value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

/* ------------------------------------------------------------------ *
 * 安全序列化
 * ------------------------------------------------------------------ */

/**
 * 序列化内联脚本里的数据。
 *
 * `<`、`>`、`&`、U+2028/U+2029 全部转成 `\uXXXX`，因此任何媒体名、文案甚至
 * 恶意字符串都不可能提前闭合 `</script>` 或注入新标签。
 */
export function serializeForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
