import type { Project } from "../../core/types";
import { anchorPoint, cornersOf, handleLocalPositions, localToProject } from "../../render/scene";
import type { HandleId, LayerPlacement, Point } from "../../render/scene";

/**
 * Direct-manipulation overlay.
 *
 * Drawn onto the preview canvas straight after the frame, so it can never drift
 * away from the pixels it describes. Sizes are divided by `viewScale` so handles
 * stay a constant size on screen no matter how far the preview is zoomed out.
 */

const ACCENT = "#e29a5a";
const ACCENT_SOFT = "rgba(226, 154, 90, 0.9)";
const HOVER = "rgba(255, 255, 255, 0.55)";
const GUIDE = "rgba(111, 207, 151, 0.95)";

export interface OverlayOptions {
  /** Screen pixels per project pixel: project pixel = screen pixel / viewScale. */
  viewScale: number;
  /** Handles are hidden while playing or when more than one clip is selected. */
  interactive: boolean;
  hoverClipId?: string | null;
  /** Show the frame-centre alignment guides. */
  guideX?: boolean;
  guideY?: boolean;
}

/** Screen-space radius of a handle, in project pixels. */
export function handleRadius(viewScale: number): number {
  return 5.5 / Math.max(0.0001, viewScale);
}

/** Screen-space grab tolerance, in project pixels. */
export function grabRadius(viewScale: number): number {
  return 11 / Math.max(0.0001, viewScale);
}

/** Screen-space offset of the rotation handle, expressed along the layer's up axis. */
export function rotateHandleOffset(viewScale: number): number {
  return 30 / Math.max(0.0001, viewScale);
}

/**
 * Project-space position of a handle.
 *
 * `rotate` sits above the top edge along the layer's own up direction, so it
 * stays put as the layer turns.
 */
export function handlePoint(p: LayerPlacement, id: HandleId, viewScale: number): Point {
  if (id === "rotate") {
    const scale = Math.abs(p.scale) < 1e-6 ? 1e-6 : p.scale;
    return localToProject(p, p.box.w / 2, -rotateHandleOffset(viewScale) / scale);
  }
  const found = handleLocalPositions(p).find((h) => h.id === id);
  if (!found) return localToProject(p, p.box.w / 2, 0);
  return localToProject(p, found.x, found.y);
}

export const HANDLE_IDS: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"];

function polygon(ctx: CanvasRenderingContext2D, pts: Point[]): void {
  ctx.beginPath();
  pts.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.closePath();
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  project: Project,
  placements: LayerPlacement[],
  selection: string[],
  options: OverlayOptions,
): void {
  const { viewScale } = options;
  const { width, height } = project.settings;
  const r = handleRadius(viewScale);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.lineJoin = "miter";

  // ---- alignment guides -------------------------------------------------
  if (options.guideX || options.guideY) {
    ctx.save();
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1.5 / viewScale;
    ctx.setLineDash([8 / viewScale, 6 / viewScale]);
    if (options.guideX) {
      ctx.beginPath();
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width / 2, height);
      ctx.stroke();
    }
    if (options.guideY) {
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- hover outline ----------------------------------------------------
  if (options.hoverClipId && !selection.includes(options.hoverClipId)) {
    const hovered = placements.find((p) => p.clipId === options.hoverClipId);
    if (hovered) {
      ctx.save();
      ctx.strokeStyle = HOVER;
      ctx.lineWidth = 1.5 / viewScale;
      polygon(ctx, cornersOf(hovered));
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- selection --------------------------------------------------------
  const selected = placements.filter((p) => selection.includes(p.clipId));
  const single = selected.length === 1 && options.interactive;

  for (const p of selected) {
    const corners = cornersOf(p);

    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2 / viewScale;
    polygon(ctx, corners);
    ctx.stroke();

    // A dark hairline just outside the bright one keeps the frame legible over
    // both a white screenshot and a black background.
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1 / viewScale;
    ctx.stroke();
    ctx.restore();

    if (!single) continue;

    // Rotation handle stem.
    const top = handlePoint(p, "n", viewScale);
    const rot = handlePoint(p, "rotate", viewScale);
    ctx.save();
    ctx.strokeStyle = ACCENT_SOFT;
    ctx.lineWidth = 1.5 / viewScale;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(rot.x, rot.y);
    ctx.stroke();

    // Anchor cross, so the rotation/scale pivot is never a mystery.
    const anchor = anchorPoint(p);
    ctx.strokeStyle = "rgba(226, 154, 90, 0.85)";
    ctx.lineWidth = 1.5 / viewScale;
    const a = 7 / viewScale;
    ctx.beginPath();
    ctx.moveTo(anchor.x - a, anchor.y);
    ctx.lineTo(anchor.x + a, anchor.y);
    ctx.moveTo(anchor.x, anchor.y - a);
    ctx.lineTo(anchor.x, anchor.y + a);
    ctx.stroke();

    // Handles.
    for (const id of HANDLE_IDS) {
      const pt = handlePoint(p, id, viewScale);
      ctx.beginPath();
      if (id === "rotate") {
        ctx.arc(pt.x, pt.y, r * 1.15, 0, Math.PI * 2);
      } else {
        ctx.rect(pt.x - r, pt.y - r, r * 2, r * 2);
      }
      ctx.fillStyle = id === "rotate" ? ACCENT : "#14171f";
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2 / viewScale;
      ctx.stroke();
    }
    ctx.restore();

    // Name + intrinsic size, sized in screen pixels.
    const label = `${p.clip.name}  ${Math.round(p.box.w)}×${Math.round(p.box.h)}`;
    const fontSize = 12 / viewScale;
    ctx.save();
    ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const padX = 7 / viewScale;
    const padY = 4 / viewScale;
    const textW = ctx.measureText(label).width;
    // Place it above the top-left corner, or below if there is no room.
    const boxX = Math.min(...corners.map((c) => c.x));
    const boxY = Math.min(...corners.map((c) => c.y));
    const labelY = boxY - 8 / viewScale > fontSize ? boxY - 8 / viewScale : boxY + fontSize + 8 / viewScale;
    ctx.fillStyle = "rgba(10,12,18,0.82)";
    ctx.fillRect(boxX, labelY - fontSize, textW + padX * 2, fontSize + padY * 2);
    ctx.fillStyle = "#f2f3f7";
    ctx.fillText(label, boxX + padX, labelY + padY * 0.4);
    ctx.restore();
  }

  ctx.restore();
}
