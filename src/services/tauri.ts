import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";

/**
 * Thin wrapper over the Rust commands.
 *
 * Every call degrades gracefully: when the app is served in a plain browser
 * (during `vite dev` without Tauri) the helpers fall back to browser APIs so the
 * editor stays usable for UI work.
 */

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/* ------------------------------------------------------------------ *
 * Paths & URLs
 * ------------------------------------------------------------------ */

/** Converts an absolute OS path into a URL the webview can load media from. */
export async function toAssetUrl(path: string): Promise<string> {
  if (!isTauri()) return path;
  try {
    return await invoke<string>("to_asset_url", { path });
  } catch {
    return path;
  }
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Joins path segments with the correct separator for the current platform. */
export function joinPath(...segments: string[]): string {
  const sep = isWindowsPath(segments[0] ?? "") ? "\\" : "/";
  return segments
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, "") : s.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/* ------------------------------------------------------------------ *
 * File IO
 * ------------------------------------------------------------------ */

export async function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

export async function writeTextFile(path: string, contents: string): Promise<void> {
  await invoke("write_text_file", { path, contents });
}

/**
 * Writes a base64 payload as binary.
 *
 * Intended for small files only (bundled icons, fonts): the payload crosses the
 * IPC bridge as a JSON array. For large media prefer `copyFile` or
 * `writeBase64File`.
 */
export async function writeBinaryBase64(path: string, base64: string): Promise<void> {
  const data = base64ToBytes(base64);
  await invoke("write_binary_file", { path, data: Array.from(data) });
}

/**
 * Writes a base64 payload as binary, decoding on the Rust side.
 *
 * This is the path for large artefacts such as an exported MP4: the payload
 * stays a single string across IPC instead of becoming an array with one JSON
 * number per byte.
 */
export async function writeBase64File(path: string, base64: string): Promise<void> {
  await invoke("write_base64_file", { path, data: base64 });
}

/** Reads a Blob as bare base64 (no `data:` prefix). */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取导出数据失败"));
    reader.readAsDataURL(blob);
  });
}

/** Writes a Blob to disk, decoding it on the Rust side. */
export async function writeBlob(path: string, blob: Blob): Promise<void> {
  await writeBase64File(path, await blobToBase64(blob));
}

export async function copyFile(source: string, destination: string): Promise<void> {
  await invoke("copy_file", { src: source, dest: destination });
}

export async function ensureDir(path: string): Promise<void> {
  await invoke("ensure_dir", { path });
}

export async function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

export async function fileSize(path: string): Promise<number> {
  return invoke<number>("file_size", { path });
}

export async function revealInExplorer(path: string): Promise<void> {
  await invoke("reveal_in_explorer", { path });
}

/* ------------------------------------------------------------------ *
 * Window controls
 * ------------------------------------------------------------------ */

export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().close();
}

/**
 * 设置窗口逻辑尺寸（与 DPI 无关）。
 *
 * 主页用紧凑窗口，编辑器用大窗口——切换 view 时调用，让窗口贴合当前界面。
 */
export async function setWindowSize(width: number, height: number): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setSize(new LogicalSize(width, height));
}

/** 设置窗口最小尺寸。编辑器需要比主页更大的最小尺寸才好用。 */
export async function setMinWindowSize(width: number, height: number): Promise<void> {
  if (!isTauri()) return;
  await getCurrentWindow().setMinSize(new LogicalSize(width, height));
}

/* ------------------------------------------------------------------ *
 * On-disk autosave mirror
 * ------------------------------------------------------------------ */

export async function writeAutosaveFile(contents: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("write_autosave_file", { contents });
  } catch {
    // Best-effort backup; a failed disk write must not break editing.
  }
}

export async function readAutosaveFile(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("read_autosave_file");
  } catch {
    return null;
  }
}

export async function clearAutosaveFile(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("clear_autosave_file");
  } catch {
    // Nothing to do: a leftover draft simply gets overwritten next time.
  }
}

export async function writeRecentFile(contents: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("write_recent_file", { contents });
  } catch {
    // Best-effort; the localStorage mirror still holds the list.
  }
}

export async function readRecentFile(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string | null>("read_recent_file");
  } catch {
    return null;
  }
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ------------------------------------------------------------------ *
 * Dialogs
 * ------------------------------------------------------------------ */

export const MEDIA_FILTERS: FileFilter[] = [
  { name: "媒体文件", extensions: ["mp4", "mov", "webm", "mkv", "m4v", "png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "mp3", "wav", "aac", "m4a", "ogg", "flac"] },
  { name: "视频", extensions: ["mp4", "mov", "webm", "mkv", "m4v"] },
  { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] },
  { name: "音频", extensions: ["mp3", "wav", "aac", "m4a", "ogg", "flac"] },
];

export const PROJECT_FILTERS: FileFilter[] = [{ name: "QookiV 工程", extensions: ["qookiv", "json"] }];

export async function pickMediaFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  const result = await openFileDialog({ multiple: true, filters: MEDIA_FILTERS });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function pickSavePath(
  defaultPath: string,
  filters: FileFilter[],
): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await saveFileDialog({ defaultPath, filters });
  return typeof result === "string" ? result : null;
}

export async function pickOpenPath(filters: FileFilter[]): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await openFileDialog({ multiple: false, filters });
  return typeof result === "string" ? result : null;
}

export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await openFileDialog({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

/* ------------------------------------------------------------------ *
 * Browser fallbacks
 * ------------------------------------------------------------------ */

/** Triggers a download; used when running outside the desktop shell. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string, mime = "application/json"): void {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
