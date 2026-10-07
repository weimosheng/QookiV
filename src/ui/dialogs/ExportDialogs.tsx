import { useEffect, useMemo, useState } from "react";
import { usedAssetIds } from "../../core/project";
import { effectiveDuration, formatDuration } from "../../core/time";
import { mediaPool } from "../../engine/sharedPool";
import { exportStandaloneHtml } from "../../export/html/exportHtml";
import { detectVideoCapabilities, exportVideo, isAbortError } from "../../export/video";
import { defaultVideoBitrate } from "../../export/video/exportVideo";
import type { VideoCapabilities, VideoExportProgress } from "../../export/video";
import {
  baseName,
  copyFile,
  downloadBlob,
  downloadText,
  isTauri,
  joinPath,
  pickDirectory,
  pickSavePath,
  revealInExplorer,
  writeBase64File,
  writeTextFile,
} from "../../services/tauri";
import { useEditor } from "../../store/editorStore";
import { Button, Field, Modal, ProgressBar, Segmented, Select, Toggle } from "../controls";
import { useInOutPoints, useOfflineAssets } from "../hooks";
import { Check, Loader2 } from "../icons";

/**
 * Offline (missing) media that the project actually uses.
 *
 * Exported so both dialogs can warn *before* a long render rather than producing
 * a video full of placeholder frames.
 */
function useOfflineInUse(): { count: number; names: string } {
  const project = useEditor((s) => s.project);
  const offline = useOfflineAssets();
  return useMemo(() => {
    const used = usedAssetIds(project);
    const missing = project.assets.filter((a) => used.has(a.id) && offline.includes(a.id));
    return { count: missing.length, names: missing.map((a) => a.name).join("、") };
  }, [project, offline]);
}

/**
 * Export dialogs.
 *
 * Both flows render through the same compositor the preview uses, so the only
 * thing that differs between "what you watched" and "what you got" is the
 * encoder. Long jobs report progress and can be cancelled.
 */

type VideoState =
  | { phase: "idle" }
  | { phase: "running"; progress: VideoExportProgress }
  | { phase: "done"; path: string | null; bytes: number; warnings: string[] }
  | { phase: "error"; message: string };

