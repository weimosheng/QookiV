import { makeLinearGradient } from "../../core/color";
import { polygonPath, roundRectPath, starPath } from "../effects";
import type { DrawArgs, LayerBox, LayerDefinition, MeasureArgs } from "../types";

/** Primitive shapes, sized in project pixels. */
export const shapeLayer: LayerDefinition = {
  measure(args: MeasureArgs): LayerBox {
    if (args.clip.kind !== "shape") return { w: 1, h: 1 };
    return { w: Math.max(1, args.clip.props.width), h: Math.max(1, args.clip.props.height) };
  },

  draw(args: DrawArgs): void {
    const { ctx, clip, box } = args;
    if (clip.kind !== "shape") return;
    const p = clip.props;
    const { w, h } = box;

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    switch (p.shape) {
      case "rect":
        roundRectPath(ctx, 0, 0, w, h, p.radius);
        break;

      case "ellipse":
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        break;

      case "triangle":
        polygonPath(ctx, w / 2, h / 2, Math.min(w, h) / 2, 3);
        break;

      case "star":
        starPath(ctx, w / 2, h / 2, Math.min(w, h) / 2, p.innerRadius, Math.max(3, p.points));
        break;

      case "line":
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        break;

      case "arrow": {
        const headW = Math.min(w * 0.34, h);
        const shaftH = Math.max(2, h * 0.28);
        const cy = h / 2;
        ctx.beginPath();
        ctx.moveTo(0, cy - shaftH / 2);
        ctx.lineTo(w - headW, cy - shaftH / 2);
        ctx.lineTo(w - headW, 0);
        ctx.lineTo(w, cy);
        ctx.lineTo(w - headW, h);
        ctx.lineTo(w - headW, cy + shaftH / 2);
        ctx.lineTo(0, cy + shaftH / 2);
        ctx.closePath();
        break;
      }
    }

    if (p.shape === "line") {
      ctx.strokeStyle = p.fillGradient.enabled
        ? makeLinearGradient(ctx, p.fillGradient.from, p.fillGradient.to, 0, 0, 0, w, h)
        : p.fill;
      ctx.lineWidth = Math.max(1, p.strokeWidth > 0 ? p.strokeWidth : h);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (p.fillGradient.enabled) {
      ctx.fillStyle = makeLinearGradient(
        ctx,
        p.fillGradient.from,
        p.fillGradient.to,
        p.fillGradient.angle,
        0,
        0,
        w,
        h,
        p.fillGradient.mid,
        p.fillGradient.midOffset ?? 0.5,
      );
    } else {
      ctx.fillStyle = p.fill;
    }
    ctx.fill();

    if (p.strokeWidth > 0) {
      ctx.strokeStyle = p.strokeColor;
      ctx.lineWidth = p.strokeWidth;
      ctx.stroke();
    }

    ctx.restore();
  },
};
