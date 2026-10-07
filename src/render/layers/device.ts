import { readableOn, withAlpha } from "../../core/color";
import type { DeviceClipProps } from "../../core/types";
import { roundRectPath } from "../effects";
import { drawPlaceholder, fitRect } from "../types";
import type { DrawArgs, LayerBox, LayerDefinition, MeasureArgs } from "../types";

/**
 * Device / browser mock layer — the workhorse of software promo videos.
 *
 * Draws a chrome frame (browser, desktop window, phone, tablet) with a
 * screenshot or screen recording fitted inside it, plus an optional pseudo-3D
 * tilt and gloss.
 */

interface Chrome {
  /** Height of the title/URL bar. */
  barH: number;
  /** Symmetric bezel for handheld devices. */
  bezel: number;
  /** Outer corner radius actually used. */
  radius: number;
  screen: { x: number; y: number; w: number; h: number };
  screenRadius: number;
}

function chromeFor(props: DeviceClipProps, w: number, h: number): Chrome {
  const radius = Math.max(0, props.radius);
  switch (props.device) {
    case "browser": {
      const barH = Math.max(30, h * 0.072);
      return {
        barH,
        bezel: 0,
        radius,
        screen: { x: 0, y: barH, w, h: h - barH },
        screenRadius: 0,
      };
    }
    case "window": {
      const barH = Math.max(26, h * 0.058);
      return {
        barH,
        bezel: 0,
        radius,
        screen: { x: 0, y: barH, w, h: h - barH },
        screenRadius: 0,
      };
    }
    case "phone": {
      const bezel = Math.max(10, w * 0.03);
      const r = Math.max(radius, w * 0.08);
      return {
        barH: bezel,
        bezel,
        radius: r,
        screen: { x: bezel, y: bezel, w: w - bezel * 2, h: h - bezel * 2 },
        screenRadius: Math.max(0, r - bezel),
      };
    }
    case "tablet": {
      const bezel = Math.max(12, w * 0.022);
      const r = Math.max(radius, w * 0.045);
      return {
        barH: bezel,
        bezel,
        radius: r,
        screen: { x: bezel, y: bezel, w: w - bezel * 2, h: h - bezel * 2 },
        screenRadius: Math.max(0, r - bezel),
      };
    }
    case "bare":
    default:
      return {
        barH: 0,
        bezel: 0,
        radius,
        screen: { x: 0, y: 0, w, h },
        screenRadius: radius,
      };
  }
}

function drawTrafficLights(
  ctx: CanvasRenderingContext2D,
  props: DeviceClipProps,
  barH: number,
  accent: string,
): void {
  const r = Math.max(3, barH * 0.105);
  const gap = r * 3.1;
  const x = Math.max(barH * 0.5, r * 2.2);
  const y = barH / 2;
  const fg = readableOn(props.frameColor);
  const colors = [accent, withAlpha(fg, 0.26), withAlpha(fg, 0.16)];
  colors.forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(x + gap * i, y, r, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
  });
}

function drawUrlBar(
  ctx: CanvasRenderingContext2D,
  props: DeviceClipProps,
  barH: number,
  w: number,
): void {
  const pillH = barH * 0.52;
  const maxW = w * 0.62;
  const fg = readableOn(props.frameColor);
  ctx.font = `500 ${Math.round(barH * 0.3)}px "Segoe UI", system-ui, sans-serif`;
  const textW = props.url ? ctx.measureText(props.url).width : 0;
  const pillW = Math.min(maxW, Math.max(pillH * 3.4, textW + pillH * 1.6));
  const x = (w - pillW) / 2;
  const y = (barH - pillH) / 2;

  roundRectPath(ctx, x, y, pillW, pillH, pillH / 2);
  ctx.fillStyle = withAlpha(fg, 0.12);
  ctx.fill();

  if (props.url) {
    ctx.fillStyle = withAlpha(fg, 0.62);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(props.url, w / 2, barH / 2 + barH * 0.02);
  }
}

