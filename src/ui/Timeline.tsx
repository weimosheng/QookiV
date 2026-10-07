import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { assignLanes, LANE_H, LANE_PAD } from "../core/lanes";
import { findAsset, findClip, findClipRef, findTrack } from "../core/project";
import { effectiveDuration, formatDuration, formatTimecode } from "../core/time";
import type { Clip, ClipKind, Project, Track } from "../core/types";
import { playback } from "../engine/PlaybackEngine";
import { useEditor } from "../store/editorStore";
import { IconButton } from "./controls";
import {
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  Film,
  ImageIcon,
  Layers,
  Lock,
  Magnet,
  Monitor,
  Music,
  Plus,
  Scissors,
  Square,
  Trash2,
  Type,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "./icons";
import {
  clipIdsInBox,
  clipRects,
  gridWidth,
  HEADER_W,
  isSectionRow,
  layoutRows,
  normalizeBox,
  RULER_H,
} from "./timeline/geometry";
import type { Box } from "./timeline/geometry";
import { ClipArtwork, keyframeMarkers, shouldShowArtwork } from "./timeline/ClipArtwork";
import { ContextMenu } from "./timeline/ContextMenu";
import { clipMotionSummary, clipTransitionSummary } from "./timeline/labels";
import type { MenuItem } from "./timeline/ContextMenu";
import { timeToGridX } from "./timeline/drop";
import {
  attachTimelineWheel,
  dragDeltaTime,
  fitTimeline,
  isUserScrolling,
  registerTimelineViewport,
  tickAutoscroll,
  timelineViewport,
  zoomTimeline,
  zoomTimelineToSelection,
} from "./timeline/viewport";
import { collectSnapTimes, quantizeToFrame, snapEdge, snapSpan } from "./timeline/snap";
/**
 * Multi-track timeline.
 *
 * Track headers are `position: sticky` inside the same scroll container as the
 * lanes, which keeps them frozen without a second synchronised scroller.
 *
 * Every pointer gesture is committed through `placeClips` / `updateClips` with
 * absolute values and wrapped in a single history entry, so one drag is one undo
 * step. Row geometry is computed in `timeline/geometry.ts` from the same numbers
 * the DOM uses, which is what lets marquee selection agree with what is on screen.
 */

const MIN_CLIP = 0.06;

type DragMode = "move" | "trim-left" | "trim-right";

interface ClipOrigin {
  start: number;
  duration: number;
  trimIn: number;
  speed: number;
  trackId: string;
}

interface DragState {
  mode: DragMode;
  ids: string[];
  primaryId: string;
  startX: number;
  /**
   * Scroll offset when the drag began.
   *
   * The pointer delta alone is not enough: if the timeline scrolls mid-drag
   * (auto-scroll at an edge, or a wheel event) the content moves under a
   * stationary pointer, so the delta has to be corrected by the scroll change.
   */
  startScrollLeft: number;
  /** Last pointer x, so auto-scroll can keep ticking without new events. */
  lastX: number;
  origins: Map<string, ClipOrigin>;
  moved: boolean;
  /**
   * 复制拖动（在按下时按住 Alt）。
   *
   * 意图必须在**按下那一刻**定下来：Alt 在拖动中还兼着"临时关闭吸附"，如果中途按下
   * Alt 就算复制，那老用法（拖到一半按 Alt 求精确落点）会莫名其妙多出副本。
   *
   * 实现上是"原件跟着走、落点处再补一份原件副本"，而不是"复制一份再拖"——观感完全
   * 一样（拖动途中看不出哪份是哪份），但拖动的代码一行都不用改，撤销也仍然只有一步。
   */
  copy: boolean;
}

interface MarqueeState {
  startX: number;
  startY: number;
  active: boolean;
  box: Box;
}

/**
 * A keyframe drag.
 *
 * `anchorTime` is where the drag began and never changes (it defines the target
 * from the pointer delta); `currentTime` tracks where the keyframes actually are
 * right now, so each move finds and relocates them without compounding.
 */
interface KeyframeDragState {
  clipId: string;
  anchorTime: number;
  currentTime: number;
  startX: number;
  duration: number;
  /** Scroll offset when the drag began; see `DragState.startScrollLeft`. */
  startScrollLeft: number;
}

const KIND_META: Record<ClipKind, { label: string; color: string; icon: ReactNode }> = {
  background: { label: "背景", color: "#8a6a4a", icon: <Layers size={13} /> },
  text: { label: "文字", color: "#C97640", icon: <Type size={13} /> },
  image: { label: "图片", color: "#5AA9E6", icon: <ImageIcon size={13} /> },
  video: { label: "视频", color: "#6FCF97", icon: <Film size={13} /> },
  audio: { label: "音频", color: "#9B8CFF", icon: <Music size={13} /> },
  shape: { label: "形状", color: "#E29A5A", icon: <Square size={13} /> },
  device: { label: "界面", color: "#E86A7C", icon: <Monitor size={13} /> },
};

export function Timeline({ height }: { height?: number }) {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const splitAt = useEditor((s) => s.splitAt);
  const deleteClips = useEditor((s) => s.deleteClips);
  const duplicateClips = useEditor((s) => s.duplicateClips);
  const addTrack = useEditor((s) => s.addTrack);
  const copySelection = useEditor((s) => s.copySelection);
  const pasteClipboard = useEditor((s) => s.pasteClipboard);
  const clipboard = useEditor((s) => s.clipboard);
  const dropHint = useEditor((s) => s.dropHint);
  const rippleDelete = useEditor((s) => s.rippleDelete);
  const closeGaps = useEditor((s) => s.closeGaps);
  const updateClips = useEditor((s) => s.updateClips);

  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const kfDragRef = useRef<KeyframeDragState | null>(null);
  const anchorRef = useRef<string | null>(null);
  const [snap, setSnap] = useState(true);
  /** Time of the magnet target currently being stuck to, for the guide line. */
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<Box | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renamingClipId, setRenamingClipId] = useState<string | null>(null);

  const duration = effectiveDuration(project);

  // The measured width of the scroll container, so the grid can be padded out to
  // fill the panel instead of stopping partway across when zoomed out.
  const [viewportW, setViewportW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const contentW = gridWidth(duration, zoom, viewportW);
  const layout = useMemo(() => layoutRows(project), [project]);

  /* ---------------- geometry ---------------- */

  const live = useRef({ zoom, snap, fps: project.settings.fps });
  live.current = { zoom, snap, fps: project.settings.fps };

  /** Snap targets for the ruler; drags compute their own excluding the dragged ids. */
  const snapTimes = useMemo(
    () => collectSnapTimes(project, [], playback.time),
    [project],
  );
  const magnetRef = useRef(snap);
  magnetRef.current = snap;

  const laneTrackIdAt = (clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY);
    if (!(el instanceof Element)) return null;
    const lane = el.closest("[data-track-id]");
    return lane instanceof HTMLElement ? lane.dataset.trackId ?? null : null;
  };

  const gridPoint = (clientX: number, clientY: number) => {
    const grid = gridRef.current;
    if (!grid) return { x: 0, y: 0 };
    const rect = grid.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  /* ---------------- clip drag ---------------- */

  const autoscrollTimer = useRef(0);

  const stopAutoscroll = () => {
    if (!autoscrollTimer.current) return;
    window.clearInterval(autoscrollTimer.current);
    autoscrollTimer.current = 0;
  };

  /**
   * Keeps scrolling while a drag sits at an edge.
   *
   * A pointermove listener alone is not enough: holding the pointer still at the
   * edge fires no further events, so the view would stop scrolling exactly when
   * the user is waiting for it to carry on.
   */
  const startAutoscroll = () => {
    if (autoscrollTimer.current) return;
    autoscrollTimer.current = window.setInterval(() => {
      const drag = dragRef.current;
      if (!drag) {
        stopAutoscroll();
        return;
      }
      tickAutoscroll(drag.lastX);
    }, 16);
  };

  useEffect(() => stopAutoscroll, []);

  const handlers = useRef<{
    move: (e: PointerEvent) => void;
    up: () => void;
    marqueeMove: (e: PointerEvent) => void;
    marqueeUp: (e: PointerEvent) => void;
    kfMove: (e: PointerEvent) => void;
    kfUp: () => void;
  } | null>(null);

  if (!handlers.current) {
    const finish = () => {
      const drag = dragRef.current;
      dragRef.current = null;
      setSnapGuide(null);
      stopAutoscroll();
      if (handlers.current) {
        window.removeEventListener("pointermove", handlers.current.move);
        window.removeEventListener("pointerup", handlers.current.up);
      }
      if (!drag) return;
      const store = useEditor.getState();

      /*
       * Alt + 拖动 = 复制：把每个被拖走的片段补一份回它原来待的位置。补进去的片段用
       * `history: false`，所以"移动 + 复制"会一起收进本次拖动开始时打开的那一步撤销里。
       */
      if (drag.copy && drag.moved) {
        const created = store.copyClipsAt(
          [...drag.origins.entries()].map(([id, origin]) => ({
            clipId: id,
            trackId: origin.trackId,
            start: origin.start,
          })),
          { history: false },
        );
        if (created.length > 0) {
          store.setStatus(`已复制 ${created.length} 个片段（Alt + 拖动），原件留在原处`);
        }
      }

      store.endHistory();
    };

    const move = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const store = useEditor.getState();
      const { zoom: z, snap: snapping, fps } = live.current;
      drag.lastX = e.clientX;
      // Pointer travel plus however far the view scrolled underneath it.
      const dt = dragDeltaTime({
        clientX: e.clientX,
        startX: drag.startX,
        startScrollLeft: drag.startScrollLeft,
        scrollLeft: timelineViewport()?.scrollLeft ?? drag.startScrollLeft,
        zoom: z,
      });
      if (!drag.moved && Math.abs(dt) * z < 3) return;
      drag.moved = true;

      const primaryOrigin = drag.origins.get(drag.primaryId);
      if (!primaryOrigin) return;
      const primaryClip = findClip(store.project, drag.primaryId);
      if (!primaryClip) return;

      // Alt suspends snapping for the duration of the move, the way every other
      // editor does it, so a clip can be placed deliberately off a cut.
      const magnet = snapping && !e.altKey;
      const candidates = collectSnapTimes(store.project, drag.ids, playback.time);

      if (drag.mode === "move") {
        const rawStart = Math.max(0, primaryOrigin.start + dt);
        const snapped = magnet
          ? snapSpan(
              rawStart,
              primaryOrigin.duration,
              candidates,
              z,
              fps,
            )
          : { time: quantizeToFrame(rawStart, fps), guide: null };
        setSnapGuide(snapped.guide);
        const applied = snapped.time - primaryOrigin.start;

        const target = laneTrackIdAt(e.clientX, e.clientY) ?? primaryOrigin.trackId;
        const targetTrack = findTrack(store.project, target);
        const isAudio = primaryClip.kind === "audio";
        const allowed =
          targetTrack && (targetTrack.kind === "audio") === isAudio && !targetTrack.locked
            ? target
            : primaryOrigin.trackId;

        store.placeClips(
          drag.ids.map((id) => {
            const origin = drag.origins.get(id);
            return {
              clipId: id,
              trackId: allowed,
              start: Math.max(0, (origin?.start ?? 0) + applied),
            };
          }),
          { history: false },
        );
        return;
      }

      const speed = primaryOrigin.speed || 1;
      const maxSource = maxSourceDuration(store.project, primaryClip);

      if (drag.mode === "trim-right") {
        const rawEnd = primaryOrigin.start + primaryOrigin.duration + dt;
        const snapped = magnet
          ? snapEdge(rawEnd, candidates, z, fps)
          : { time: quantizeToFrame(rawEnd, fps), guide: null };
        setSnapGuide(snapped.guide);
        let nextDuration = Math.max(MIN_CLIP, snapped.time - primaryOrigin.start);
        if (maxSource !== null) {
          const available = (maxSource - primaryOrigin.trimIn) / speed;
          nextDuration = Math.min(nextDuration, Math.max(MIN_CLIP, available));
        }
        store.updateClip(drag.primaryId, { duration: nextDuration }, { history: false });
        return;
      }

      const rawStart = primaryOrigin.start + dt;
      const snapped = magnet
        ? snapEdge(rawStart, candidates, z, fps)
        : { time: quantizeToFrame(rawStart, fps), guide: null };
      setSnapGuide(snapped.guide);
      const originEnd = primaryOrigin.start + primaryOrigin.duration;
      const nextStart = Math.max(0, Math.min(snapped.time, originEnd - MIN_CLIP));
      const deltaStart = nextStart - primaryOrigin.start;
      store.updateClip(
        drag.primaryId,
        {
          start: nextStart,
          duration: originEnd - nextStart,
          trimIn: Math.max(0, primaryOrigin.trimIn + deltaStart * speed),
        },
        { history: false },
      );
    };

    /* ---- marquee ---- */

    const marqueeMove = (e: PointerEvent) => {
      const marquee = marqueeRef.current;
      if (!marquee) return;
      const point = gridPoint(e.clientX, e.clientY);
      if (!marquee.active) {
        if (Math.hypot(point.x - marquee.startX, point.y - marquee.startY) < 4) return;
        marquee.active = true;
      }
      const box = normalizeBox({ x: marquee.startX, y: marquee.startY }, point);
      marquee.box = box;
      setMarqueeBox(box);

      // Live feedback while dragging the rubber band.
      const store = useEditor.getState();
      const rects = clipRects(layoutRows(store.project), live.current.zoom);
      const locked = new Set(
        store.project.tracks.filter((t) => t.locked || t.hidden).map((t) => t.id),
      );
      const ids = clipIdsInBox(rects, box).filter((id) => {
        const ref = findClipRef(store.project, id);
        return ref ? !locked.has(ref.trackId) : false;
      });
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const merged = new Set([...useEditor.getState().selection, ...ids]);
        store.select(Array.from(merged), "replace");
      } else {
        store.select(ids, "replace");
      }
    };

    const marqueeUp = (e: PointerEvent) => {
      const marquee = marqueeRef.current;
      marqueeRef.current = null;
      setMarqueeBox(null);
      if (handlers.current) {
        window.removeEventListener("pointermove", handlers.current.marqueeMove);
        window.removeEventListener("pointerup", handlers.current.marqueeUp);
      }
      if (!marquee) return;
      const store = useEditor.getState();
      // A press that never moved is a plain click on empty space: deselect and
      // move the playhead there, which is what the gesture means in an NLE.
      if (!marquee.active) {
        store.clearSelection();
        const point = gridPoint(e.clientX, e.clientY);
        playback.pause();
        playback.seek(Math.max(0, (point.x - HEADER_W) / live.current.zoom));
      }
      playback.invalidate();
    };

    /* ---- keyframe drag ---- */

    const kfMove = (e: PointerEvent) => {
      const drag = kfDragRef.current;
      if (!drag) return;
      const store = useEditor.getState();
      const { zoom: z, fps } = live.current;

      // The target is derived from the *original* pointer position, so the
      // gesture stays absolute however many move events arrive. Scroll movement
      // is folded in: the content shifts under a stationary pointer.
      const raw =
        drag.anchorTime +
        dragDeltaTime({
          clientX: e.clientX,
          startX: drag.startX,
          startScrollLeft: drag.startScrollLeft,
          scrollLeft: timelineViewport()?.scrollLeft ?? drag.startScrollLeft,
          zoom: z,
        });
      const clamped = Math.max(0, Math.min(drag.duration, raw));
      const snapped = Math.round(clamped * fps) / fps;
      if (Math.abs(snapped - drag.currentTime) < 1e-9) return;

      store.moveKeyframesAt(drag.clipId, drag.currentTime, snapped, { history: false });
      drag.currentTime = snapped;
    };

    const kfUp = () => {
      const drag = kfDragRef.current;
      kfDragRef.current = null;
      stopAutoscroll();
      if (handlers.current) {
        window.removeEventListener("pointermove", handlers.current.kfMove);
        window.removeEventListener("pointerup", handlers.current.kfUp);
      }
      if (drag) useEditor.getState().endHistory();
    };

    handlers.current = { move, up: finish, marqueeMove, marqueeUp, kfMove, kfUp };
  }

  const onPointerMove = handlers.current.move;
  const finishDrag = handlers.current.up;
  const onMarqueeMove = handlers.current.marqueeMove;
  const onMarqueeUp = handlers.current.marqueeUp;
  const onKeyframeMove = handlers.current.kfMove;
  const finishKeyframeDrag = handlers.current.kfUp;

  /** Starts dragging the keyframe(s) sitting at `localTime` inside a clip. */
  const beginKeyframeDrag = (e: ReactPointerEvent, clip: Clip, localTime: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const store = useEditor.getState();
    if (!store.selection.includes(clip.id)) store.select([clip.id], "replace");
    kfDragRef.current = {
      clipId: clip.id,
      anchorTime: localTime,
      currentTime: localTime,
      startX: e.clientX,
      duration: clip.duration,
      startScrollLeft: timelineViewport()?.scrollLeft ?? 0,
    };
    store.beginHistory();
    startAutoscroll();
    window.addEventListener("pointermove", onKeyframeMove);
    window.addEventListener("pointerup", finishKeyframeDrag);
  };

  const beginDrag = (e: ReactPointerEvent, mode: DragMode, clip: Clip, trackId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const store = useEditor.getState();
    const track = findTrack(store.project, trackId);
    if (track?.locked) return;

    // Modifier clicks adjust the selection instead of moving anything.
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      applyModifierSelection(e, clip, trackId);
      return;
    }

    const ids = store.selection.includes(clip.id) ? store.selection : [clip.id];
    if (!store.selection.includes(clip.id)) store.select([clip.id], "replace");
    anchorRef.current = clip.id;

    const origins = new Map<string, ClipOrigin>();
    for (const id of ids) {
      const ref = findClipRef(store.project, id);
      const found = findClip(store.project, id);
      if (!ref || !found) continue;
      origins.set(id, {
        start: found.start,
        duration: found.duration,
        trimIn: found.trimIn,
        speed: found.speed,
        trackId: ref.trackId,
      });
    }
    if (origins.size === 0) return;

    dragRef.current = {
      mode,
      ids,
      primaryId: clip.id,
      startX: e.clientX,
      startScrollLeft: timelineViewport()?.scrollLeft ?? 0,
      lastX: e.clientX,
      origins,
      moved: false,
      copy: e.altKey,
    };
    store.beginHistory();
    startAutoscroll();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
  };

  /** Shift extends from the anchor clip, Ctrl/Cmd toggles a single clip. */
  const applyModifierSelection = (e: ReactPointerEvent, clip: Clip, trackId: string) => {
    const store = useEditor.getState();

    if (e.shiftKey && anchorRef.current) {
      const anchorInfo = findClipRef(store.project, anchorRef.current);
      const track = findTrack(store.project, trackId);
      if (track && anchorInfo?.trackId === trackId) {
        const ordered = [...track.clips].sort((a, b) => a.start - b.start);
        const from = ordered.findIndex((c) => c.id === anchorRef.current);
        const to = ordered.findIndex((c) => c.id === clip.id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          store.select(
            ordered.slice(lo, hi + 1).map((c) => c.id),
            "replace",
          );
          return;
        }
      }
      store.select([clip.id], "add");
      anchorRef.current = clip.id;
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      store.select([clip.id], "toggle");
      anchorRef.current = clip.id;
    }
  };

  /* ---------------- marquee start ---------------- */

  const beginMarquee = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // Only a press on empty lane space starts a rubber band; a press on a clip
    // is handled by the clip itself.
    if (e.target !== e.currentTarget) return;
    const point = gridPoint(e.clientX, e.clientY);
    marqueeRef.current = { startX: point.x, startY: point.y, active: false, box: normalizeBox(point, point) };
    anchorRef.current = null;
    window.addEventListener("pointermove", onMarqueeMove);
    window.addEventListener("pointerup", onMarqueeUp);
  };

  useEffect(
    () => () => {
      const h = handlers.current;
      if (!h) return;
      window.removeEventListener("pointermove", h.move);
      window.removeEventListener("pointerup", h.up);
      window.removeEventListener("pointermove", h.marqueeMove);
      window.removeEventListener("pointerup", h.marqueeUp);
      window.removeEventListener("pointermove", h.kfMove);
      window.removeEventListener("pointerup", h.kfUp);
    },
    [],
  );

  /* ---------------- follow the playhead ---------------- */

  useEffect(
    () =>
      playback.onFrame((time, playing) => {
        if (!playing) return;
        if (isUserScrolling()) return;
        const scroll = scrollRef.current;
        if (!scroll) return;
        const x = timeToGridX(time, zoom);
        const left = scroll.scrollLeft;
        const margin = 90;
        if (x < left + HEADER_W + margin || x > left + scroll.clientWidth - margin) {
          scroll.scrollLeft = Math.max(0, x - (scroll.clientWidth + HEADER_W) / 2);
        }
      }),
    [zoom],
  );

  /* ---------------- zoom & viewport ---------------- */

  // Registered so the keyboard shortcuts in the shell drive the same code path.
  // The wheel listener has to be native (non-passive) so ctrl+wheel can be
  // prevented from zooming the whole webview.
  useEffect(() => {
    const element = scrollRef.current;
    registerTimelineViewport(element);
    const detach = element ? attachTimelineWheel(element) : null;
    return () => {
      detach?.();
      registerTimelineViewport(null);
    };
  }, []);

  const openClipMenu = (e: ReactMouseEvent, clip: Clip, trackId: string) => {
    e.preventDefault();
    const store = useEditor.getState();
    if (!store.selection.includes(clip.id)) store.select([clip.id], "replace");
    setMenu({ x: e.clientX, y: e.clientY, items: buildClipMenu(clip.id, trackId) });
  };

  const openTrackMenu = (e: ReactMouseEvent, trackId: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: buildTrackMenu(trackId) });
  };

  const buildTrackMenu = (trackId: string): MenuItem[] => {
    const store = useEditor.getState();
    const track = findTrack(store.project, trackId);
    const sameKind = store.project.tracks.filter((t) => t.kind === track?.kind);
    const index = sameKind.findIndex((t) => t.id === trackId);
    return [
      {
        id: "up",
        label: "上移一层",
        disabled: !track || index === sameKind.length - 1,
        onSelect: () => store.moveTrack(trackId, "up"),
      },
      {
        id: "down",
        label: "下移一层",
        disabled: !track || index === 0,
        onSelect: () => store.moveTrack(trackId, "down"),
      },
      {
        id: "duplicate",
        label: "复制轨道（含全部片段）",
        separatorBefore: true,
        onSelect: () => store.duplicateTrack(trackId),
      },
      {
        id: "close-gaps",
        label: "闭合该轨道的空隙",
        disabled: !track || track.locked,
        onSelect: () => store.closeGaps(trackId),
      },
      {
        id: "clear",
        label: "清空轨道上的片段",
        shortcut: "Ctrl+Delete",
        danger: true,
        disabled: !track || track.locked || track.clips.length === 0,
        onSelect: () => store.clearTrack(trackId),
      },
      {
        id: "delete",
        label: "删除轨道",
        shortcut: "Ctrl+Shift+Delete",
        danger: true,
        disabled: store.project.tracks.length <= 1,
        onSelect: () => store.removeTrack(trackId),
      },
    ];
  };

  const buildClipMenu = (clipId: string, trackId: string): MenuItem[] => {
    const store = useEditor.getState();
    const clip = findClip(store.project, clipId);
    const track = findTrack(store.project, trackId);
    const ids = store.selection.includes(clipId) ? store.selection : [clipId];
    const many = ids.length > 1;

    return [
      {
        id: "copy",
        label: many ? `复制 ${ids.length} 个片段` : "复制片段",
        shortcut: "Ctrl+C",
        onSelect: () => {
          store.select(ids, "replace");
          store.copySelection();
        },
      },
      {
        id: "cut",
        label: "剪切",
        shortcut: "Ctrl+X",
        onSelect: () => {
          store.select(ids, "replace");
          store.cutSelection();
        },
      },
      {
        id: "paste",
        label: "在播放头粘贴",
        shortcut: "Ctrl+V",
        disabled: !store.clipboard || store.clipboard.length === 0,
        onSelect: () => store.pasteClipboard(playback.time),
      },
      {
        id: "duplicate",
        label: "就地复制",
        shortcut: "Ctrl+D",
        onSelect: () => store.duplicateClips(ids),
      },
      {
        id: "split",
        label: "在播放头分割",
        shortcut: "S",
        separatorBefore: true,
        onSelect: () => {
          store.select(ids, "replace");
          store.splitAt(playback.time);
        },
      },
      {
        id: "rename",
        label: "重命名…",
        disabled: many,
        onSelect: () => setRenamingClipId(clipId),
      },
      {
        id: "detach-audio",
        label: "分离视频与音频",
        separatorBefore: true,
        // Only video carries embedded sound; a still or a shape has none.
        disabled: many || clip?.kind !== "video",
        onSelect: () => {
          store.select([clipId], "replace");
          store.detachAudio(clipId);
        },
      },
      {
        id: "toggle",
        label: clip?.enabled === false ? "启用片段" : "停用片段",
        onSelect: () => updateClips(ids, { enabled: clip?.enabled === false }),
      },
      {
        id: "playhead-start",
        label: "播放头移到片段开头",
        separatorBefore: true,
        onSelect: () => {
          if (!clip) return;
          playback.pause();
          playback.seek(clip.start);
        },
      },
      {
        id: "playhead-end",
        label: "播放头移到片段结尾",
        onSelect: () => {
          if (!clip) return;
          playback.pause();
          playback.seek(clip.start + clip.duration);
        },
      },
      {
        id: "ripple",
        label: "波纹删除（后续片段前移）",
        shortcut: "Shift+Delete",
        separatorBefore: true,
        danger: true,
        onSelect: () => rippleDelete(ids),
      },
      {
        id: "delete",
        label: "删除片段",
        shortcut: "Delete",
        danger: true,
        onSelect: () => store.deleteClips(ids),
      },
      {
        id: "close-gaps",
        label: `闭合「${track?.name ?? "该轨道"}」的空隙`,
        separatorBefore: true,
        disabled: !track || track.locked,
        onSelect: () => closeGaps(trackId),
      },
    ];
  };

  const fitRequest = useEditor((s) => s.fitRequest);
  useEffect(() => {
    if (fitRequest === 0) return;
    const id = window.requestAnimationFrame(fitTimeline);
    return () => window.cancelAnimationFrame(id);
  }, [fitRequest]);

  /* ---------------- render ---------------- */

  const hintRow = dropHint ? layout.byTrackId.get(dropHint.trackId) : undefined;

  return (
    <div className="qv-timeline" style={height === undefined ? undefined : { height }}>
      <div className="qv-timeline__bar">
        <span className="qv-timeline__title">时间线</span>
        <span className="qv-timeline__count">
          {selection.length > 0 ? `已选 ${selection.length} 个片段` : `${project.tracks.reduce((n, t) => n + t.clips.length, 0)} 个片段`}
        </span>
        <div className="qv-timeline__tools">
          <IconButton
            icon={<Scissors size={15} />}
            title="在播放头处分割 (S)"
            onClick={() => splitAt(playback.time)}
          />
          <IconButton
            icon={<Copy size={15} />}
            title="复制所选片段 (Ctrl+C)"
            disabled={selection.length === 0}
            onClick={copySelection}
          />
          <IconButton
            icon={<ClipboardPaste size={15} />}
            title="在播放头粘贴 (Ctrl+V)"
            disabled={!clipboard || clipboard.length === 0}
            onClick={() => pasteClipboard(playback.time)}
          />
          <IconButton
            icon={<Layers size={15} />}
            title="就地复制 (Ctrl+D)"
            disabled={selection.length === 0}
            onClick={() => duplicateClips(selection)}
          />
          <IconButton
            icon={<Trash2 size={15} />}
            title="删除所选片段 (Delete)"
            disabled={selection.length === 0}
            danger
            onClick={() => deleteClips(selection)}
          />
          <span className="qv-timeline__sep" />
          <IconButton
            icon={<Magnet size={15} />}
            title={
              snap
                ? "吸附已开启：片段的头尾、播放头与 0 秒都会被吸附（拖动时按住 Alt 可临时关闭）"
                : "吸附已关闭：位置只按帧对齐"
            }
            active={snap}
            onClick={() => setSnap((v) => !v)}
          />
          <IconButton icon={<ZoomOut size={15} />} title="缩小 (-)" onClick={() => zoomTimeline(1 / 1.35)} />
          <IconButton icon={<ZoomIn size={15} />} title="放大 (+)" onClick={() => zoomTimeline(1.35)} />
          <button type="button" className="qv-btn qv-btn--ghost" onClick={fitTimeline} title="缩放到适合窗口">
            适合
          </button>
          <button
            type="button"
            className="qv-btn qv-btn--ghost"
            onClick={zoomTimelineToSelection}
            title="缩放到所选片段 (Shift+Z)"
          >
            选区
          </button>
          <span className="qv-timeline__sep" />
          <IconButton icon={<Plus size={15} />} title="新增图层轨道" onClick={() => addTrack("visual")} />
          <IconButton icon={<Music size={15} />} title="新增音频轨道" onClick={() => addTrack("audio")} />
        </div>
      </div>

      <div className="qv-timeline__scroll" ref={scrollRef}>
        <div className="qv-timeline__grid" ref={gridRef} style={{ width: contentW + HEADER_W }}>
          <div className="qv-row qv-row--ruler" style={{ height: RULER_H }}>
            <div className="qv-row__head qv-row__head--ruler" style={{ width: HEADER_W }}>
              <span className="qv-row__hint">{formatDuration(duration)}</span>
            </div>
            <Ruler
              zoom={zoom}
              contentW={contentW}
              fps={project.settings.fps}
              targets={snapTimes}
              magnet={magnetRef}
              onGuide={setSnapGuide}
            />
          </div>

          {layout.rows.map((row) =>
            isSectionRow(row) ? (
              <div
                className="qv-row qv-row--section"
                key={`section-${row.track.id}`}
                style={{ height: row.height }}
              >
                <div className="qv-row__head qv-row__head--section" style={{ width: HEADER_W }}>
                  音频
                </div>
                <div className="qv-row__body" />
              </div>
            ) : (
              <TrackRow
                key={row.track.id}
                track={row.track}
                height={row.height}
                zoom={zoom}
                contentW={contentW}
                highlighted={dropHint?.trackId === row.track.id}
                renamingClipId={renamingClipId}
                onClipPointerDown={beginDrag}
                onLanePointerDown={beginMarquee}
                onClipContextMenu={openClipMenu}
                onTrackContextMenu={openTrackMenu}
                onKeyframePointerDown={beginKeyframeDrag}
                onStartRename={setRenamingClipId}
                onCommitRename={(clip, name) => {
                  const trimmed = name.trim();
                  if (trimmed && trimmed !== clip.name) {
                    useEditor.getState().updateClip(clip.id, { name: trimmed });
                  }
                  setRenamingClipId(null);
                }}
              />
            ),
          )}

          {/* Magnet guide: shows which edge the drag is sticking to, so a jump
              reads as intentional rather than as a glitch. */}
          {snapGuide !== null && (
            <div
              className="qv-snap-guide"
              style={{ left: HEADER_W + snapGuide * zoom }}
              aria-hidden
            />
          )}

          {marqueeBox && marqueeBox.w + marqueeBox.h > 2 && (
            <div
              className="qv-marquee"
              style={{                left: marqueeBox.x,
                top: marqueeBox.y,
                width: marqueeBox.w,
                height: marqueeBox.h,
              }}
            />
          )}

          {dropHint && hintRow && (
            <>
              <div
                className="qv-droptarget"
                style={{ top: hintRow.top, height: hintRow.height }}
              />
              <div className="qv-dropbar" style={{ top: hintRow.top, height: hintRow.height }}>
                <div
                  className="qv-dropbar__ghost"
                  style={{ left: timeToGridX(dropHint.time, zoom), width: dropHint.duration * zoom }}
                />
                <div className="qv-dropbar__line" style={{ left: timeToGridX(dropHint.time, zoom) }} />
              </div>
            </>
          )}

          <Playhead zoom={zoom} headerW={HEADER_W} />
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ruler
 * ------------------------------------------------------------------ */

function chooseStep(zoom: number, minPx = 82): number {
  const candidates = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const c of candidates) {
    if (c * zoom >= minPx) return c;
  }
  return 900;
}

