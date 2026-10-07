import type { Color } from "./types";

/**
 * Colour parsing and interpolation.
 *
 * The renderer needs to blend colours for keyframe animation, gradients and
 * cross-fades, so everything funnels through a single RGBA representation.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
};

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`. */
export function parseColor(input: Color | undefined, fallback: RGBA = { r: 0, g: 0, b: 0, a: 1 }): RGBA {
  if (!input) return fallback;
  let s = String(input).trim().toLowerCase();

  const named = NAMED[s];
  if (named) s = named;

  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return { r, g, b, a };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
    return fallback;
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    const num = (v: string, max: number) =>
      v.endsWith("%") ? (parseFloat(v) / 100) * max : parseFloat(v);
    const r = clamp255(num(parts[0] ?? "0", 255));
    const g = clamp255(num(parts[1] ?? "0", 255));
    const b = clamp255(num(parts[2] ?? "0", 255));
    const a = parts[3] === undefined ? 1 : Math.max(0, Math.min(1, num(parts[3], 1)));
    return { r, g, b, a };
  }

  return fallback;
}

export function rgbaToCss(c: RGBA): string {
  const r = Math.round(clamp255(c.r));
  const g = Math.round(clamp255(c.g));
  const b = Math.round(clamp255(c.b));
  if (c.a >= 1) {
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b
      .toString(16)
      .padStart(2, "0")}`;
  }
  return `rgba(${r},${g},${b},${Math.round(c.a * 1000) / 1000})`;
}

export function toHex(c: Color): string {
  return rgbaToCss({ ...parseColor(c), a: 1 });
}

/** Linear blend between two colours; `t` is clamped to 0..1. */
export function mixColor(from: Color, to: Color, t: number): string {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const a = parseColor(from);
  const b = parseColor(to);
  return rgbaToCss({
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  });
}

export function withAlpha(color: Color, alpha: number): string {
  const c = parseColor(color);
  return rgbaToCss({ ...c, a: Math.max(0, Math.min(1, alpha)) });
}

export function lighten(color: Color, amount: number): string {
  const c = parseColor(color);
  return rgbaToCss({
    r: c.r + (255 - c.r) * amount,
    g: c.g + (255 - c.g) * amount,
    b: c.b + (255 - c.b) * amount,
    a: c.a,
  });
}

export function darken(color: Color, amount: number): string {
  const c = parseColor(color);
  return rgbaToCss({ r: c.r * (1 - amount), g: c.g * (1 - amount), b: c.b * (1 - amount), a: c.a });
}

/** Relative luminance, used to pick readable foreground colours. */
export function luminance(color: Color): number {
  const { r, g, b } = parseColor(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function readableOn(background: Color, light = "#ffffff", dark = "#10131a"): string {
  return luminance(background) > 0.55 ? dark : light;
}

/**
 * Builds a `CanvasGradient` between two colours at an angle in degrees, where
 * 0 points up and 90 points right.
 *
 * `mid` adds an optional third stop between them (used for soft-edged bands:
 * transparent → colour → transparent). Omitting it reproduces the original
 * two-stop ramp exactly.
 */
export function makeLinearGradient(
  ctx: CanvasRenderingContext2D,
  from: Color,
  to: Color,
  angleDeg: number,
  x: number,
  y: number,
  w: number,
  h: number,
  mid?: Color,
  midOffset = 0.5,
): CanvasGradient {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const cx = x + w / 2;
  const cy = y + h / 2;
  // Project the box diagonal onto the gradient axis so the ramp always spans it.
  const len = (Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad))) / 2;
  const dx = Math.cos(rad) * len;
  const dy = Math.sin(rad) * len;
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  const t = Math.max(0, Math.min(1, midOffset));
  g.addColorStop(0, from);
  if (mid !== undefined && mid !== "") {
    // Insert only when it would not collide with an endpoint stop: two stops at
    // the same offset make the canvas ignore the first one.
    if (t > 0.001 && t < 0.999) g.addColorStop(t, mid);
  }
  g.addColorStop(1, to);
  return g;
}
