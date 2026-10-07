import { makeLinearGradient, parseColor } from "../../core/color";
import type { BackgroundClipProps } from "../../core/types";
import type { DrawArgs, LayerBox, LayerDefinition, MeasureArgs } from "../types";

/**
 * Full-frame background layer: base colour, gradient, animated pattern, drifting
 * brand blobs and a vignette. Every element is a pure function of time so the
 * layer is deterministic for export.
 */

/* ------------------------------------------------------------------ *
 * Cached noise tile
 * ------------------------------------------------------------------ */

let noiseTile: HTMLCanvasElement | null = null;

function getNoiseTile(): HTMLCanvasElement | null {
  if (noiseTile) return noiseTile;
  if (typeof document === "undefined") return null;
  const size = 160;
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  const img = tctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 120 + Math.random() * 135;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = Math.random() * 46;
  }
  tctx.putImageData(img, 0, 0);
  noiseTile = tile;
  return tile;
}

/* ------------------------------------------------------------------ *
 * Patterns
 * ------------------------------------------------------------------ */

function drawPattern(
  ctx: CanvasRenderingContext2D,
  props: BackgroundClipProps,
  w: number,
  h: number,
  time: number,
): void {
  const scale = Math.max(8, props.patternScale);
  const drift = (time * props.patternSpeed) % scale;
  ctx.save();
  ctx.strokeStyle = props.patternColor;
  ctx.fillStyle = props.patternColor;

  switch (props.pattern) {
    case "grid": {
      ctx.lineWidth = Math.max(1, scale / 44);
      ctx.beginPath();
      for (let x = -scale + drift; x <= w + scale; x += scale) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
      }
      for (let y = -scale + drift; y <= h + scale; y += scale) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
      }
      ctx.stroke();
      break;
    }

    case "pixelGrid": {
      // Chunky two-tone checker that echoes the pixel-art brand mark.
      const step = scale;
      const phase = Math.floor(drift / step);
      for (let gy = 0, ry = -step + (drift % step); ry <= h + step; ry += step, gy += 1) {
        for (let gx = 0, rx = -step + (drift % step); rx <= w + step; rx += step, gx += 1) {
          if ((gx + gy + phase) % 2 === 0) continue;
          ctx.fillRect(rx, ry, step, step);
        }
      }
      break;
    }

    case "dots": {
      const r = Math.max(2, scale / 9);
      for (let x = -scale + drift; x <= w + scale; x += scale) {
        for (let y = -scale + drift; y <= h + scale; y += scale) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }

    case "noise": {
      const tile = getNoiseTile();
      if (!tile) break;
      const pattern = ctx.createPattern(tile, "repeat");
      if (!pattern) break;
      const off = drift * 3;
      ctx.save();
      ctx.translate(-off, -off * 0.6);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, w + off + tile.width, h + off + tile.height);
      ctx.restore();
      break;
    }

    case "rays": {
      const cx = w / 2;
      const cy = h / 2;
      const count = Math.max(6, Math.round(scale / 6));
      const radius = Math.hypot(w, h);
      const spin = (time * props.patternSpeed * Math.PI) / 180;
      for (let i = 0; i < count; i += 1) {
        const a0 = spin + (i * Math.PI * 2) / count;
        const a1 = a0 + Math.PI / count;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius);
        ctx.lineTo(cx + Math.cos(a1) * radius, cy + Math.sin(a1) * radius);
        ctx.closePath();
        ctx.globalAlpha = 0.55;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }

    case "waves": {
      const amplitude = scale / 2.6;
      const rows = Math.max(2, Math.round(h / (scale * 2.4)));
      ctx.lineWidth = Math.max(2, scale / 22);
      for (let r = 0; r < rows; r += 1) {
        const baseY = (h / (rows + 1)) * (r + 1);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 12) {
          const y =
            baseY +
            Math.sin((x / scale) * 2 + time * props.patternSpeed * 0.06 + r) * amplitude;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }

    case "none":
    default:
      break;
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Layer
 * ------------------------------------------------------------------ */

export const backgroundLayer: LayerDefinition = {
  measure(args: MeasureArgs): LayerBox {
    return { w: args.project.settings.width, h: args.project.settings.height };
  },

  draw(args: DrawArgs): void {
    const { ctx, clip, box, time } = args;
    if (clip.kind !== "background") return;
    const props = clip.props;
    const { w, h } = box;

    ctx.save();
    ctx.fillStyle = props.color;
    ctx.fillRect(0, 0, w, h);

    if (props.gradient.enabled) {
      ctx.fillStyle = makeLinearGradient(
        ctx,
        props.gradient.from,
        props.gradient.to,
        props.gradient.angle,
        0,
        0,
        w,
        h,
      );
      ctx.fillRect(0, 0, w, h);
    }

    // Drifting brand blobs, drawn additively so overlaps bloom.
    if (props.blobs.length > 0) {
      ctx.globalCompositeOperation = "lighter";
      const base = Math.min(w, h);
      for (const blob of props.blobs) {
        const angle = (time * blob.speed * Math.PI) / 180;
        const orbit = base * 0.05;
        const cx = blob.x * w + Math.cos(angle) * orbit;
        const cy = blob.y * h + Math.sin(angle) * orbit;
        const r = (blob.radius / 1080) * base;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r));
        g.addColorStop(0, blob.color);
        g.addColorStop(0.55, blob.color.replace(/[\d.]+\)$/, "0.10)"));
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
    }

    if (props.pattern !== "none") {
      ctx.globalAlpha = 1;
      drawPattern(ctx, props, w, h, time);
    }

    if (props.vignette > 0) {
      const g = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.28,
        w / 2,
        h / 2,
        Math.hypot(w, h) * 0.62,
      );
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${Math.min(0.95, props.vignette)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.restore();
  },
};

/** Exposed so the inspector can show a swatch of the resolved base colour. */
export function backgroundBaseColor(props: BackgroundClipProps): string {
  return props.color;
}

/** Kept for parity with other layers that need alpha-aware parsing. */
export function backgroundAlpha(props: BackgroundClipProps): number {
  return parseColor(props.color).a;
}