function Ruler({
  zoom,
  contentW,
  fps,
  targets,
  magnet,
  onGuide,
}: {
  zoom: number;
  contentW: number;
  fps: number;
  targets: number[];
  /** Live snap state; a ref so the pointer closures always read the current one. */
  magnet: { current: boolean };
  onGuide: (time: number | null) => void;
}) {
  const step = chooseStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= contentW / zoom; t += step) ticks.push(Math.round(t * 1000) / 1000);
  const [cursor, setCursor] = useState<{ x: number; label: string } | null>(null);

  const scrubTo = (clientX: number, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const raw = Math.max(0, (clientX - rect.left) / zoom);
    // Scrubbing snaps too: landing the playhead exactly on a cut is most of the
    // reason to scrub at all.
    const snapped = magnet.current
      ? snapEdge(raw, targets, zoom, fps)
      : { time: quantizeToFrame(raw, fps), guide: null };
    playback.seek(snapped.time);
    setCursor({ x: snapped.time * zoom, label: formatTimecode(snapped.time, fps) });
    onGuide(snapped.guide);
  };

  return (
    <div
      className="qv-ruler"
      style={{ width: contentW }}
      onPointerDown={(e) => {
        const target = e.currentTarget;
        playback.pause();
        scrubTo(e.clientX, target);
        const move = (ev: PointerEvent) => scrubTo(ev.clientX, target);
        const up = () => {
          setCursor(null);
          onGuide(null);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    >
      {ticks.map((t) => (
        <div key={t} className="qv-ruler__tick" style={{ left: t * zoom }}>
          <span className="qv-ruler__label">{formatTimecode(t, fps).slice(3)}</span>
        </div>
      ))}
      {cursor && (
        <div className="qv-ruler__cursor" style={{ left: cursor.x }}>
          {cursor.label}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Track
 * ------------------------------------------------------------------ */

function TrackRow({
  track,
  height,
  zoom,
  contentW,
  highlighted,
  renamingClipId,
  onClipPointerDown,
  onLanePointerDown,
  onClipContextMenu,
  onTrackContextMenu,
  onKeyframePointerDown,
  onStartRename,
  onCommitRename,
}: {
  track: Track;
  height: number;
  zoom: number;
  contentW: number;
  highlighted: boolean;
  renamingClipId: string | null;
  onClipPointerDown: (e: ReactPointerEvent, mode: DragMode, clip: Clip, trackId: string) => void;
  onLanePointerDown: (e: ReactPointerEvent) => void;
  onClipContextMenu: (e: ReactMouseEvent, clip: Clip, trackId: string) => void;
  onTrackContextMenu: (e: ReactMouseEvent, trackId: string) => void;
  onKeyframePointerDown: (e: ReactPointerEvent, clip: Clip, localTime: number) => void;
  onStartRename: (clipId: string) => void;
  onCommitRename: (clip: Clip, name: string) => void;
}) {
  const activeTrackId = useEditor((s) => s.activeTrackId);
  const setActiveTrack = useEditor((s) => s.setActiveTrack);
  const updateTrack = useEditor((s) => s.updateTrack);
  const removeTrack = useEditor((s) => s.removeTrack);
  const renameTrack = useEditor((s) => s.renameTrack);
  const isAudio = track.kind === "audio";
  const { laneOf, lanes } = useMemo(() => assignLanes(track.clips), [track.clips]);
  const [editingName, setEditingName] = useState(false);

  return (
    <div className="qv-row" style={{ height }}>
      <div
        className={[
          "qv-row__head",
          activeTrackId === track.id ? "qv-row__head--active" : "",
          highlighted ? "qv-row__head--drop" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ width: HEADER_W }}
        onClick={() => setActiveTrack(track.id)}
        onContextMenu={(e) => onTrackContextMenu(e, track.id)}
        title="右键查看更多轨道操作"
      >
        <div className="qv-row__name">
          {isAudio ? <Music size={13} /> : <Layers size={13} />}
          {editingName ? (
            <input
              className="qv-input qv-row__rename"
              defaultValue={track.name}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const next = e.currentTarget.value.trim();
                if (next && next !== track.name) renameTrack(track.id, next);
                setEditingName(false);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditingName(false);
              }}
            />
          ) : (
            <span
              className="qv-row__label"
              title={`${track.name}（双击重命名）`}
              onDoubleClick={() => setEditingName(true)}
            >
              {track.name}
            </span>
          )}
          {lanes > 1 && (
            <span className="qv-row__lanes" title={`该轨道上有 ${lanes} 个片段在时间上重叠`}>
              {lanes} 层
            </span>
          )}
        </div>
        <div className="qv-row__actions">
          <IconButton
            icon={track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
            title={track.hidden ? "显示该轨道" : "隐藏该轨道"}
            active={track.hidden}
            onClick={() => updateTrack(track.id, { hidden: !track.hidden })}
          />
          {isAudio && (
            <IconButton
              icon={track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              title={track.muted ? "取消静音" : "静音该轨道"}
              active={track.muted}
              onClick={() => updateTrack(track.id, { muted: !track.muted })}
            />
          )}
          <IconButton
            icon={track.locked ? <Lock size={13} /> : <Unlock size={13} />}
            title={track.locked ? "解锁" : "锁定"}
            active={track.locked}
            onClick={() => updateTrack(track.id, { locked: !track.locked })}
          />
          <IconButton
            icon={<Trash2 size={13} />}
            title="删除轨道"
            danger
            onClick={() => removeTrack(track.id)}
          />
        </div>
      </div>

      <div
        className={[
          "qv-row__body",
          track.locked ? "qv-row__body--locked" : "",
          highlighted ? "qv-row__body--drop" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ width: contentW }}
        data-track-id={track.id}
        onPointerDown={onLanePointerDown}
      >
        {track.clips.map((clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            trackId={track.id}
            zoom={zoom}
            lane={laneOf.get(clip.id) ?? 0}
            renaming={renamingClipId === clip.id}
            onPointerDown={onClipPointerDown}
            onContextMenu={onClipContextMenu}
            onKeyframePointerDown={onKeyframePointerDown}
            onStartRename={onStartRename}
            onCommitRename={onCommitRename}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Clip
 * ------------------------------------------------------------------ */

function ClipView({
  clip,
  trackId,
  zoom,
  lane,
  renaming,
  onPointerDown,
  onContextMenu,
  onKeyframePointerDown,
  onStartRename,
  onCommitRename,
}: {
  clip: Clip;
  trackId: string;
  zoom: number;
  lane: number;
  renaming: boolean;
  onPointerDown: (e: ReactPointerEvent, mode: DragMode, clip: Clip, trackId: string) => void;
  onContextMenu: (e: ReactMouseEvent, clip: Clip, trackId: string) => void;
  onKeyframePointerDown: (e: ReactPointerEvent, clip: Clip, localTime: number) => void;
  onStartRename: (clipId: string) => void;
  onCommitRename: (clip: Clip, name: string) => void;
}) {
  const selected = useEditor((s) => s.selection.includes(clip.id));
  const meta = KIND_META[clip.kind];
  const left = clip.start * zoom;
  const width = Math.max(6, clip.duration * zoom - 1);
  const keyframeTimes = mergedKeyframeTimes(clip);
  const animated = keyframeTimes.length > 0;
  const narrow = width < 46;
  // 有没有关键帧也算：矩形/色块没有胶片条，但一样会有尺寸过渡的关键帧标记。
  const showsArtwork = shouldShowArtwork(clip);
  const sizeMarkers = keyframeMarkers(clip).filter((marker) => marker.kind === "size").length;

  /*
   * 片段块上只挂一条 tooltip，所以把"这个片段到底动了什么"都塞进去：关键帧菱形只说明
   * 有动画、以及在什么时刻，说不出是宽高还是模糊；转场更是完全没有别的标记。
   */
  const clipTitle = [
    clip.name,
    formatDuration(clip.duration),
    clipTransitionSummary(clip),
    clipMotionSummary(clip),
  ]
    .filter((part) => part.length > 0)
    .join(" · ");

  /** 转场楔形的宽度：按时长换算，但不许超过半块片段。 */
  const wedgeWidth = (seconds: number): number =>
    Math.min(width / 2, Math.max(5, seconds * zoom));

  /**
   * Finds the keyframe diamond under the pointer, if any.
   *
   * Diamonds are drawn at `(time / duration) * width` inside the clip's own box,
   * so the same expression recovers which one is being grabbed — the canvas may be
   * capped in resolution but it is stretched back to `width` by CSS.
   */
  const keyframeAt = (e: ReactPointerEvent): number | null => {
    if (clip.duration <= 0) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const tolerance = 7;
    let best: number | null = null;
    let bestDistance = tolerance;
    for (const time of keyframeTimes) {
      const x = (time / clip.duration) * width;
      const distance = Math.abs(x - offsetX);
      if (distance <= bestDistance) {
        best = time;
        bestDistance = distance;
      }
    }
    return best;
  };

  return (
    <div
      className={`qv-clip${selected ? " qv-clip--on" : ""}${clip.enabled ? "" : " qv-clip--off"}`}
      style={{
        left,
        width,
        top: LANE_PAD + lane * LANE_H,
        height: LANE_H - 4,
        borderLeftColor: meta.color,
        background: `linear-gradient(180deg, ${withAlpha(meta.color, 0.34)}, ${withAlpha(meta.color, 0.16)})`,
      }}
      title={clipTitle}
      onPointerDown={(e) => onPointerDown(e, "move", clip, trackId)}
      onContextMenu={(e) => onContextMenu(e, clip, trackId)}
      onDoubleClick={() => onStartRename(clip.id)}
    >
      <div
        className="qv-clip__handle qv-clip__handle--left"
        onPointerDown={(e) => onPointerDown(e, "trim-left", clip, trackId)}
      />
      {showsArtwork && (
        <div className="qv-clip__art-wrap">
          <ClipArtwork clip={clip} width={width} height={LANE_H - 4} color={meta.color} />
        </div>
      )}

      {/* 入场/出场转场的楔形标志：不挡指针，细节在片段的 tooltip 与检查器里。 */}
      {clip.transitionIn && clip.transitionIn.duration > 0 && (
        <div
          className="qv-clip__trans qv-clip__trans--in"
          style={{ width: wedgeWidth(clip.transitionIn.duration) }}
        />
      )}
      {clip.transitionOut && clip.transitionOut.duration > 0 && (
        <div
          className="qv-clip__trans qv-clip__trans--out"
          style={{ width: wedgeWidth(clip.transitionOut.duration) }}
        />
      )}
      {renaming ? (
        <input
          className="qv-clip__rename"
          defaultValue={clip.name}
          autoFocus
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={(e) => onCommitRename(clip, e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onCommitRename(clip, clip.name);
          }}
        />
      ) : (
        <div className="qv-clip__inner">
          <span className="qv-clip__icon" style={{ color: meta.color }}>
            {meta.icon}
          </span>
          {!narrow && <span className="qv-clip__name">{clip.name}</span>}
        </div>
      )}
      {width > 88 && !renaming && <span className="qv-clip__dur">{formatDuration(clip.duration)}</span>}

      {/* A grab strip over the diamond row. Falls through to the clip drag when
          the press does not land on a diamond, so it is never dead space. */}
      {animated && !renaming && (
        <div
          className="qv-clip__kf-lane"
          title={`${keyframeTimes.length} 个关键帧时刻${
            sizeMarkers > 0 ? `（${sizeMarkers} 个尺寸变化 ⇔）` : ""
          } · 左右拖动可改变时间`}
          onPointerDown={(e) => {
            const time = keyframeAt(e);
            if (time === null) return;
            onKeyframePointerDown(e, clip, time);
          }}
        />
      )}

      <div
        className="qv-clip__handle qv-clip__handle--right"
        onPointerDown={(e) => onPointerDown(e, "trim-right", clip, trackId)}
      />
    </div>
  );
}

/** Every distinct clip-local time that carries a keyframe, ascending. */
function mergedKeyframeTimes(clip: Clip): number[] {
  const times = new Set<number>();
  for (const frames of Object.values(clip.animation)) {
    for (const frame of frames) times.add(frame.time);
  }
  return Array.from(times).sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ *
 * Playhead
 * ------------------------------------------------------------------ */

function Playhead({ zoom, headerW }: { zoom: number; headerW: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      playback.onFrame((time) => {
        const el = ref.current;
        if (el) el.style.transform = `translateX(${headerW + time * zoom}px)`;
      }),
    [zoom, headerW],
  );
  return (
    <div className="qv-playhead" ref={ref}>
      <div className="qv-playhead__cap" />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function maxSourceDuration(project: Project, clip: Clip): number | null {
  switch (clip.kind) {
    case "video":
    case "audio": {
      const asset = findAsset(project, clip.props.assetId);
      return asset?.duration && asset.duration > 0 ? asset.duration : null;
    }
    default:
      return null;
  }
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
