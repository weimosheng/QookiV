import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { effectiveDuration, formatTimecode } from "../core/time";
import { applyTransform } from "../core/transform";
import type { AnimationMap } from "../core/types";
import { mediaPool, thumbnailPool } from "../engine/sharedPool";
import { playback } from "../engine/PlaybackEngine";
import { Renderer } from "../render/Renderer";
import { handlePoint, HANDLE_IDS, grabRadius, drawOverlay } from "./preview/overlay";
import { anchorPoint, hitTest, placementFor } from "../render/scene";
import type { HandleId, LayerPlacement } from "../render/scene";
import { useEditor } from "../store/editorStore";
import { IconButton, Segmented } from "./controls";
import type { Option } from "./controls";
import { Camera, Pause, Play, Repeat, SkipBack, SkipForward, X } from "./icons";
import { useElementSize, useInOutPoints, usePlayhead, usePlaying, useRate } from "./hooks";
import { exportCurrentFrame } from "../services/exportFrame";

/**
 * Preview stage and transport.
 *
 * The canvas is rendered at the project's native resolution and scaled down by
 * CSS, so it costs nothing extra (the GPU composites it) and the preview shows
 * exactly the pixels the exporter will write. On top of that sits direct
 * manipulation: layers can be selected, moved, scaled and rotated right here.
 */

/** Pointer drag modes the preview understands. */
type DragMode = { kind: "move" } | { kind: "handle"; id: HandleId };

interface DragOrigin {
  /** Base transform at drag start. */
  base: { x: number; y: number; scale: number; rotation: number };
  /** Post-animation position at drag start, used for snapping. */
  visible: { x: number; y: number };
  animation: AnimationMap;
}

interface DragState {
  mode: DragMode;
  /** Pointer position in project pixels when the drag began. */
  startX: number;
  startY: number;
  ids: string[];
  origins: Map<string, DragOrigin>;
  /** Fixed pivot for scale/rotation, in project pixels. */
  pivot: { x: number; y: number };
  startDistance: number;
  startAngle: number;
  moved: boolean;
  /** Live guide flags while dragging. */
  guideX: boolean;
  guideY: boolean;
}

