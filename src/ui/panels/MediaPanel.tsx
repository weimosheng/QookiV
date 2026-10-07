import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { usedAssetIds } from "../../core/project";
import { formatDuration } from "../../core/time";
import type { Asset } from "../../core/types";
import { clipMediaVersion, ensureWaveform, getThumbnailAt, getWaveform, requestThumbnail, subscribeClipMedia } from "../../engine/clipMedia";
import { playback } from "../../engine/PlaybackEngine";
import { mediaPool } from "../../engine/sharedPool";
import { clipForAsset, trackKindForAsset } from "../../services/assetClip";
import { importPaths, pickAndImport } from "../../services/importer";
import { importSubtitleFile } from "../../services/subtitleImport";
import { formatBytes, matchesQuery, SORT_LABELS, sortAssets } from "../../services/mediaSort";
import type { SortMode } from "../../services/mediaSort";
import { isTauri, MEDIA_FILTERS, pickOpenPath } from "../../services/tauri";
import { useEditor } from "../../store/editorStore";
import { Button, EmptyState, IconButton, Segmented, Select } from "../controls";
import { useOfflineAssets } from "../hooks";
import {
  AlertCircle,
  Film,
  FolderOpen,
  ImageIcon,
  Music,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Type,
  Upload,
  Volume2,
} from "../icons";
import { resolveDropTarget } from "../timeline/drop";

/** File filters for relinking, narrowed to the asset's own kind. */
const RELINK_FILTERS: Record<string, Array<{ name: string; extensions: string[] }>> = {
  video: [
    { name: "视频", extensions: MEDIA_FILTERS[1].extensions },
  ],
  image: [
    { name: "图片", extensions: MEDIA_FILTERS[2].extensions },
  ],
  audio: [
    { name: "音频", extensions: MEDIA_FILTERS[3].extensions },
  ],
};

/** How the pool is filtered. */
type KindFilter = "all" | "video" | "image" | "audio";

/**
 * Media pool.
 *
 * Importing is the only step that touches the disk; everything else operates on
 * the project's asset list, so undo/redo covers adding and removing media but
 * never re-reads a file.
 *
 * Assets are dragged onto the timeline with pointer events rather than HTML5
 * drag-and-drop: Tauri's native file-drop handling can swallow HTML5 drag events
 * on Windows, and a pointer drag gives live feedback (an insertion line plus a
 * preview of the clip's length).
 */
