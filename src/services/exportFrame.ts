import { renderFrameImage } from "../export/frame";
import { formatTimecode } from "../core/time";
import { useEditor } from "../store/editorStore";
import { playback } from "../engine/PlaybackEngine";
import { downloadBlob, isTauri, pickSavePath, writeBlob } from "./tauri";

/**
 * Saves the frame under the playhead as a PNG.
 *
 * Shared by the transport button and the keyboard shortcut so both paths behave
 * identically (including where the file goes and what the status line says).
 */
export async function exportCurrentFrame(): Promise<void> {
  const store = useEditor.getState();
  const time = playback.time;
  const stamp = formatTimecode(time, store.project.settings.fps).replace(/:/g, "-");
  const name = `${store.project.name || "qookiv"}_${stamp}.png`;

  try {
    // Rendering is asynchronous (video layers are seeked first), so pause the
    // transport to avoid the playhead moving out from under the capture.
    playback.pause();
    const blob = await renderFrameImage(store.project, time);
    if (!blob) {
      store.setStatus("导出当前帧失败", "error");
      return;
    }

    if (!isTauri()) {
      downloadBlob(blob, name);
      store.setStatus("已导出当前帧", "success");
      return;
    }

    const path = await pickSavePath(name, [{ name: "PNG 图片", extensions: ["png"] }]);
    if (!path) return;
    await writeBlob(path, blob);
    store.setStatus(`当前帧已保存为 ${name}`, "success");
  } catch (error) {
    store.setStatus(`导出当前帧失败：${String(error)}`, "error");
  }
}
