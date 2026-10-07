import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createClipOfKind } from "./core/clips";
import { totalLaneHeight } from "./core/lanes";
import { parseProject } from "./core/schema";
import { effectiveDuration } from "./core/time";
import { playback } from "./engine/PlaybackEngine";
import { mediaPool } from "./engine/sharedPool";
import { renderToCanvas } from "./render/Renderer";
import { importDroppedPaths, kindForPath } from "./services/importer";
import { clipForAsset } from "./services/assetClip";
import { resolveDropTarget, sequenceDrops } from "./ui/timeline/drop";
import {
  downloadText,
  isTauri,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  pickOpenPath,
  pickSavePath,
  PROJECT_FILTERS,
  readTextFile,
  revealInExplorer,
  setMinWindowSize,
  setWindowSize,
  writeTextFile,
} from "./services/tauri";
import { useEditor } from "./store/editorStore";
import { selectedClips } from "./store/editorStore";
import { exportCurrentFrame } from "./services/exportFrame";
import {
  clearAutosave,
  readAutosave,
  readAutosaveDisk,
  recoveryClipCount,
  writeAutosave,
} from "./services/autosave";
import type { AutosaveRecord } from "./services/autosave";
import { addRecent, readRecent, readRecentDisk, removeRecent } from "./services/recentProjects";
import type { RecentProject } from "./services/recentProjects";
import { RecoveryDialog } from "./ui/dialogs/RecoveryDialog";
import { EditableTitle } from "./ui/EditableTitle";
import { Button, IconButton, Segmented } from "./ui/controls";
import { ExportHtmlDialog, ExportVideoDialog } from "./ui/dialogs/ExportDialogs";
import { TemplatePickerDialog } from "./ui/dialogs/TemplatePickerDialog";
import { ShortcutsDialog } from "./ui/dialogs/ShortcutsDialog";
import { GotoDialog } from "./ui/dialogs/GotoDialog";
import {
  Clock,
  Download,
  FileCode,
  FolderOpen,
  HomeIcon,
  Layers,
  Maximize2,
  Minus,
  Monitor,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
  X,
} from "./ui/icons";
import { Inspector } from "./ui/panels/Inspector";
import { MediaPanel } from "./ui/panels/MediaPanel";
import { TemplateGallery } from "./ui/panels/TemplateGallery";
import { Preview } from "./ui/Preview";
import { Timeline } from "./ui/Timeline";
import { Home } from "./ui/Home";
import { buildFromTemplate } from "./templates/apply";
import { defaultSlotValues } from "./templates/types";
import type { PromoTemplate } from "./templates/types";
import type { Project, Seconds } from "./core/types";
import { editPoints } from "./ui/timeline/geometry";
import { fitTimeline, zoomTimeline, zoomTimelineToSelection } from "./ui/timeline/viewport";
import "./App.css";

/**
 * QookiV editor shell.
 *
 * Owns only layout, global keyboard shortcuts and file-level actions. All
 * document state lives in the store, all playback state in `PlaybackEngine`, and
 * all pixel production in the renderer — so this component stays thin.
 */