export function MediaPanel() {
  const project = useEditor((s) => s.project);
  const addAssets = useEditor((s) => s.addAssets);
  const removeAsset = useEditor((s) => s.removeAsset);
  const setStatus = useEditor((s) => s.setStatus);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const offline = useOfflineAssets();

  const visible = useMemo(() => {
    const filtered = project.assets.filter(
      (asset) => (kindFilter === "all" || asset.kind === kindFilter) && matchesQuery(asset, query),
    );
    return sortAssets(filtered, sortMode);
  }, [project.assets, query, kindFilter, sortMode]);

  const used = useMemo(() => usedAssetIds(project), [project]);

  const grouped = useMemo(
    () => ({
      videos: visible.filter((a) => a.kind === "video"),
      images: visible.filter((a) => a.kind === "image"),
      audio: visible.filter((a) => a.kind === "audio"),
    }),
    [visible],
  );

  const handleImport = async () => {
    if (!isTauri()) {
      setStatus("浏览器预览模式下无法读取本地文件，请在桌面应用中使用导入功能", "error");
      return;
    }
    setBusy(true);
    try {
      const assets = await pickAndImport();
      if (assets.length > 0) addAssets(assets);
      else setStatus("没有导入任何支持的素材", "error");
    } catch (error) {
      setStatus(`导入失败：${String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const handleImportSubtitle = async () => {
    if (!isTauri()) {
      setStatus("浏览器预览模式下无法读取本地文件", "error");
      return;
    }
    const path = await pickOpenPath([{ name: "字幕", extensions: ["srt", "vtt"] }]);
    if (!path) return;
    setBusy(true);
    try {
      const clips = await importSubtitleFile(path, { variant: "caption" });
      if (clips.length === 0) {
        setStatus("字幕文件为空", "error");
        return;
      }
      const store = useEditor.getState();
      let track = store.project.tracks.find((t) => t.kind === "visual" && t.name === "字幕" && !t.locked);
      if (!track) {
        store.addTrack("visual");
        const tracks = useEditor.getState().project.tracks;
        track = tracks[tracks.length - 1];
        useEditor.getState().renameTrack(track.id, "字幕");
      }
      store.addClips(clips.map((clip) => ({ trackId: track!.id, clip })));
      setStatus(`已导入 ${clips.length} 条字幕`, "success");
    } catch (error) {
      setStatus(`字幕导入失败：${String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const sections: Array<{ key: string; label: string; icon: ReactNode; items: Asset[] }> = [
    { key: "video", label: "视频", icon: <Film size={13} />, items: grouped.videos },
    { key: "image", label: "图片", icon: <ImageIcon size={13} />, items: grouped.images },
    { key: "audio", label: "音频", icon: <Music size={13} />, items: grouped.audio },
  ].filter((section) => section.items.length > 0);

  const hiddenCount = project.assets.length - visible.length;

  return (
    <div className="qv-panel__scroll">
      <div className="qv-panel__actions">
        <div className="qv-media-import-row">
          <Button variant="primary" icon={<Upload size={14} />} onClick={handleImport} disabled={busy} full>
            {busy ? "正在读取…" : "导入素材"}
          </Button>
          <Button
            variant="ghost"
            icon={<Type size={14} />}
            onClick={handleImportSubtitle}
            disabled={busy}
            title="导入 .srt / .vtt 字幕文件"
          >
            字幕
          </Button>
        </div>

        {project.assets.length > 0 && (
          <div className="qv-media-tools">
            <div className="qv-media-search">
              <Search size={13} />
              <input
                className="qv-input qv-media-search__input"
                value={query}
                placeholder="搜索素材名称或路径…"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="qv-media-tools__row">
              <Segmented
                value={kindFilter}
                onChange={setKindFilter}
                options={[
                  { value: "all", label: "全部" },
                  { value: "video", label: "视频" },
                  { value: "image", label: "图片" },
                  { value: "audio", label: "音频" },
                ]}
              />
            </div>
            <div className="qv-media-tools__row">
              <Select
                value={sortMode}
                onChange={setSortMode}
                options={SORT_LABELS.map((o) => ({ value: o.value, label: o.label }))}
              />
            </div>
            <div className="qv-media-tools__meta">
              显示 {visible.length} / {project.assets.length} 个素材
              {hiddenCount > 0 ? ` · 已过滤 ${hiddenCount} 个` : ""}
              {` · 已使用 ${used.size} 个`}
            </div>
          </div>
        )}

        <p className="qv-panel__note">
          支持 mp4 / mov / webm / png / jpg / webp / mp3 / wav 等格式。可以直接把文件拖进窗口，
          也可以把这里的素材拖到时间线上的任意位置。
        </p>
      </div>

      {offline.length > 0 && (
        <div className="qv-offline-banner">
          <AlertCircle size={14} />
          <div>
            <strong>{offline.length} 个素材已离线</strong>
            <div className="qv-offline-banner__hint">
              文件被移动或删除后，片段会显示为占位图。点素材上的「重新链接」指回文件即可，
              时间线上的片段与关键帧都会保留。
            </div>
          </div>
        </div>
      )}

      {project.assets.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={26} />}
          title="素材库是空的"
          hint="导入产品截图、录屏或背景音乐后，拖到时间线上即可使用。"
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Search size={26} />}
          title="没有匹配的素材"
          hint="换个关键词，或把类型筛选切回「全部」。"
          action={
            <Button
              variant="ghost"
              onClick={() => {
                setQuery("");
                setKindFilter("all");
              }}
            >
              清空筛选
            </Button>
          }
        />
      ) : (
        sections.map((section) => (
          <div className="qv-media-group" key={section.key}>
            <div className="qv-media-group__head">
              {section.icon}
              <span>{section.label}</span>
              <span className="qv-media-group__count">{section.items.length}</span>
            </div>
            <div className="qv-media-list">
              {section.items.map((asset) => (
                <MediaItem
                  key={asset.id}
                  asset={asset}
                  offline={offline.includes(asset.id)}
                  inUse={used.has(asset.id)}
                  onRemove={() => removeAsset(asset.id)}
                />
              ))}
            </div>
          </div>
        ))
      )}

      <AssetDragGhost />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Placing an asset
 * ------------------------------------------------------------------ */

/** Appends an asset at the playhead on the best available track. */
function addAssetAtPlayhead(asset: Asset): void {
  const store = useEditor.getState();
  const wanted = trackKindForAsset(asset);
  const active = store.project.tracks.find((t) => t.id === store.activeTrackId);

  let track =
    active && active.kind === wanted && !active.locked
      ? active
      : store.project.tracks.find((t) => t.kind === wanted && !t.locked);

  if (!track) {
    store.addTrack(wanted);
    const created = useEditor.getState().project.tracks.filter((t) => t.kind === wanted);
    track = created[created.length - 1];
  }
  if (!track) {
    store.setStatus("没有可用的轨道", "error");
    return;
  }

  store.addClip(track.id, clipForAsset(asset, playback.time));
  store.setStatus(`已添加「${asset.name}」到时间线`, "success");
}

/* ------------------------------------------------------------------ *
 * Asset drag
 * ------------------------------------------------------------------ */

function beginAssetDrag(e: ReactPointerEvent, asset: Asset): void {
  // Buttons inside the row keep their own behaviour.
  if ((e.target as Element).closest("button")) return;
  if (e.button !== 0) return;

  const store = useEditor.getState();
  store.setDragAsset(asset);

  const move = (ev: PointerEvent) => {
    const state = useEditor.getState();
    state.setDropHint(resolveDropTarget(ev.clientX, ev.clientY, state.project, state.zoom, asset));
  };

  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const state = useEditor.getState();
    const hint = resolveDropTarget(ev.clientX, ev.clientY, state.project, state.zoom, asset);
    state.setDragAsset(null);
    state.setDropHint(null);
    if (!hint) return;
    // A single history entry, so a drop is one undo step.
    state.addClip(hint.trackId, clipForAsset(asset, hint.time));
    state.setStatus(`已把「${asset.name}」放到时间线`, "success");
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  move(e.nativeEvent);
}

/** Floating chip that follows the cursor while an asset is being dragged. */
function AssetDragGhost() {
  const dragging = useEditor((s) => s.dragAsset);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!dragging) {
      setPos(null);
      return;
    }
    const move = (e: PointerEvent) => {
      ref.current = { x: e.clientX, y: e.clientY };
      setPos(ref.current);
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [dragging]);

  if (!dragging || !pos) return null;

  const icon =
    dragging.kind === "audio" ? <Volume2 size={13} /> : dragging.kind === "video" ? <Film size={13} /> : <ImageIcon size={13} />;

  return (
    <div className="qv-drag-ghost" style={{ left: pos.x + 14, top: pos.y + 12 }}>
      {icon}
      <span>{dragging.name}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Item
 * ------------------------------------------------------------------ */

function MediaItem({
  asset,
  offline,
  inUse,
  onRemove,
}: {
  asset: Asset;
  offline: boolean;
  /** Referenced by at least one clip. */
  inUse: boolean;
  onRemove: () => void;
}) {
  const setStatus = useEditor((s) => s.setStatus);
  const project = useEditor((s) => s.project);
  const relinkAsset = useEditor((s) => s.relinkAsset);

  /** Points the asset at a new file, keeping its id so clips survive. */
  const relink = async () => {
    if (!isTauri()) {
      setStatus("浏览器预览模式下无法读取本地文件", "error");
      return;
    }
    const path = await pickOpenPath(RELINK_FILTERS[asset.kind] ?? MEDIA_FILTERS);
    if (!path) return;
    try {
      const [replacement] = await importPaths([path]);
      if (!replacement?.path) {
        setStatus("无法读取所选文件", "error");
        return;
      }
      relinkAsset(asset.id, {
        path: replacement.path,
        src: replacement.src,
        duration: replacement.duration,
        width: replacement.width,
        height: replacement.height,
        hasAudio: replacement.hasAudio,
        bytes: replacement.bytes,
      });
    } catch (error) {
      setStatus(`重新链接失败：${String(error)}`, "error");
    }
  };

  return (
    <div
      className={offline ? "qv-media-item qv-media-item--offline" : "qv-media-item"}
      onPointerDown={(e) => beginAssetDrag(e, asset)}
      onDoubleClick={() => addAssetAtPlayhead(asset)}
      title={offline ? "文件已离线，点击右侧按钮重新链接" : "拖到时间线，或双击添加到播放头位置"}
    >
      <div className={`qv-media-item__thumb qv-media-item__thumb--${asset.kind}`}>
        {offline ? (
          <AlertCircle size={17} />
        ) : asset.kind === "image" ? (
          <img src={asset.src} alt={asset.name} loading="lazy" draggable={false} />
        ) : (
          <MediaThumb asset={asset} />
        )}
      </div>
      <div className="qv-media-item__info">
        <div className="qv-media-item__name" title={asset.name}>
          {asset.name}
          {inUse && <span className="qv-media-item__used" title="已在时间线上使用">●</span>}
        </div>
        <div className="qv-media-item__meta">
          {offline
            ? "离线 · 文件已移动或删除"
            : [
                asset.width && asset.height ? `${asset.width}×${asset.height}` : "",
                asset.duration ? formatDuration(asset.duration) : "",
                formatBytes(asset.bytes),
              ]
                .filter(Boolean)
                .join(" · ") || asset.kind}
        </div>
      </div>
      <div className="qv-media-item__actions">
        {offline && (
          <IconButton
            icon={<RefreshCw size={14} />}
            title="重新链接到文件…"
            onClick={() => void relink()}
          />
        )}
        <IconButton
          icon={<Plus size={14} />}
          title="添加到时间线（播放头位置）"
          onClick={() => addAssetAtPlayhead(asset)}
        />
        <IconButton
          icon={<Trash2 size={14} />}
          title="从素材库移除"
          danger
          onClick={() => {
            const used = project.tracks.some((t) =>
              t.clips.some((c) =>
                c.kind === "image" || c.kind === "video" || c.kind === "audio"
                  ? c.props.assetId === asset.id
                  : c.kind === "device"
                    ? c.props.assetId === asset.id
                    : false,
              ),
            );
            if (used) {
              // Removing an in-use asset would leave placeholder holes.
              setStatus("该素材仍在时间线上使用，请先删除相关片段", "error");
              return;
            }
            onRemove();
          }}
        />
      </div>
    </div>
  );
}

/**
 * 视频首帧 / 音频波形缩略图。
 *
 * 复用时间线同一套 clipMedia 缓存（`requestThumbnail` / `ensureWaveform`），
 * 用 `useSyncExternalStore` 订阅版本号，异步解码完成后自动重绘。
 */
function MediaThumb({ asset }: { asset: Asset }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const version = useSyncExternalStore(subscribeClipMedia, clipMediaVersion);

  useEffect(() => {
    if (asset.kind === "video") requestThumbnail(asset, mediaPool, 0);
    else if (asset.kind === "audio") void ensureWaveform(asset);
  }, [asset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (asset.kind === "video") {
      const thumb = getThumbnailAt(asset, 0);
      if (thumb) ctx.drawImage(thumb, 0, 0, canvas.width, canvas.height);
    } else if (asset.kind === "audio") {
      const wave = getWaveform(asset.id);
      if (wave) drawWaveform(ctx, wave, canvas.width, canvas.height);
    }
  }, [asset, version]);

  return <canvas ref={canvasRef} className="qv-media-item__canvas" width={60} height={34} />;
}

function drawWaveform(ctx: CanvasRenderingContext2D, peaks: Float32Array, w: number, h: number): void {
  const mid = h / 2;
  ctx.fillStyle = "rgba(155, 140, 255, 0.7)";
  const barW = w / peaks.length;
  for (let i = 0; i < peaks.length; i += 1) {
    const barH = Math.max(1, peaks[i] * mid * 0.9);
    ctx.fillRect(i * barW, mid - barH, Math.max(1, barW - 0.5), barH * 2);
  }
}