export const deviceLayer: LayerDefinition = {
  measure(args: MeasureArgs): LayerBox {
    if (args.clip.kind !== "device") return { w: 1, h: 1 };
    return { w: Math.max(1, args.clip.props.width), h: Math.max(1, args.clip.props.height) };
  },

  draw(args: DrawArgs): void {
    const { ctx, clip, box, project, sourceTime, media } = args;
    if (clip.kind !== "device") return;
    const props = clip.props;
    const { w, h } = box;
    const accent = project.theme.accent;

    ctx.save();

    // Pseudo-3D tilt: an orthographic squeeze plus a touch of skew reads as a
    // turned device without needing a perspective matrix.
    const tx = (props.tiltX * Math.PI) / 180;
    const ty = (props.tiltY * Math.PI) / 180;
    if (tx !== 0 || ty !== 0) {
      ctx.translate(w / 2, h / 2);
      ctx.transform(
        Math.cos(ty),
        Math.sin(ty) * 0.1,
        -Math.sin(tx) * 0.1,
        Math.cos(tx),
        0,
        0,
      );
      ctx.translate(-w / 2, -h / 2);
    }

    const chrome = chromeFor(props, w, h);

    // ---- frame body -----------------------------------------------------
    if (props.device !== "bare") {
      ctx.save();
      if (props.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.42)";
        ctx.shadowBlur = Math.min(w, h) * 0.075;
        ctx.shadowOffsetY = Math.min(w, h) * 0.028;
      }
      roundRectPath(ctx, 0, 0, w, h, chrome.radius);
      ctx.fillStyle = props.frameColor;
      ctx.fill();
      ctx.restore();
    }

    // ---- screen content -------------------------------------------------
    const screen = chrome.screen;
    ctx.save();
    roundRectPath(ctx, screen.x, screen.y, screen.w, screen.h, chrome.screenRadius);
    ctx.clip();

    const pad = Math.max(0, props.padding);
    const inner = {
      x: screen.x + pad,
      y: screen.y + pad,
      w: Math.max(1, screen.w - pad * 2),
      h: Math.max(1, screen.h - pad * 2),
    };

    const source = props.assetId ? media.getImage(props.assetId) : null;
    const video = !source && props.assetId ? media.getVideo(props.assetId, sourceTime) : null;
    const media0 = source ?? video;

    if (media0) {
      const known = media.getSize(props.assetId);
      const el = media0 as unknown as {
        videoWidth?: number;
        videoHeight?: number;
        naturalWidth?: number;
        naturalHeight?: number;
        width?: number;
        height?: number;
      };
      const srcW =
        el.videoWidth || el.naturalWidth || (typeof el.width === "number" ? el.width : 0) ||
        known?.width || inner.w;
      const srcH =
        el.videoHeight || el.naturalHeight || (typeof el.height === "number" ? el.height : 0) ||
        known?.height || inner.h;
      const rect = fitRect(srcW, srcH, inner.w, inner.h, props.fit, 0.5, 0);
      /**
       * 取景偏移（长截图在窗口内滚动）。
       *
       * `fit: "cover"` 时截图往往比取景窗高，`props.scroll` 就是"滚到底的比例"：
       * 可滚动的行程 = 截图实高 − 取景窗高，乘上比例往上推。0 时完全不位移，
       * 所以旧工程（没有这个字段）渲染结果和以前一模一样。
       */
      const slack = Math.max(0, rect.h - inner.h);
      const scroll = Math.max(0, Math.min(1, props.scroll ?? 0));
      const drawY = rect.y - slack * scroll;
      try {
        ctx.drawImage(media0, rect.x, drawY, rect.w, rect.h);
      } catch {
        drawPlaceholder(ctx, inner.w, inner.h, "解码中…");
      }
    } else {
      drawPlaceholder(ctx, inner.w, inner.h, props.assetId ? "正在载入截图…" : "放入截图");
    }
    ctx.restore();

    // ---- chrome ---------------------------------------------------------
    if (props.device === "browser") {
      const barBottom = chrome.barH;
      ctx.save();
      roundRectPath(ctx, 0, 0, w, barBottom, chrome.radius);
      ctx.clip();
      ctx.fillStyle = withAlpha(
        readableOn(props.frameColor) === "#ffffff" ? "#ffffff" : "#000000",
        0.05,
      );
      ctx.fillRect(0, 0, w, barBottom);
      ctx.restore();

      drawTrafficLights(ctx, props, chrome.barH, accent);
      drawUrlBar(ctx, props, chrome.barH, w);
    } else if (props.device === "window") {
      drawTrafficLights(ctx, props, chrome.barH, accent);
    } else if (props.device === "phone") {
      const notchW = w * 0.34;
      const notchH = Math.max(6, h * 0.018);
      roundRectPath(ctx, (w - notchW) / 2, screen.y - notchH * 0.35, notchW, notchH * 1.5, notchH);
      ctx.fillStyle = withAlpha(readableOn(props.frameColor), 0.85);
      ctx.fill();
    } else if (props.device === "tablet") {
      ctx.beginPath();
      ctx.arc(w / 2, screen.y / 2, Math.max(2, screen.y * 0.22), 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(readableOn(props.frameColor), 0.5);
      ctx.fill();
    }

    // ---- glass gloss ----------------------------------------------------
    if (props.device === "phone" || props.device === "tablet") {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "rgba(255,255,255,0.16)");
      g.addColorStop(0.42, "rgba(255,255,255,0.02)");
      g.addColorStop(0.6, "rgba(255,255,255,0.07)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.save();
      roundRectPath(ctx, 0, 0, w, h, chrome.radius);
      ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    ctx.restore();
  },
};