export default function App() {
  const project = useEditor((s) => s.project);
  const leftTab = useEditor((s) => s.leftTab);
  const setLeftTab = useEditor((s) => s.setLeftTab);
  const status = useEditor((s) => s.status);
  const statusKind = useEditor((s) => s.statusKind);
  const filePath = useEditor((s) => s.filePath);
  const dirty = useEditor((s) => s.dirty);
  const renameProject = useEditor((s) => s.renameProject);
  const past = useEditor((s) => s.past.length);
  const future = useEditor((s) => s.future.length);

  const [dialog, setDialog] = useState<"video" | "html" | "template-picker" | "shortcuts" | "goto" | null>(null);
  const [view, setView] = useState<"home" | "editor">("home");
  const [recents, setRecents] = useState<RecentProject[]>(() => readRecent());
  const [timelineHeight, setTimelineHeight] = useState(392);
  const [leftWidth, setLeftWidth] = useState(306);
  const [rightWidth, setRightWidth] = useState(330);
  const timelineHeightRef = useRef(timelineHeight);
  timelineHeightRef.current = timelineHeight;
  const leftWidthRef = useRef(leftWidth);
  leftWidthRef.current = leftWidth;
  const rightWidthRef = useRef(rightWidth);
  rightWidthRef.current = rightWidth;

  /* ---------------- crash recovery ---------------- */

  // Keep the OS window label in step with the project name, so the taskbar and
  // the titlebar never disagree.
  useEffect(() => {
    document.title = `${dirty ? "• " : ""}${project.name || "未命名宣传片"} · QookiV`;
  }, [project.name, dirty]);

  /*
   * 主页用紧凑窗口（920×600），编辑器用大窗口（1600×950）。
   * 切换 view 时调整窗口尺寸和最小尺寸，让窗口贴合当前界面而非一直撑满。
   */
  useEffect(() => {
    if (view === "editor") {
      void setMinWindowSize(1180, 720);
      void setWindowSize(1600, 950);
    } else {
      void setMinWindowSize(720, 480);
      void setWindowSize(920, 600);
    }
  }, [view]);

  const [recovery, setRecovery] = useState<AutosaveRecord | null>(null);
  const [autosavedAt, setAutosavedAt] = useState<number | null>(null);
  const autosaveTimer = useRef(0);

  // A pending autosave can only exist if a previous session ended dirty, so
  // finding one is by itself the reason to ask. localStorage is the primary
  // store; the on-disk mirror is the fallback when it has been wiped.
  useEffect(() => {
    (async () => {
      let record = readAutosave();
      if (!record) record = await readAutosaveDisk();
      if (!record) return;
      if (recoveryClipCount(record.project) === 0 && record.project.assets.length === 0) {
        // Nothing worth interrupting for.
        clearAutosave();
        return;
      }
      setRecovery(record);
    })();
  }, []);

  // Fall back to the on-disk recent list when localStorage is empty (cache wipe).
  useEffect(() => {
    if (recents.length > 0) return;
    (async () => {
      const disk = await readRecentDisk();
      if (disk.length > 0) setRecents(disk);
    })();
  }, []);

  // Mirror the project into storage shortly after edits stop.
  useEffect(() => {
    if (!dirty) return;
    window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      const state = useEditor.getState();
      if (writeAutosave(state.project, state.filePath)) setAutosavedAt(Date.now());
      else state.setStatus("自动保存失败：本地存储不可用或已满", "error");
    }, 1200);
    return () => window.clearTimeout(autosaveTimer.current);
  }, [project, dirty]);

  // Closing the window with unsaved work should leave the net armed, so only a
  // real save clears it.
  useEffect(() => {
    const onBeforeUnload = () => {
      const state = useEditor.getState();
      if (state.dirty) writeAutosave(state.project, state.filePath);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /**
   * Sizes the timeline to its content whenever a project or template loads.
   *
   * A track whose clips overlap in time is packed into stacked sub-lanes, so how
   * tall the timeline wants to be is a property of the project, not a constant.
   * The result is clamped so the preview always keeps a usable share of the
   * window; the divider can override it afterwards.
   */
  const fitRequest = useEditor((s) => s.fitRequest);
  useEffect(() => {
    if (fitRequest === 0) return;
    const state = useEditor.getState();
    const content = totalLaneHeight(state.project.tracks.map((t) => t.clips));
    // 40px toolbar + 30px ruler + the tracks themselves.
    const wanted = 40 + 30 + content + 8;
    const ceiling = Math.max(220, Math.round(window.innerHeight * 0.62));
    setTimelineHeight(Math.max(220, Math.min(ceiling, wanted)));
  }, [fitRequest]);

  /**
   * Drags the divider between the preview and the timeline.
   *
   * A track with several clips overlapping in time is packed into stacked
   * sub-lanes, so the timeline can get tall; being able to trade preview space
   * for timeline space matters more than a fixed height.
   */
  const startTimelineResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = timelineHeightRef.current;
    const move = (ev: PointerEvent) => {
      setTimelineHeight(
        Math.max(180, Math.min(window.innerHeight - 320, startHeight - (ev.clientY - startY))),
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  /** Drags the divider between the left panel and the preview. */
  const startLeftResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidthRef.current;
    const move = (ev: PointerEvent) => {
      setLeftWidth(Math.max(220, Math.min(520, startW + (ev.clientX - startX))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  /** Drags the divider between the preview and the right panel. */
  const startRightResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidthRef.current;
    const move = (ev: PointerEvent) => {
      setRightWidth(Math.max(240, Math.min(560, startW - (ev.clientX - startX))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  /* ---------------- status toast ---------------- */

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => useEditor.getState().setStatus(null), 4200);
    return () => window.clearTimeout(timer);
  }, [status]);

  const goHome = useCallback(() => {
    playback.pause();
    mediaPool.pauseAll();
    setView("home");
  }, []);

  /* ---------------- project files ---------------- */

  function generateThumbnail(project: Project, time: Seconds): string | undefined {
    try {
      const src = renderToCanvas(project, mediaPool, time);
      const tw = 320;
      const th = Math.round(tw * (project.settings.height / project.settings.width));
      const thumb = document.createElement("canvas");
      thumb.width = tw;
      thumb.height = th;
      const tctx = thumb.getContext("2d");
      if (!tctx) return undefined;
      tctx.drawImage(src, 0, 0, tw, th);
      return thumb.toDataURL("image/jpeg", 0.72);
    } catch {
      return undefined;
    }
  }

  const saveProject = useCallback(
    async (forceDialog = false) => {
      const state = useEditor.getState();
      const json = JSON.stringify(state.project, null, 2);
      if (!isTauri()) {
        downloadText(json, `${state.project.name || "qookiv"}.qookiv`);
        state.setStatus("已下载工程文件", "success");
        return;
      }
      let target = state.filePath;
      if (!target || forceDialog) {
        target = await pickSavePath(
          state.filePath ?? `${state.project.name || "qookiv"}.qookiv`,
          PROJECT_FILTERS,
        );
      }
      if (!target) {
        state.setStatus("已取消保存", "error");
        return;
      }
      try {
        await writeTextFile(target, json);
        state.markSaved(target);
        clearAutosave();
        setAutosavedAt(null);
        setRecents(
          addRecent({
            path: target,
            name: state.project.name,
            savedAt: Date.now(),
            templateId: state.project.templateId,
            duration: effectiveDuration(state.project),
            thumbnail: generateThumbnail(state.project, playback.time),
          }),
        );
        state.setStatus(`工程已保存到 ${target}`, "success");
      } catch (error) {
        state.setStatus(`保存失败：${String(error)}`, "error");
      }
    },
    [],
  );

  const openProject = useCallback(async () => {
    const state = useEditor.getState();
    if (!isTauri()) {
      state.setStatus("浏览器预览模式下无法读取本地工程文件", "error");
      return;
    }
    const target = await pickOpenPath(PROJECT_FILTERS);
    if (!target) return;
    try {
        const raw = await readTextFile(target);
        const { project: parsed, warnings } = parseProject(JSON.parse(raw));
        state.loadProject(parsed, target, warnings);
        // The autosave belongs to whatever was open before.
        clearAutosave();
        setAutosavedAt(null);
        setRecents(
          addRecent({
            path: target,
            name: parsed.name,
            savedAt: Date.now(),
            templateId: parsed.templateId,
            duration: effectiveDuration(parsed),
          }),
        );
        setView("editor");
    } catch (error) {
      state.setStatus(`打开失败：${String(error)}`, "error");
    }
  }, []);

  const handleOpenFromHome = useCallback(async (path: string) => {
    const state = useEditor.getState();
    if (!isTauri()) {
      state.setStatus("浏览器预览模式下无法读取本地工程文件", "error");
      return;
    }
    try {
      const raw = await readTextFile(path);
      const { project: parsed } = parseProject(JSON.parse(raw));
      state.loadProject(parsed, path);
      clearAutosave();
      setAutosavedAt(null);
      setRecents(
        addRecent({
          path,
          name: parsed.name,
          savedAt: Date.now(),
          templateId: parsed.templateId,
          duration: effectiveDuration(parsed),
        }),
      );
      setView("editor");
    } catch (error) {
      state.setStatus(`打开失败：${String(error)}`, "error");
      // The file is gone or unreadable — drop it so the home list stays honest.
      setRecents(removeRecent(path));
    }
  }, []);

  const handleCreateFromTemplate = useCallback((template: PromoTemplate) => {
    const state = useEditor.getState();
    const values = defaultSlotValues(template);
    const built = buildFromTemplate(template, values, state.project.assets);
    // Keep the current project name — a template swap must not rename the project.
    state.applyTemplateProject({ ...built, name: state.project.name }, template.id, values);
    setView("editor");
  }, []);

  const handleRemoveRecent = useCallback((path: string) => {
    setRecents(removeRecent(path));
  }, []);

  /* ---------------- drag & drop import ---------------- */

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    /**
     * `over` 事件只带坐标（不带文件名），但落点提示需要知道类型才能挑轨道——所以
     * 记住 `enter` 报过来的文件名，`leave` 时清掉。
     */
    let hoveringPaths: string[] = [];

    /**
     * 原生拖放给的是**物理像素**（相对 webview 左上角），而命中测试与落点换算都走
     * CSS 像素，所以要按 DPR 折回去——否则 125% / 150% 缩放的机器上落点会整体偏移。
     */
    const clientPoint = (position: { x: number; y: number }): { x: number; y: number } => {
      const ratio = window.devicePixelRatio || 1;
      return { x: position.x / ratio, y: position.y / ratio };
    };

    /**
     * 悬停时的落点提示。
     *
     * 这里只需要知道"会落到哪条轨道、大概多长"，所以拿一个**猜的**素材替身就够了——
     * 真去解析文件（探测时长、转 asset URL）只为画一条插入线太贵了。猜错也不要紧：
     * 真正落下时会按导入后的真实类型重算。
     */
    const hoverHint = (position: { x: number; y: number }, paths: string[]) => {
      const state = useEditor.getState();
      const kind = kindForPath(paths[0] ?? "") ?? "video";
      const probe = { id: "", kind, name: "", src: "", addedAt: 0 };
      const point = clientPoint(position);
      state.setDropHint(
        resolveDropTarget(point.x, point.y, state.project, state.zoom, probe),
      );
    };

    void (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const un = await getCurrentWebview().onDragDropEvent(async (event) => {
          const payload = event.payload;

          if (payload.type === "leave") {
            hoveringPaths = [];
            useEditor.getState().setDropHint(null);
            return;
          }

          if (payload.type === "enter") {
            hoveringPaths = payload.paths;
            hoverHint(payload.position, hoveringPaths);
            return;
          }

          if (payload.type === "over") {
            hoverHint(payload.position, hoveringPaths);
            return;
          }

          // ---- drop ----
          const state = useEditor.getState();
          state.setDropHint(null);
          const point = clientPoint(payload.position);
          // 落点是否在时间线上，要在导入之前判断——导入可能要好几百毫秒，那时指针
          // 位置已经不再是"落点"了。用一个猜的替身命中一次即可。
          const probeKind = kindForPath(payload.paths[0] ?? "");
          const hint = probeKind
            ? resolveDropTarget(point.x, point.y, state.project, state.zoom, {
                id: "",
                kind: probeKind,
                name: "",
                src: "",
                addedAt: 0,
              })
            : null;

          const assets = await importDroppedPaths(payload.paths);
          if (assets.length === 0) {
            useEditor.getState().setStatus("拖入的文件类型不受支持", "error");
            return;
          }

          if (!hint) {
            // 没落在时间线上：只进素材池。
            useEditor.getState().addAssets(assets);
            return;
          }

          const placements = sequenceDrops(useEditor.getState().project, hint, assets);
          if (placements.length === 0) {
            useEditor.getState().addAssets(assets);
            return;
          }
          useEditor.getState().addClips(
            placements.map((place) => ({
              trackId: place.trackId,
              clip: clipForAsset(place.asset, place.start),
            })),
            assets,
          );
          useEditor.getState().setStatus(
            `已导入 ${assets.length} 个素材，并放到时间线 ${placements.length} 处`,
            "success",
          );
        });
        if (cancelled) un();
        else unlisten = un;
      } catch (error) {
        // 拖放只是便利功能，注册失败不该影响应用——但**必须说出来**：静默吞掉异常会让
        // "从资源管理器拖文件进来没反应"变成一件没法查的事（之前就是这样）。
        useEditor
          .getState()
          .setStatus(`系统文件拖放不可用（${String(error)}），可先用「导入素材」按钮`, "error");
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      const store = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        store.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveProject(e.shiftKey);
        return;
      }
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openProject();
        return;
      }
      if (mod && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setDialog(e.shiftKey ? "html" : "video");
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        if (store.selection.length > 0) store.duplicateClips(store.selection);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        void exportCurrentFrame();
        return;
      }
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setDialog("template-picker");
        return;
      }
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setDialog("goto");
        return;
      }

      // Everything below must not shadow native text editing, so it comes after
      // the `typing` guard: Ctrl+C / Ctrl+A inside a field still mean copy /
      // select-all for the text, not for the timeline.
      if (typing) return;

      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        store.copySelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "x") {
        e.preventDefault();
        store.cutSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        store.pasteClipboard(playback.time);
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        store.selectAll();
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          playback.toggle();
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomTimeline(1.35);
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomTimeline(1 / 1.35);
          break;
        case "f":
        case "F":
          e.preventDefault();
          fitTimeline();
          break;
        case "Z":
          // Shift+Z frames the selection.
          e.preventDefault();
          zoomTimelineToSelection();
          break;
        case "ArrowUp": {
          // Jump the playhead to the selection's start; with nothing selected,
          // to the previous edit point, which is the NLE convention.
          e.preventDefault();
          const selected = selectedClips(store);
          if (selected.length > 0) {
            playback.pause();
            playback.seek(Math.min(...selected.map((c) => c.start)));
          } else {
            const points = editPoints(store.project);
            const previous = [...points].reverse().find((t) => t < playback.time - 1e-4);
            playback.pause();
            playback.seek(previous ?? 0);
          }
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const selected = selectedClips(store);
          if (selected.length > 0) {
            playback.pause();
            playback.seek(Math.max(...selected.map((c) => c.start + c.duration)));
          } else {
            const points = editPoints(store.project);
            const next = points.find((t) => t > playback.time + 1e-4);
            playback.pause();
            playback.seek(next ?? effectiveDuration(store.project));
          }
          break;
        }
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) playback.nudge(-1);
          else playback.stepFrames(-1);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) playback.nudge(1);
          else playback.stepFrames(1);
          break;
        case "Home":
          e.preventDefault();
          playback.seek(0);
          break;
        case "End":
          e.preventDefault();
          playback.seek(effectiveDuration(store.project));
          break;
        case "Delete":
        case "Backspace":
          if (mod && e.shiftKey) {
            // Ctrl+Shift+Delete removes the active track entirely.
            e.preventDefault();
            if (store.activeTrackId) store.removeTrack(store.activeTrackId);
          } else if (mod) {
            // Ctrl+Delete clears the active track, keeping the empty track shell.
            e.preventDefault();
            if (store.activeTrackId) store.clearTrack(store.activeTrackId);
          } else if (store.selection.length > 0) {
            e.preventDefault();
            // Shift+Delete ripples (collapses the gap), matching Premiere/Resolve;
            // plain Delete leaves a gap behind.
            if (e.shiftKey) store.rippleDelete(store.selection);
            else store.deleteClips(store.selection);
          }
          break;
        case "s":
        case "S":
          e.preventDefault();
          store.splitAt(playback.time);
          break;
        case "i":
          e.preventDefault();
          playback.markIn();
          break;
        case "I":
          e.preventDefault();
          playback.clearIn();
          break;
        case "o":
          e.preventDefault();
          playback.markOut();
          break;
        case "O":
          e.preventDefault();
          playback.clearOut();
          break;
        case "j":
          e.preventDefault();
          playback.setRate(-1);
          playback.play();
          break;
        case "k":
          e.preventDefault();
          playback.pause();
          playback.setRate(1);
          break;
        case "l":
          e.preventDefault();
          playback.setRate(1);
          playback.play();
          break;
        case "F1":
        case "?":
          e.preventDefault();
          setDialog("shortcuts");
          break;
        case "Escape":
          store.clearSelection();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveProject, openProject]);

  /* ---------------- adding clips ---------------- */

  const targetTrackId = (): string | null => {
    const store = useEditor.getState();
    const active = store.project.tracks.find((t) => t.id === store.activeTrackId);
    if (active && active.kind === "visual" && !active.locked) return active.id;
    const visual = store.project.tracks.find((t) => t.kind === "visual" && !t.locked);
    return visual?.id ?? null;
  };

  const addClipOfKind = (kind: "text" | "shape" | "device" | "background") => {
    const store = useEditor.getState();
    const trackId = targetTrackId();
    if (!trackId) {
      store.setStatus("没有可用的图层轨道", "error");
      return;
    }
    const clip = createClipOfKind(kind, {
      start: playback.time,
      theme: store.project.theme,
      duration: kind === "background" ? 6 : 3,
    });
    store.addClip(trackId, clip);
    store.setStatus("已添加片段", "success");
  };

  const addTextVariant = (variant: "hero" | "subtitle") => {
    const store = useEditor.getState();
    const trackId = targetTrackId();
    if (!trackId) return;
    const clip = createClipOfKind("text", {
      start: playback.time,
      theme: store.project.theme,
      variant,
      duration: 3,
    });
    store.addClip(trackId, clip);
  };

  /* ---------------- render ---------------- */

  return (
    <div className="qv-app">
      <header className="qv-titlebar" data-tauri-drag-region>
        <div className="qv-brand" data-tauri-drag-region>
          <img src="/brand/qookiv.png" alt="" className="qv-brand__logo" />
          <span className="qv-brand__name">QookiV</span>
          {view === "editor" && (
            <button
              type="button"
              className="qv-brand__home"
              onClick={() => goHome()}
              title="返回首页"
            >
              <HomeIcon size={15} /> 首页
            </button>
          )}
        </div>

        {view === "editor" && (
          <div className="qv-titlebar__center" data-tauri-drag-region>
            <EditableTitle name={project.name} dirty={dirty} onRename={renameProject} />
          </div>
        )}

        <div className="qv-titlebar__right" data-tauri-drag-region>
          {view === "editor" && (
            <>
              <IconButton
                icon={<Undo2 size={15} />}
                title="撤销 (Ctrl+Z)"
                disabled={past === 0}
                onClick={() => useEditor.getState().undo()}
              />
              <IconButton
                icon={<Redo2 size={15} />}
                title="重做 (Ctrl+Shift+Z)"
                disabled={future === 0}
                onClick={() => useEditor.getState().redo()}
              />
              <span className="qv-timeline__sep" />
            </>
          )}
          <Button icon={<FolderOpen size={14} />} onClick={openProject} title="打开工程 (Ctrl+O)">
            打开
          </Button>
          {view === "editor" && (
            <>
              <Button icon={<Save size={14} />} onClick={() => void saveProject()} title="保存工程 (Ctrl+S)">
                保存
              </Button>
              <span className="qv-timeline__sep" />
              <Button
                icon={<FileCode size={14} />}
                onClick={() => setDialog("html")}
                title="导出网页 (Ctrl+Shift+E)"
              >
                导出网页
              </Button>
              <Button
                variant="primary"
                icon={<Download size={14} />}
                onClick={() => setDialog("video")}
                title="导出视频 (Ctrl+E)"
              >
                导出视频
              </Button>
            </>
          )}
        </div>
        {isTauri() && (
          <div className="qv-titlebar__window">
            <button className="qv-win-btn" onClick={() => void minimizeWindow()} title="最小化">
              <Minus size={15} />
            </button>
            <button className="qv-win-btn" onClick={() => void toggleMaximizeWindow()} title="最大化">
              <Maximize2 size={13} />
            </button>
            <button
              className="qv-win-btn qv-win-btn--close"
              onClick={() => {
                if (view === "editor") goHome();
                else void closeWindow();
              }}
              title={view === "editor" ? "返回首页" : "关闭"}
            >
              <X size={15} />
            </button>
          </div>
        )}
      </header>

      {view === "home" ? (
        <Home
          recents={recents}
          onOpen={(path) => void handleOpenFromHome(path)}
          onNewProject={() => setDialog("template-picker")}
          onRemoveRecent={handleRemoveRecent}
        />
      ) : (
        <>
          <div className="qv-toolbar">
            <div className="qv-toolbar__group">
              <span className="qv-toolbar__label">添加</span>
              <Button icon={<Type size={14} />} onClick={() => addTextVariant("hero")}>
                大标题
              </Button>
              <Button icon={<Type size={14} />} onClick={() => addTextVariant("subtitle")}>
                副标题
              </Button>
              <Button icon={<Square size={14} />} onClick={() => addClipOfKind("shape")}>
                形状
              </Button>
              <Button icon={<Monitor size={14} />} onClick={() => addClipOfKind("device")}>
                界面演示
              </Button>
              <Button icon={<Layers size={14} />} onClick={() => addClipOfKind("background")}>
                背景
              </Button>
            </div>

            <div className="qv-toolbar__spacer" />

            <div className="qv-toolbar__group">
              <span className="qv-toolbar__label">
                <Clock size={13} /> {effectiveDuration(project).toFixed(1)}s
              </span>
            </div>
          </div>

          <div className="qv-body">
            <aside className="qv-side qv-side--left" style={{ width: leftWidth }}>
              <div className="qv-side__tabs">
                <Segmented
                  value={leftTab}
                  onChange={setLeftTab}
                  options={[
                    { value: "media", label: "素材" },
                    { value: "templates", label: "模板" },
                  ]}
                />
              </div>
              {leftTab === "templates" ? <TemplateGallery /> : <MediaPanel />}
            </aside>

            <div
              className="qv-vdivider"
              onPointerDown={startLeftResize}
              role="separator"
              aria-orientation="vertical"
              title="拖动调整左面板宽度"
            />

            <main className="qv-center">
              <Preview />
            </main>

            <div
              className="qv-vdivider"
              onPointerDown={startRightResize}
              role="separator"
              aria-orientation="vertical"
              title="拖动调整右面板宽度"
            />

            <aside className="qv-side qv-side--right" style={{ width: rightWidth }}>
              <Inspector />
            </aside>
          </div>

          <div
            className="qv-hdivider"
            onPointerDown={startTimelineResize}
            title="拖动调整时间线高度"
            role="separator"
            aria-orientation="horizontal"
          />

          <Timeline height={timelineHeight} />

          <footer className="qv-statusbar">
            <span className={`qv-status qv-status--${statusKind}`}>
              {status ?? "就绪 · 空格播放，S 分割，Ctrl+E 导出视频"}
            </span>
            <span className="qv-statusbar__right">
              {dirty && autosavedAt !== null && (
                <span className="qv-badge qv-badge--ok" title="编辑会自动镜像到本地，崩溃后可恢复">
                  已自动保存 {new Date(autosavedAt).toLocaleTimeString()}
                </span>
              )}
              <button
                type="button"
                className="qv-link"
                onClick={() => {
                  const state = useEditor.getState();
                  if (state.filePath) void revealInExplorer(state.filePath);
                  else state.setStatus("工程尚未保存到磁盘", "error");
                }}
              >
                {filePath ? "在文件夹中显示" : "未保存"}
              </button>
              <span className="qv-badge qv-badge--dim">v0.1.0</span>
            </span>
          </footer>
        </>
      )}

      {recovery && (
        <RecoveryDialog
          project={recovery.project}
          filePath={recovery.filePath}
          savedAt={recovery.savedAt}
          onRestore={() => {
            const state = useEditor.getState();
            state.loadProject(recovery.project, recovery.filePath, [
              "已从自动保存恢复，请确认内容后另存为",
            ]);
            // Still unsaved: keep the net armed in case it dies again.
            state.markDirty();
            setRecovery(null);
            setView("editor");
          }}
          onDiscard={() => {
            clearAutosave();
            setRecovery(null);
          }}
        />
      )}

      {dialog === "video" && <ExportVideoDialog onClose={() => setDialog(null)} />}
      {dialog === "html" && <ExportHtmlDialog onClose={() => setDialog(null)} />}
      {dialog === "template-picker" && (
        <TemplatePickerDialog
          onPick={(t) => {
            handleCreateFromTemplate(t);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "shortcuts" && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === "goto" && <GotoDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