export function Preview() {
  const project = useEditor((s) => s.project);
  const selection = useEditor((s) => s.selection);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);

  // Geometry the pointer handlers read. Frames are produced imperatively, so
  // this is kept in refs rather than state to avoid a re-render per frame.
  const placementsRef = useRef<LayerPlacement[]>([]);
  const viewScaleRef = useRef(1);
  const selectionRef = useRef<string[]>(selection);
  selectionRef.current = selection;
  const hoverRef = useRef<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const guidesRef = useRef({ x: false, y: false });

  const [hoverId, setHoverId] = useState<string | null>(null);
  hoverRef.current = hoverId;

  if (!rendererRef.current) rendererRef.current = new Renderer(project, mediaPool);
  const renderer = rendererRef.current;

  /* ---------------- stage sizing ---------------- */

  const [stageEl, stageSize] = useElementSize<HTMLDivElement>();
  const { width: pw, height: ph } = project.settings;
  const fitted = useMemo(() => {
    const pad = 34;
    const availW = Math.max(80, (stageSize.width || 640) - pad);
    const availH = Math.max(60, (stageSize.height || 360) - pad);
    const scale = Math.min(availW / pw, availH / ph);
    return {
      width: Math.max(40, Math.floor(pw * scale)),
      height: Math.max(30, Math.floor(ph * scale)),
      scale: Math.max(1e-6, scale),
    };
  }, [stageSize.width, stageSize.height, pw, ph]);
  viewScaleRef.current = fitted.scale;

  /* ---------------- project / media sync ---------------- */

  useEffect(() => {
    mediaPool.sync(project.assets);
    /*
     * 胶片条用的是**另一个池**（`thumbnailPool`），所以这里也要让它跟上素材：
     * 抽帧靠 seek 实现，若和预览共用元素，一暂停就会去拽预览正在显示的那一帧。
     * 画廊会自己 sync，但时间线上的胶片条不该指望画廊先打开过。
     */
    thumbnailPool.sync(project.assets);
    renderer.setProject(project);
    playback.setDuration(project);
    playback.invalidate();
  }, [project, renderer]);

  /* ---------------- frame loop ---------------- */

  // A browser that refuses to start media produces silence plus a stalled
  // picture; say so instead of letting it look like a broken project.
  useEffect(() => {
    mediaPool.onPlaybackBlocked = () => {
      useEditor
        .getState()
        .setStatus("浏览器阻止了媒体自动播放，请先点一下预览画面，再按空格播放", "error");
    };
    return () => {
      mediaPool.onPlaybackBlocked = undefined;
    };
  }, []);

  /*
   * 播放"看着在卡"有两种完全不同的成因，直接报出来，别让人靠猜：
   *   - 片段比素材长 → 尾部停在最后一帧（设计如此，裁短片段即可）；
   *   - 同步每秒纠正好几次 → 元素一直在被拽（真正的卡）。
   */
  useEffect(() => {
    mediaPool.onSyncIssue = (issue) => {
      const store = useEditor.getState();
      if (issue.kind === "frozen") {
        store.setStatus(
          `「${issue.name}」需要的素材比文件长（文件 ${issue.available.toFixed(1)}s / 片段用到 ${issue.needed.toFixed(1)}s），尾部停在最后一帧——把片段裁短即可`,
          "error",
        );
        return;
      }
      store.setStatus(
        `播放同步每秒纠正 ${issue.corrections} 次（涉及「${issue.name}」），这一段可能在卡`,
        "error",
      );
    };
    return () => {
      mediaPool.onSyncIssue = undefined;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }

    let wasPlaying = playback.playing;
    let lastEpoch = playback.epoch;
    return playback.onFrame((time, playing) => {
      if (playing) {
        /*
         * 只有**真跳变**（用户拖动播放头、时间线绕回开头）才允许把素材拽到新位置，
         * 其余时候时钟说了算：素材按持久漂移被纠正，而不是让时钟去追某一个素材——
         * 两个视频一起播时，"追领先最远的那个"会把另一个判成落后并反复 seek。
         */
        const exact = playback.epoch !== lastEpoch;
        lastEpoch = playback.epoch;
        mediaPool.playVideos(project, time, { exact });
        mediaPool.playAudio(project, time, { exact });
      } else if (wasPlaying) {
        mediaPool.pauseAll();
      }
      wasPlaying = playing;

      const placements = renderer.renderFrame(ctx, time, { quality: "preview" });
      placementsRef.current = placements;

      // Manipulation chrome is drawn on the same canvas so it cannot drift from
      // the pixels, and is suppressed during playback so the cut plays clean.
      if (!playing) {
        drawOverlay(ctx, project, placements, selectionRef.current, {
          viewScale: viewScaleRef.current,
          interactive: true,
          hoverClipId: hoverRef.current,
          guideX: guidesRef.current.x,
          guideY: guidesRef.current.y,
        });
      }
    });
  }, [project, renderer, pw]);

  /* ---------------- pointer interaction ---------------- */

  const toProject = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scale = rect.width / Math.max(1, pw);
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  }, [pw]);

  const redraw = useCallback(() => playback.invalidate(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const store = useEditor.getState();
    playback.pause();

    const point = toProject(e.clientX, e.clientY);
    const placements = placementsRef.current;
    const viewScale = viewScaleRef.current;
    const selected = selectionRef.current;

    // 1) A handle of the single selected clip wins over everything else.
    if (selected.length === 1) {
      const p = placementFor(placements, selected[0]);
      if (p) {
        const tolerance = grabRadius(viewScale);
        let best: HandleId | null = null;
        let bestDist = Infinity;
        for (const id of HANDLE_IDS) {
          const hp = handlePoint(p, id, viewScale);
          const d = Math.hypot(hp.x - point.x, hp.y - point.y);
          if (d < tolerance && d < bestDist) {
            best = id;
            bestDist = d;
          }
        }
        if (best) {
          beginDrag(e, { kind: "handle", id: best }, p.clipId, point);
          return;
        }
      }
    }

    // 2) Otherwise pick the topmost layer under the cursor.
    const hit = hitTest(placements, point.x, point.y);
    if (!hit) {
      store.clearSelection();
      redraw();
      return;
    }

    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!selected.includes(hit.clipId)) {
      store.select([hit.clipId], additive ? "add" : "replace");
    } else if (additive) {
      store.select([hit.clipId], "toggle");
      redraw();
      return;
    }

    beginDrag(e, { kind: "move" }, hit.clipId, point);
  };

  const beginDrag = (
    e: ReactPointerEvent<HTMLCanvasElement>,
    mode: DragMode,
    clipId: string,
    point: { x: number; y: number },
  ) => {
    const store = useEditor.getState();
    const ids = store.selection.includes(clipId) ? store.selection : [clipId];

    const origins = new Map<string, DragOrigin>();
    for (const id of ids) {
      const clip = store.project.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
      if (!clip) continue;
      // The base transform is what gets edited; the resolved placement tells us
      // where the element actually is, which is what snapping must compare.
      const placement = placementFor(placementsRef.current, id);
      origins.set(id, {
        base: {
          x: clip.transform.x,
          y: clip.transform.y,
          scale: clip.transform.scale,
          rotation: clip.transform.rotation,
        },
        visible: {
          x: placement?.clip.transform.x ?? clip.transform.x,
          y: placement?.clip.transform.y ?? clip.transform.y,
        },
        animation: clip.animation,
      });
    }
    if (origins.size === 0) return;

    const placement = placementFor(placementsRef.current, clipId);
    const pivot = placement ? anchorPoint(placement) : { x: 0, y: 0 };

    dragRef.current = {
      mode,
      startX: point.x,
      startY: point.y,
      ids,
      origins,
      pivot,
      startDistance: Math.max(1, Math.hypot(point.x - pivot.x, point.y - pivot.y)),
      startAngle: Math.atan2(point.y - pivot.y, point.x - pivot.x),
      moved: false,
      guideX: false,
      guideY: false,
    };

    store.beginHistory();

    const canvas = canvasRef.current;
    canvas?.setPointerCapture?.(e.pointerId);
    if (canvas) {
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", endDrag);
      canvas.addEventListener("pointercancel", endDrag);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const store = useEditor.getState();
    const point = toProject(e.clientX, e.clientY);
    const viewScale = viewScaleRef.current;

    // A tiny dead zone makes a plain click feel like a click, not a drag.
    if (!drag.moved && Math.hypot(point.x - drag.startX, point.y - drag.startY) * viewScale < 3) {
      return;
    }
    drag.moved = true;

    if (drag.mode.kind === "move") {
      let dx = point.x - drag.startX;
      let dy = point.y - drag.startY;

      // Shift locks the move to whichever axis has travelled further.
      if (e.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }

      const primary = drag.origins.get(drag.ids[0]);
      if (!primary) return;

      const snapThreshold = 7 / viewScale;
      const candidates = alignmentCandidates(placementsRef.current, drag.ids);

      // Snap in *visible* space, then carry the same delta onto the base value.
      let visibleX = primary.visible.x + dx;
      let visibleY = primary.visible.y + dy;
      drag.guideX = false;
      drag.guideY = false;

      const snapX = nearestWithin(visibleX, candidates.x, snapThreshold);
      if (snapX !== null) {
        visibleX = snapX;
        drag.guideX = snapX === 0;
      }
      const snapY = nearestWithin(visibleY, candidates.y, snapThreshold);
      if (snapY !== null) {
        visibleY = snapY;
        drag.guideY = snapY === 0;
      }

      guidesRef.current = { x: drag.guideX, y: drag.guideY };

      const baseX = primary.base.x + (visibleX - primary.visible.x);
      const baseY = primary.base.y + (visibleY - primary.visible.y);

      store.updateClips(
        drag.ids,
        (clip) => {
          const origin = drag.origins.get(clip.id);
          if (!origin) return clip;
          // Shifting the keyframes too is what makes a clip with an animated
          // entrance actually follow the pointer on both axes.
          return applyTransform(
            clip,
            { ...origin.base, animation: origin.animation },
            { x: origin.base.x + (baseX - primary.base.x), y: origin.base.y + (baseY - primary.base.y) },
          );
        },
        { history: false },
      );
      return;
    }

    /* ---- scale ---- */
    if (drag.mode.id !== "rotate") {
      const distance = Math.max(1, Math.hypot(point.x - drag.pivot.x, point.y - drag.pivot.y));
      const factor = distance / drag.startDistance;
      store.updateClips(
        drag.ids,
        (clip) => {
          const origin = drag.origins.get(clip.id);
          if (!origin) return clip;
          const scale = clamp(origin.base.scale * factor, 0.02, 8);
          return applyTransform(clip, { ...origin.base, animation: origin.animation }, { scale });
        },
        { history: false },
      );
      return;
    }

    /* ---- rotate ---- */
    const angle = Math.atan2(point.y - drag.pivot.y, point.x - drag.pivot.x);
    let deltaDegrees = ((angle - drag.startAngle) * 180) / Math.PI;
    if (e.shiftKey) deltaDegrees = Math.round(deltaDegrees / 15) * 15;

    store.updateClips(
      drag.ids,
      (clip) => {
        const origin = drag.origins.get(clip.id);
        if (!origin) return clip;
        return applyTransform(
          clip,
          { ...origin.base, animation: origin.animation },
          { rotation: normalizeDegrees(origin.base.rotation + deltaDegrees) },
        );
      },
      { history: false },
    );
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    guidesRef.current = { x: false, y: false };
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
    }
    if (drag) useEditor.getState().endHistory();
    redraw();
  };

  const onPointerMoveHover = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) return;
    const point = toProject(e.clientX, e.clientY);
    const hit = hitTest(placementsRef.current, point.x, point.y);
    const next = hit?.clipId ?? null;
    if (next !== hoverRef.current) {
      setHoverId(next);
      redraw();
    }
  };

  // A drag must not outlive the component.
  useEffect(
    () => () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
    },
    [],
  );

  const toggleFullscreen = () => {
    const el = stageEl.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => undefined);
  };

  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // F11 全屏预览：放在 Preview 内部监听，避免和编辑器壳的全局 keydown 抢键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F11") return;
      e.preventDefault();
      toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="qv-preview">
      <div className="qv-preview__stage" ref={stageEl}>
        <div
          className="qv-preview__frame"
          style={{ width: fitted.width, height: fitted.height }}
        >
          <canvas
            ref={canvasRef}
            className="qv-preview__canvas"
            width={pw}
            height={ph}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMoveHover}
            onPointerLeave={() => {
              if (hoverRef.current !== null) {
                setHoverId(null);
                redraw();
              }
            }}
          />
        </div>
        {!isFullscreen && (
          <div className="qv-preview__hint">
            在预览中直接拖动元素可移动，拖角点缩放，拖顶部圆点旋转；Shift 锁定方向
          </div>
        )}
        <button
          type="button"
          className="qv-preview__fullscreen"
          title="全屏预览 (F11)"
          onClick={toggleFullscreen}
        >
          ⤢
        </button>
        {isFullscreen && <FullscreenOverlay onExit={toggleFullscreen} />}
      </div>
      <Transport />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Fullscreen overlay controls
 * ------------------------------------------------------------------ */

