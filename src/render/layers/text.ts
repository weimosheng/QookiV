import { EASINGS } from "../../core/easing";
import type { TextClipProps, TextStyle } from "../../core/types";
import { roundRectPath } from "../effects";
import { buildFontString, layoutText, revealUnits, unitProgress } from "../textLayout";
import type { TextLayout } from "../textLayout";
import type { DrawArgs, LayerBox, LayerDefinition, MeasureArgs } from "../types";

/**
 * Text layer: rich typography plus reveal animations.
 *
 * Per-glyph reveals need to draw glyph by glyph, which would normally drag a
 * gradient along with the translation. `blockGradient` compensates by building
 * the gradient in the glyph's local space, so animated text keeps a gradient
 * that stays pinned to the text block.
 */

function composeBlur(ctx: CanvasRenderingContext2D, px: number): string {
  const base = ctx.filter && ctx.filter !== "none" ? `${ctx.filter} ` : "";
  return `${base}blur(${px}px)`;
}

/**
 * Hands the style's tracking to the canvas for this line.
 *
 * `layoutText` models letter-spacing by widening every glyph's advance, but the
 * canvas only *draws* tracking when `ctx.letterSpacing` is set — without this the
 * painted run is narrower than the block the layout reserved, so a centred or
 * right-aligned line lands short of where it was measured. A `.36em` subtitle
 * (the "简约风" opener) sat about 33px left of centre, and the right-aligned
 * ending drifted 18px. Left-aligned text looked fine because its line offset is
 * zero either way, which is why this stayed invisible.
 *
 * Applied only on the whole-block path: the per-glyph reveal path already places
 * every glyph at the tracked advance and would otherwise count the spacing twice.
 */
function applyLetterSpacing(ctx: CanvasRenderingContext2D, style: TextStyle): void {
  const spacing = style.letterSpacing * style.fontSize;
  if (spacing === 0) return;
  const target = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (!("letterSpacing" in target)) return;
  target.letterSpacing = `${spacing}px`;
}

/** Gradient defined in text-block space, remapped into the current local space. */
function blockGradient(
  ctx: CanvasRenderingContext2D,
  style: TextStyle,
  blockW: number,
  blockH: number,
  tx: number,
  ty: number,
  s: number,
): CanvasGradient {
  const rad = ((style.gradient.angle - 90) * Math.PI) / 180;
  const cx = blockW / 2;
  const cy = blockH / 2;
  const len = (Math.abs(blockW * Math.cos(rad)) + Math.abs(blockH * Math.sin(rad))) / 2;
  const dx = Math.cos(rad) * len;
  const dy = Math.sin(rad) * len;
  const safe = s === 0 ? 1 : s;
  const g = ctx.createLinearGradient(
    (cx - dx - tx) / safe,
    (cy - dy - ty) / safe,
    (cx + dx - tx) / safe,
    (cy + dy - ty) / safe,
  );
  g.addColorStop(0, style.gradient.from);
  g.addColorStop(1, style.gradient.to);
  return g;
}

interface GlyphProgress {
  /** 0 = hidden, 1 = fully shown. */
  p: number;
  /** Which reveal unit this glyph belongs to. */
  unit: number;
}

function computeProgress(
  layout: TextLayout,
  props: TextClipProps,
  localTime: number,
): Map<number, GlyphProgress> | null {
  const mode = props.reveal;
  if (mode === "none") return null;
  const units = revealUnits(layout, mode, props.revealDuration, props.revealStagger);
  if (units.length === 0) return null;

  const map = new Map<number, GlyphProgress>();
  units.forEach((unit, ui) => {
    const p = unitProgress(unit, localTime);
    for (const idx of unit.indices) map.set(idx, { p, unit: ui });
  });
  return map;
}

