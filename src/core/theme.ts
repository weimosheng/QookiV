import type { ThemeTokens } from "./types";

/**
 * QookiX brand tokens.
 *
 * The warm ramp is sampled directly from the pixel-art cookie app icon, and the
 * neutral surfaces follow the launcher's own stylesheet, so a promo cut in
 * QookiV matches the product it advertises.
 */

/* ------------------------------------------------------------------ *
 * Brand ramp (sampled from app-icon.png)
 * ------------------------------------------------------------------ */

export const BRAND = {
  /** Highlight dough — brightest tone in the icon. */
  dough100: "#F6DFA2",
  /** Light dough. */
  dough200: "#EFC17B",
  /** Mid dough, used as the presentation accent. */
  dough300: "#E29A5A",
  /** Primary brand colour. */
  primary: "#C97640",
  /** Shaded dough. */
  primaryDeep: "#A5532E",
  /** Cookie outline. */
  outline: "#7D3A24",
  /** Chocolate chip. */
  chip: "#55251E",
  /** Deepest chip shadow. */
  chipDeep: "#4F1F1B",
} as const;

/** Ordered ramp for gradients, charts and template gradients. */
export const BRAND_RAMP = [
  BRAND.dough100,
  BRAND.dough200,
  BRAND.dough300,
  BRAND.primary,
  BRAND.primaryDeep,
  BRAND.outline,
  BRAND.chip,
] as const;

/** Secondary hues that sit comfortably beside the cookie orange. */
export const SUPPORT = {
  mint: "#6FCF97",
  sky: "#5AA9E6",
  lilac: "#9B8CFF",
  rose: "#E86A7C",
  sand: "#D9C9A8",
} as const;

export const FONT_UI =
  '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

/** Heavier stack for headline typography in rendered videos. */
export const FONT_DISPLAY =
  '"Segoe UI Variable Display", "Segoe UI Semibold", "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

export const FONT_MONO = '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace';

/* ------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------ */

export const QOOKIX_DARK: ThemeTokens = {
  mode: "dark",
  accent: BRAND.primary,
  accentDeep: BRAND.primaryDeep,
  accentHover: BRAND.dough300,
  bg0: "#0b0d12",
  bg1: "#10131a",
  bg2: "#151924",
  text1: "#f2f3f7",
  text2: "#c6c8d2",
  text3: "#8b8e9c",
  font: FONT_UI,
  fontDisplay: FONT_DISPLAY,
  radius: 22,
};

export const QOOKIX_LIGHT: ThemeTokens = {
  mode: "light",
  accent: BRAND.primary,
  accentDeep: BRAND.primaryDeep,
  accentHover: BRAND.dough300,
  bg0: "#faf7f4",
  bg1: "#f1ece6",
  bg2: "#e6ded5",
  text1: "#231a15",
  text2: "#574840",
  text3: "#8a7a70",
  font: FONT_UI,
  fontDisplay: FONT_DISPLAY,
  radius: 22,
};

/**
 * High-contrast presentation palette for on-screen graphics. Slightly brighter
 * than the app chrome so headline text and screenshots survive video encoding.
 */
export const QOOKIX_PRESENTATION: ThemeTokens = {
  mode: "dark",
  accent: BRAND.dough300,
  accentDeep: BRAND.primary,
  accentHover: BRAND.dough200,
  bg0: "#0a0910",
  bg1: "#12101a",
  bg2: "#1a1724",
  text1: "#ffffff",
  text2: "#d9d3cf",
  text3: "#9c948e",
  font: FONT_UI,
  fontDisplay: FONT_DISPLAY,
  radius: 24,
};

/** Light presentation palette, for bright "clean product" promo cuts. */
export const QOOKIX_PRESENTATION_LIGHT: ThemeTokens = {
  mode: "light",
  accent: BRAND.primary,
  accentDeep: BRAND.primaryDeep,
  accentHover: BRAND.dough300,
  bg0: "#fdfbf9",
  bg1: "#f4efe9",
  bg2: "#e9e0d6",
  text1: "#1c1512",
  text2: "#5b4c43",
  text3: "#8d7d73",
  font: FONT_UI,
  fontDisplay: FONT_DISPLAY,
  radius: 24,
};

/**
 * Minimal cream palette: flat off-white paper, caramel as the single accent,
 * warm brown ink for type.
 *
 * The tones are lifted from the "简约风" cut, whose whole point is that nothing
 * is dark or glossy: the background never moves, the accent only ever appears on
 * the one item that currently has focus, and contrast is carried by type weight
 * instead of by surface.
 */
export const QOOKIX_MINIMAL_CREAM: ThemeTokens = {
  mode: "light",
  accent: "#C98858",
  accentDeep: "#A96A3D",
  accentHover: "#E3B18A",
  bg0: "#FAF8F5",
  bg1: "#FDFBF8",
  bg2: "#E8DCCF",
  text1: "#3E2C20",
  text2: "#7A6455",
  text3: "#C9B6A5",
  font: FONT_UI,
  fontDisplay: FONT_DISPLAY,
  radius: 30,
};

export const BUILT_IN_THEMES: Record<string, ThemeTokens> = {
  presentation: QOOKIX_PRESENTATION,
  presentationLight: QOOKIX_PRESENTATION_LIGHT,
  minimalCream: QOOKIX_MINIMAL_CREAM,
  qookixDark: QOOKIX_DARK,
  qookixLight: QOOKIX_LIGHT,
};

export const THEME_LABELS: Record<string, string> = {
  presentation: "演示厅 · 深色",
  presentationLight: "演示厅 · 浅色",
  minimalCream: "简约米白 · 浅色",
  qookixDark: "QookiX 深色",
  qookixLight: "QookiX 浅色",
};

/** Copies a theme, overriding individual tokens. */
export function deriveTheme(base: ThemeTokens, overrides: Partial<ThemeTokens>): ThemeTokens {
  return { ...base, ...overrides };
}