function FullscreenOverlay({ onExit }: { onExit: () => void }) {
  const project = useEditor((s) => s.project);
  const time = usePlayhead(40);
  const playing = usePlaying();
  const duration = effectiveDuration(project);
  const fps = project.settings.fps;
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<number | undefined>(undefined);

  const showControls = useCallback(() => {
    setVisible(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setVisible(false), 3000);
  }, []);

  useEffect(() => {
    showControls();
    return () => window.clearTimeout(timerRef.current);
  }, [showControls]);

  return (
    <div
      className={`qv-fs-overlay${visible ? " qv-fs-overlay--on" : ""}`}
      onMouseMove={showControls}
    >
      <button
        type="button"
        className="qv-fs-exit"
        title="退出全屏 (F11 / Esc)"
        onClick={onExit}
      >
        <X size={18} />
      </button>
      <div className="qv-fs-bar">
        <button
          type="button"
          className="qv-fs-play"
          title={playing ? "暂停 (空格)" : "播放 (空格)"}
          onClick={() => playback.toggle()}
        >
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <span className="qv-fs-tc">{formatTimecode(time, fps)}</span>
        <input
          className="qv-fs-scrub"
          type="range"
          min={0}
          max={Math.max(0.1, duration)}
          step={1 / Math.max(1, fps)}
          value={Math.min(time, duration)}
          onChange={(e) => {
            playback.pause();
            playback.seek(Number(e.target.value));
          }}
        />
        <span className="qv-fs-tc qv-fs-tc--dim">{formatTimecode(duration, fps)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

/** Candidate *visible* x/y offsets to snap a moving layer against. */
function alignmentCandidates(
  placements: LayerPlacement[],
  exclude: string[],
): { x: number[]; y: number[] } {
  const skip = new Set(exclude);
  // The frame centre is always a candidate; aligning two elements by eye is
  // otherwise hopeless.
  const x = [0];
  const y = [0];
  for (const p of placements) {
    if (skip.has(p.clipId) || p.alpha < 0.12) continue;
    x.push(p.clip.transform.x);
    y.push(p.clip.transform.y);
  }
  return { x, y };
}

/**
 * Nearest candidate within `threshold`, or null.
 *
 * Picking the nearest rather than the first match matters because many sibling
 * layers share a coordinate (every card in a row shares its y), and jumping to a
 * merely-close value instead of the closest one makes a drag feel like it is
 * fighting the cursor.
 */
function nearestWithin(value: number, candidates: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestDistance = threshold;
  for (const candidate of candidates) {
    const distance = Math.abs(value - candidate);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function normalizeDegrees(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.round(d * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

const RATE_OPTIONS: Array<Option<string>> = [
  { value: "0.25", label: "0.25x" },
  { value: "0.5", label: "0.5x" },
  { value: "1", label: "1x" },
  { value: "1.5", label: "1.5x" },
  { value: "2", label: "2x" },
];

function Transport() {
  const project = useEditor((s) => s.project);
  const time = usePlayhead(40);
  const playing = usePlaying();
  const { inPoint, outPoint } = useInOutPoints();
  const rate = useRate();
  const duration = effectiveDuration(project);
  const fps = project.settings.fps;

  return (
    <div className="qv-transport">
      <div className="qv-transport__buttons">
        <IconButton
          icon={<SkipBack size={15} />}
          title="回到开头 (Home)"
          onClick={() => playback.seek(0)}
        />
        <IconButton
          icon={<FrameStep back />}
          title="上一帧 (←)"
          onClick={() => playback.stepFrames(-1)}
        />
        <button
          type="button"
          className="qv-play"
          title={playing ? "暂停 (空格)" : "播放 (空格)"}
          onClick={() => playback.toggle()}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <IconButton
          icon={<FrameStep />}
          title="下一帧 (→)"
          onClick={() => playback.stepFrames(1)}
        />
        <IconButton
          icon={<SkipForward size={15} />}
          title="跳到结尾 (End)"
          onClick={() => playback.seek(duration)}
        />
        <IconButton
          icon={<Repeat size={15} />}
          title={playback.loop ? "循环播放：开" : "循环播放：关"}
          active={playback.loop}
          onClick={() => {
            playback.loop = !playback.loop;
            playback.invalidate();
          }}
        />
      </div>

      <div className="qv-transport__rate" title="播放速率">
        <Segmented
          value={String(rate)}
          onChange={(v) => playback.setRate(Number(v))}
          options={RATE_OPTIONS}
        />
      </div>

      <div className="qv-transport__time">
        <span className="qv-timecode">{formatTimecode(time, fps)}</span>
        <span className="qv-timecode qv-timecode--dim">/ {formatTimecode(duration, fps)}</span>
      </div>

      {(inPoint !== null || outPoint !== null) && (
        <div className="qv-transport__inout">
          {inPoint !== null && (
            <span className="qv-mark qv-mark--in" title="入点 (Shift+I 清除)">
              <span className="qv-mark__label">入</span>
              <span className="qv-mark__tc">{formatTimecode(inPoint, fps)}</span>
              <button
                type="button"
                className="qv-mark__clear"
                title="清除入点"
                onClick={() => {
                  playback.clearIn();
                  playback.invalidate();
                }}
              >
                <X size={10} />
              </button>
            </span>
          )}
          {outPoint !== null && (
            <span className="qv-mark qv-mark--out" title="出点 (Shift+O 清除)">
              <span className="qv-mark__label">出</span>
              <span className="qv-mark__tc">{formatTimecode(outPoint, fps)}</span>
              <button
                type="button"
                className="qv-mark__clear"
                title="清除出点"
                onClick={() => {
                  playback.clearOut();
                  playback.invalidate();
                }}
              >
                <X size={10} />
              </button>
            </span>
          )}
        </div>
      )}

      <input
        className="qv-scrub"
        type="range"
        min={0}
        max={Math.max(0.1, duration)}
        step={1 / Math.max(1, fps)}
        value={Math.min(time, duration)}
        onChange={(e) => {
          playback.pause();
          playback.seek(Number(e.target.value));
        }}
      />

      <div className="qv-transport__meta">
        <IconButton
          icon={<Camera size={15} />}
          title="导出当前帧为 PNG (Ctrl+Shift+F)"
          onClick={() => void exportCurrentFrame()}
        />
        <span className="qv-badge">
          {project.settings.width}×{project.settings.height}
        </span>
        <span className="qv-badge">{fps} fps</span>
        <span className="qv-badge qv-badge--dim">{project.settings.aspect}</span>
      </div>
    </div>
  );
}

/** A "step one frame" glyph; `back` mirrors it for rewinding. */
function FrameStep({ back = false }: { back?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={back ? { transform: "scaleX(-1)" } : undefined}
    >
      <polygon points="5 4 15 12 5 20 5 4" fill="currentColor" stroke="none" />
      <line x1="19" y1="5" x2="19" y2="19" />
    </svg>
  );
}