export function ExportVideoDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const setStatus = useEditor((s) => s.setStatus);
  const [quality, setQuality] = useState<"project" | "1080" | "720">("project");
  const [fps, setFps] = useState(String(project.settings.fps));
  const [includeAudio, setIncludeAudio] = useState(true);
  const [useRange, setUseRange] = useState(false);
  const [state, setState] = useState<VideoState>({ phase: "idle" });
  const [caps, setCaps] = useState<VideoCapabilities | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  const offlineInUse = useOfflineInUse();
  const { inPoint, outPoint } = useInOutPoints();
  const hasRange = inPoint !== null && outPoint !== null && outPoint > inPoint;

  // Probe encoder support once, so an unsupported machine fails fast and loudly.
  useEffect(() => {
    let cancelled = false;
    void detectVideoCapabilities().then((result) => {
      if (!cancelled) setCaps(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const targetSize = () => {
    const aspect = project.settings.width / project.settings.height;
    if (quality === "1080") return { width: 1920, height: Math.round(1920 / aspect) };
    if (quality === "720") return { width: 1280, height: Math.round(1280 / aspect) };
    return { width: project.settings.width, height: project.settings.height };
  };

  const start = async () => {
    const size = targetSize();
    const ac = new AbortController();
    setController(ac);
    setState({ phase: "running", progress: { phase: "prepare", frame: 0, totalFrames: 0, ratio: 0, message: "准备中…" } });

    try {
      const result = await exportVideo(project, mediaPool, {
        width: size.width,
        height: size.height,
        fps: Number(fps),
        includeAudio,
        ...(useRange && hasRange
          ? { range: { start: inPoint!, end: outPoint! } }
          : {}),
        onProgress: (progress) => setState({ phase: "running", progress }),
        signal: ac.signal,
      });

      // Persist the file. Outside the desktop shell this falls back to a download.
      let savedPath: string | null = null;
      if (isTauri()) {
        const defaultPath = `${project.name || "qookiv"}.mp4`;
        const chosen = await pickSavePath(defaultPath, [{ name: "MP4 视频", extensions: ["mp4"] }]);
        if (chosen) {
          await saveBlob(result.blob, chosen);
          savedPath = chosen;
          setStatus(`视频已导出到 ${baseName(chosen)}`, "success");
        } else {
          setStatus("已取消保存", "error");
        }
      } else {
        downloadBlob(result.blob, `${project.name || "qookiv"}.mp4`);
        setStatus("已开始下载视频文件", "success");
      }

      setState({ phase: "done", path: savedPath, bytes: result.bytes, warnings: result.warnings });
    } catch (error) {
      if (isAbortError(error)) {
        setState({ phase: "idle" });
        setStatus("已取消导出", "error");
      } else {
        setState({ phase: "error", message: String(error) });
        setStatus(`导出失败：${String(error)}`, "error");
      }
    } finally {
      setController(null);
    }
  };

  const running = state.phase === "running";
  const size = targetSize();
  // Must be the effective length, not `settings.duration`: the latter is only a
  // default for an empty project and would over-state the estimate.
  const fullDuration = effectiveDuration(project);
  const rangeDuration =
    useRange && hasRange ? outPoint! - inPoint! : fullDuration;
  const duration = rangeDuration;
  const totalFrames = Math.round(duration * Number(fps));

  /**
   * Honest pre-render estimate.
   *
   * Uses the exporter's own bitrate heuristic rather than a guess, so the number
   * matches what actually lands on disk within encoder variance. A long high-fps
   * render is also flagged, because 120fps on a 30s cut is nearly 4000 frames.
   */
  const videoBitrate = defaultVideoBitrate(size.width, size.height, Number(fps));
  const estimatedBitrate = videoBitrate + (includeAudio ? 192_000 : 0);
  const estimatedBytes = (estimatedBitrate * duration) / 8;
  const longRender = totalFrames > 4000;

  return (
    <Modal
      title="导出视频文件"
      onClose={running ? () => controller?.abort() : onClose}
      footer={
        <>
          {running ? (
            <Button variant="danger" onClick={() => controller?.abort()}>
              取消导出
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
              <Button
                variant="primary"
                onClick={start}
                disabled={caps !== null && !caps.avc}
                icon={<Check size={14} />}
              >
                开始导出
              </Button>
            </>
          )}
        </>
      }
    >
      {caps !== null && !caps.avc && (
        <div className="qv-alert qv-alert--error">
          当前运行环境不支持 H.264 硬件编码（WebCodecs 不可用），无法导出 MP4。请更新 WebView2 运行时后重试。
        </div>
      )}

      {offlineInUse.count > 0 && (
        <div className="qv-alert qv-alert--warn">
          <div>
            有 {offlineInUse.count} 个正在使用的素材已离线，导出画面会出现占位图：
            {offlineInUse.names}
          </div>
          <div>建议先在左侧素材库里点「重新链接」指回文件，再开始导出。</div>
        </div>
      )}

      <div className="qv-grid2">
        <Field label="分辨率">
          <Select
            value={quality}
            onChange={setQuality}
            options={[
              { value: "project", label: `跟随工程 ${project.settings.width}×${project.settings.height}` },
              { value: "1080", label: "1920 × 1080" },
              { value: "720", label: "1280 × 720" },
            ]}
          />
        </Field>
        <Field label="帧率">
          <Select
            value={fps}
            onChange={setFps}
            options={[
              { value: "24", label: "24 fps（电影感）" },
              { value: "25", label: "25 fps" },
              { value: "30", label: "30 fps" },
              { value: "50", label: "50 fps" },
              { value: "60", label: "60 fps（推荐）" },
              { value: "100", label: "100 fps" },
              { value: "120", label: "120 fps（高帧率）" },
            ]}
          />
        </Field>
      </div>

      <p className="qv-panel__note">
        高帧率会按比例增加总帧数与导出耗时——32 秒的片子按 120fps 导出是 3840 帧。
        H.264 级别会按分辨率与帧率自动推导（1080p120 使用 Level 5.1）。
      </p>

      <Field label="包含音轨" hint="关闭后导出无声视频，速度更快">
        <Toggle checked={includeAudio} onChange={setIncludeAudio} />
      </Field>

      <Field
        label="仅导出入出点区间"
        hint={hasRange ? undefined : "先在预览中按 I / O 标记入出点"}
      >
        <Toggle
          checked={useRange && hasRange}
          onChange={(v) => setUseRange(v)}
          disabled={!hasRange}
        />
      </Field>

      <div className="qv-kv">
        <span>输出画布</span>
        <span>
          {size.width} × {size.height}
        </span>
      </div>
      <div className="qv-kv">
        <span>总帧数</span>
        <span>{totalFrames} 帧</span>
      </div>
      <div className="qv-kv">
        <span>预计码率</span>
        <span>
          {(estimatedBitrate / 1_000_000).toFixed(2)} Mbps
          {includeAudio ? "（含音轨 192 kbps）" : ""}
        </span>
      </div>
      <div className="qv-kv">
        <span>预计文件大小</span>
        <span>≈ {formatBytes(estimatedBytes)}</span>
      </div>
      <div className="qv-kv">
        <span>时长</span>
        <span>{formatDuration(duration)}</span>
      </div>
      {caps && (
        <div className="qv-kv">
          <span>编码器</span>
          <span>
            H.264 {caps.avc ? "可用" : "不可用"} · AAC {caps.aac ? "可用" : "不可用"}
          </span>
        </div>
      )}

      {longRender && (
        <div className="qv-alert qv-alert--warn">
          <div>
            这次导出共 {totalFrames} 帧，渲染会按顺序逐帧等待视频解码，耗时可能较长。
          </div>
          <div>如果只是想快速预览结果，可以先把帧率降到 30 或缩短时间线。</div>
        </div>
      )}

      {state.phase === "running" && (
        <div className="qv-export-progress">
          <ProgressBar ratio={state.progress.ratio} label={state.progress.message} />
          <div className="qv-kv">
            <span>帧进度</span>
            <span>
              {state.progress.frame} / {state.progress.totalFrames || totalFrames}
            </span>
          </div>
        </div>
      )}

      {state.phase === "done" && (
        <div className="qv-alert qv-alert--ok">
          <Check size={14} /> 导出完成，共 {(state.bytes / (1024 * 1024)).toFixed(1)} MB。
          {state.path && (
            <button type="button" className="qv-link" onClick={() => void revealInExplorer(state.path!)}>
              在文件夹中显示
            </button>
          )}
        </div>
      )}

      {state.phase === "done" && state.warnings.length > 0 && (
        <div className="qv-alert qv-alert--warn">
          {state.warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {state.phase === "error" && <div className="qv-alert qv-alert--error">{state.message}</div>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * HTML export
 * ------------------------------------------------------------------ */

type HtmlState =
  | { phase: "idle" }
  | { phase: "running"; ratio: number; message: string }
  | { phase: "done"; path: string | null; warnings: string[]; size: number }
  | { phase: "error"; message: string };

export function ExportHtmlDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const setStatus = useEditor((s) => s.setStatus);
  const [mode, setMode] = useState<"folder" | "single">("folder");
  const [state, setState] = useState<HtmlState>({ phase: "idle" });
  const offlineInUse = useOfflineInUse();

  // Only referenced media is exported, so the estimate counts the same set.
  const htmlAssets = useMemo(() => {
    const used = usedAssetIds(project);
    const list = project.assets.filter((a) => used.has(a.id));
    return {
      count: list.length,
      totalBytes: list.reduce((sum, a) => sum + (a.bytes ?? 0), 0),
    };
  }, [project]);

  const running = state.phase === "running";

  const start = async () => {
    setState({ phase: "running", ratio: 0, message: "正在准备…" });
    try {
      const bundle = await exportStandaloneHtml(project, {
        mode,
        title: project.name,
        onProgress: (p) => setState({ phase: "running", ratio: p.ratio, message: p.message }),
      });

      let savedPath: string | null = null;
      if (!isTauri()) {
        downloadText(bundle.html, `${project.name || "qookiv"}.html`, "text/html");
        setState({ phase: "done", path: null, warnings: bundle.warnings, size: bundle.html.length });
        return;
      }

      if (mode === "single") {
        const chosen = await pickSavePath(`${project.name || "qookiv"}.html`, [
          { name: "网页文件", extensions: ["html"] },
        ]);
        if (!chosen) {
          setState({ phase: "idle" });
          setStatus("已取消保存", "error");
          return;
        }
        await writeTextFile(chosen, bundle.html);
        savedPath = chosen;
      } else {
        const dir = await pickDirectory();
        if (!dir) {
          setState({ phase: "idle" });
          setStatus("已取消保存", "error");
          return;
        }
        const htmlPath = joinPath(dir, "index.html");
        await writeTextFile(htmlPath, bundle.html);

        // Media goes beside the page. Files that still exist on disk are copied
        // directly, which avoids pushing tens of megabytes through the IPC bridge.
        if (bundle.assets.length > 0) {
          const assetsDir = joinPath(dir, "assets");
          for (const asset of bundle.assets) {
            const destination = joinPath(assetsDir, asset.name);
            const sourceId = asset.name.replace(/\.[^.]+$/, "");
            const original = project.assets.find((a) => a.id === sourceId);
            if (original?.path) {
              try {
                await copyFile(original.path, destination);
                continue;
              } catch {
                // Fall through to the base64 path below.
              }
            }
            await writeBase64File(destination, asset.base64);
          }
        }
        savedPath = htmlPath;
      }

      setStatus("网页文件已导出", "success");
      setState({
        phase: "done",
        path: savedPath,
        warnings: bundle.warnings,
        size: bundle.html.length,
      });
    } catch (error) {
      setState({ phase: "error", message: String(error) });
      setStatus(`导出失败：${String(error)}`, "error");
    }
  };

  return (
    <Modal
      title="导出网页文件"
      onClose={running ? () => undefined : onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            关闭
          </Button>
          <Button variant="primary" onClick={start} disabled={running} icon={<Check size={14} />}>
            开始导出
          </Button>
        </>
      }
    >
      <Field
        label="输出方式"
        hint="单文件便于分享；文件夹方式对包含大体积视频的工程更友好。"
      >
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "folder", label: "HTML + 素材文件夹" },
            { value: "single", label: "单个 HTML 文件" },
          ]}
        />
      </Field>

      <div className="qv-kv">
        <span>引用素材</span>
        <span>
          {htmlAssets.count} 个
          {htmlAssets.totalBytes > 0 ? ` · 约 ${formatBytes(htmlAssets.totalBytes)}` : ""}
        </span>
      </div>
      {mode === "single" && htmlAssets.totalBytes > 20 * 1024 * 1024 && (
        <div className="qv-alert qv-alert--warn">
          <div>
            单文件模式会把素材转成 base64 内联，体积约增加 33%，也就是
            ≈ {formatBytes(htmlAssets.totalBytes * 1.33)}。浏览器打开这么大的单页会明显变慢。
          </div>
          <div>建议改用「HTML + 素材文件夹」，或者先在时间线上精简掉不需要的素材。</div>
        </div>
      )}
      {offlineInUse.count > 0 && (
        <div className="qv-alert qv-alert--warn">
          <div>
            有 {offlineInUse.count} 个正在使用的素材已离线，导出的页面里会是占位图：
            {offlineInUse.names}
          </div>
          <div>建议先在左侧素材库里点「重新链接」指回文件，再开始导出。</div>
        </div>
      )}
      <div className="qv-kv">
        <span>播放器</span>
        <span>内置 QookiV 播放器（与预览同一套渲染器）</span>
      </div>

      {running && (
        <div className="qv-export-progress">
          <ProgressBar ratio={state.ratio} label={state.message} />
          <div className="qv-export-progress__hint">
            <Loader2 size={13} className="qv-spin" /> 正在内联素材并生成页面…
          </div>
        </div>
      )}

      {state.phase === "done" && (
        <div className="qv-alert qv-alert--ok">
          <Check size={14} /> 已生成网页文件。
          {state.path && (
            <button type="button" className="qv-link" onClick={() => void revealInExplorer(state.path!)}>
              在文件夹中显示
            </button>
          )}
        </div>
      )}

      {state.phase === "done" && state.warnings.length > 0 && (
        <div className="qv-alert qv-alert--warn">
          {state.warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {state.phase === "error" && <div className="qv-alert qv-alert--error">{state.message}</div>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Writes a Blob to disk.
 *
 * Uses the base64 command rather than an array of bytes: a 30 MB video would
 * otherwise cross the IPC bridge as thirty million JSON numbers.
 */
async function saveBlob(blob: Blob, path: string): Promise<void> {
  const base64 = await blobToBase64(blob);
  await writeBase64File(path, base64);
}

function blobToBase64(blob: Blob): Promise<string> {
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

/** Human-readable byte size, used for export estimates. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