export const textLayer: LayerDefinition = {
  measure(args: MeasureArgs): LayerBox {
    if (args.clip.kind !== "text") return { w: 1, h: 1 };
    const props = args.clip.props;
    args.ctx.save();
    args.ctx.font = buildFontString(props.style);
    const layout = layoutText(args.ctx, props.text, props.style);
    args.ctx.restore();
    return { w: layout.width, h: layout.height };
  },

  draw(args: DrawArgs): void {
    const { ctx, clip, localTime } = args;
    if (clip.kind !== "text") return;
    const props = clip.props;
    const style = props.style;

    ctx.save();
    ctx.font = buildFontString(style);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const layout = layoutText(ctx, props.text, style);
    const { width: bw, height: bh } = layout;

    // ---- whole-block reveal effects -------------------------------------
    let blockAlpha = 1;
    if (props.reveal === "maskWipe") {
      const p = Math.min(1, Math.max(0, localTime / Math.max(0.01, props.revealDuration)));
      const eased = EASINGS.easeOutQuart(p);
      ctx.beginPath();
      ctx.rect(-2, -bh * 0.3, bw * eased + 2, bh * 1.6);
      ctx.clip();
    } else if (props.reveal === "blurIn") {
      const p = Math.min(1, Math.max(0, localTime / Math.max(0.01, props.revealDuration)));
      const eased = EASINGS.easeOutQuart(p);
      ctx.filter = composeBlur(ctx, (1 - eased) * 22);
      blockAlpha = eased;
    }

    const progress = computeProgress(layout, props, localTime);
    const allVisible =
      !progress ||
      Array.from(progress.values()).every((g) => g.p >= 1);

    // ---- backdrop plate -------------------------------------------------
    if (style.background.enabled) {
      const { paddingX, paddingY, radius, color } = style.background;
      ctx.save();
      ctx.globalAlpha = blockAlpha;
      ctx.fillStyle = color;
      roundRectPath(ctx, -paddingX, -paddingY, bw + paddingX * 2, bh + paddingY * 2, radius);
      ctx.fill();
      ctx.restore();
    }

    // ---- paint ----------------------------------------------------------
    const paintStyle = (tx: number, ty: number, s: number): string | CanvasGradient =>
      style.gradient.enabled ? blockGradient(ctx, style, bw, bh, tx, ty, s) : style.color;

    const applyShadow = () => {
      if (style.glowBlur > 0) {
        ctx.shadowColor = style.glowColor;
        ctx.shadowBlur = style.glowBlur;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
    };

    if (allVisible) {
      // Fast path: one fill per line keeps native kerning and shaping.
      for (const line of layout.lines) {
        if (line.text.length === 0) continue;
        ctx.save();
        ctx.globalAlpha = blockAlpha;
        applyShadow();
        applyLetterSpacing(ctx, style);
        ctx.fillStyle = paintStyle(0, 0, 1);
        ctx.fillText(line.text, line.x, line.baseline);
        if (style.strokeWidth > 0) {
          ctx.lineWidth = style.strokeWidth;
          ctx.strokeStyle = style.strokeColor;
          ctx.lineJoin = "round";
          ctx.strokeText(line.text, line.x, line.baseline);
        }
        ctx.restore();
      }
    } else if (progress) {
      const isTypewriter = props.reveal === "typewriter";
      const isWordRise = props.reveal === "wordRise";
      const isCharPop = props.reveal === "charPop";

      // Word-level reveals move every glyph of a word together.
      const wordOffsets = new Map<number, { dy: number; alpha: number }>();
      if (isWordRise) {
        const seen = new Set<number>();
        for (const line of layout.lines) {
          for (const g of line.glyphs) {
            if (seen.has(g.word)) continue;
            seen.add(g.word);
            const info = progress.get(g.index);
            const p = info ? info.p : 1;
            const eased = EASINGS.easeOutCubic(p);
            wordOffsets.set(g.word, {
              dy: (1 - eased) * style.fontSize * 0.55,
              alpha: eased,
            });
          }
        }
      }

      for (const line of layout.lines) {
        for (const g of line.glyphs) {
          const info = progress.get(g.index);
          const p = info ? info.p : 1;
          if (p <= 0) continue;
          if (isTypewriter && p < 1) continue;

          let tScale = 1;
          let dx = 0;
          let dy = 0;
          let alpha = blockAlpha * p;

          if (isCharPop) {
            const eased = EASINGS.easeOutBack(p);
            tScale = 0.45 + 0.55 * eased;
          } else if (isWordRise) {
            const off = wordOffsets.get(g.word);
            if (off) {
              dy = off.dy;
              alpha = blockAlpha * off.alpha;
            }
          }

          const gx = line.x + g.x;
          const gy = line.baseline;
          ctx.save();
          ctx.globalAlpha = alpha;
          applyShadow();
          ctx.translate(gx + dx, gy + dy);
          if (tScale !== 1) ctx.scale(tScale, tScale);
          ctx.fillStyle = paintStyle(gx + dx, gy + dy, tScale);
          ctx.fillText(g.ch, 0, 0);
          if (style.strokeWidth > 0) {
            ctx.lineWidth = style.strokeWidth;
            ctx.strokeStyle = style.strokeColor;
            ctx.lineJoin = "round";
            ctx.strokeText(g.ch, 0, 0);
          }
          ctx.restore();
        }
      }

      // ---- typewriter caret ---------------------------------------------
      if (props.caret && isTypewriter) {
        const blinkOn = Math.floor(localTime * 2.6) % 2 === 0;
        if (blinkOn) {
          let lastLine = null as (typeof layout.lines)[number] | null;
          let lastGlyph = null as (typeof layout.lines)[number]["glyphs"][number] | null;
          for (const line of layout.lines) {
            for (const g of line.glyphs) {
              const info = progress.get(g.index);
              if (info && info.p > 0) {
                lastLine = line;
                lastGlyph = g;
              }
            }
          }
          if (lastLine && lastGlyph) {
            const caretX = lastLine.x + lastGlyph.x + lastGlyph.w;
            const caretH = style.fontSize * 0.98;
            ctx.save();
            ctx.globalAlpha = blockAlpha * 0.9;
            ctx.fillStyle = style.color;
            ctx.fillRect(caretX, lastLine.baseline - caretH * 0.8, Math.max(2, style.fontSize * 0.06), caretH);
            ctx.restore();
          }
        }
      }
    }

    ctx.restore();
  },
};
