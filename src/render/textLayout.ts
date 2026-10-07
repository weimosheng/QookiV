import type { TextStyle } from "../core/types";

/**
 * Canvas text layout with proper CJK support.
 *
 * Canvas has no wrapping, so QookiV measures and breaks lines itself. Latin text
 * breaks at spaces, CJK breaks between any two ideographs, and mixed runs do
 * both — which is what a Chinese software promo actually needs.
 */

export interface GlyphBox {
  ch: string;
  /** Offset from the line's left edge. */
  x: number;
  w: number;
  /** Index of this glyph within the whole (newline-stripped) string. */
  index: number;
  /** Word index, used by word-level reveals. */
  word: number;
}

export interface LaidOutLine {
  text: string;
  width: number;
  /** Left edge of the line relative to the text block. */
  x: number;
  /** Baseline Y relative to the text block's top. */
  baseline: number;
  glyphs: GlyphBox[];
  /** Index of the first glyph of this line within the whole text. */
  startIndex: number;
}

export interface TextLayout {
  lines: LaidOutLine[];
  width: number;
  height: number;
  fontSize: number;
  lineHeightPx: number;
  /** Distance from the block top to the first baseline. */
  ascent: number;
}

/** Builds the CSS font shorthand Canvas expects. */
export function buildFontString(style: TextStyle): string {
  const italic = style.italic ? "italic " : "";
  const weight = style.fontWeight || 400;
  return `${italic}${weight} ${style.fontSize}px ${style.fontFamily}`;
}

const CJK_RANGES: Array<[number, number]> = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2fff], // CJK radicals, Kangxi
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x3130, 0x318f], // Hangul compatibility
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
];

/** True for characters that may be broken between without a space. */
export function isBreakable(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  // Treat other non-Latin scripts conservatively as breakable too.
  return cp > 0x2e00 && !(cp >= 0x1f300 && cp <= 0x1faff);
}

/** Characters that must never start a line (CJK line-breaking rules). */
const NO_LINE_START = "，。、；：？！）》」』】〉…—～·%";
/** Characters that must never end a line. */
const NO_LINE_END = "（《「『【〈";

interface Measurer {
  (text: string): number;
}

function makeMeasurer(ctx: CanvasRenderingContext2D): Measurer {
  const cache = new Map<string, number>();
  return (text: string) => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const w = ctx.measureText(text).width;
    if (cache.size < 4096) cache.set(text, w);
    return w;
  };
}

/**
 * Greedy line breaking with CJK rules. Returns the visual lines of one
 * paragraph (explicit `\n` is handled by the caller).
 */
function wrapParagraph(text: string, maxWidth: number, measure: Measurer): string[] {
  if (maxWidth <= 0 || text.length === 0) return [text];

  const chars: string[] = [];
  for (const ch of text) chars.push(ch);

  const lines: string[] = [];
  let line = "";
  let lastSpace = -1;

  const flushAt = (index: number) => {
    // Break so that `line` keeps [0, index) and the remainder continues.
    const head = line.slice(0, index);
    const tail = line.slice(index);
    lines.push(head.replace(/\s+$/, ""));
    line = tail.replace(/^\s+/, "");
  };

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const candidate = line + ch;
    if (measure(candidate) <= maxWidth || line.length === 0) {
      line = candidate;
      if (ch === " " || ch === "\t") lastSpace = line.length - 1;
      continue;
    }

    // The candidate overflows: choose a break point.
    let breakAt = -1;
    if (isBreakable(ch)) {
      // Break before a CJK character, unless that would orphan punctuation.
      if (NO_LINE_START.indexOf(ch) >= 0) {
        breakAt = line.length;
      } else {
        const prev = line.length > 0 ? line[line.length - 1] : "";
        breakAt = NO_LINE_END.indexOf(prev) >= 0 ? line.length : line.length;
      }
    } else if (lastSpace >= 0) {
      breakAt = lastSpace;
    } else {
      breakAt = line.length;
    }

    if (breakAt <= 0) {
      // Nothing sensible to break on; force the character onto its own line.
      lines.push(line.replace(/\s+$/, ""));
      line = ch;
      lastSpace = -1;
      continue;
    }

    flushAt(breakAt);
    lastSpace = -1;

    // The remainder plus this character may still overflow; re-check.
    let guard = 0;
    while (line.length > 0 && measure(line + ch) > maxWidth && guard < 64) {
      lines.push(line.replace(/\s+$/, ""));
      line = "";
      guard += 1;
    }
    line += ch;
  }

  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * Lays out `text` for a given style. `maxWidth` of 0 disables wrapping.
 *
 * The returned geometry is in unscaled project pixels and is independent of
 * where the clip sits, so preview and export agree exactly.
 */
export function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  style: TextStyle,
): TextLayout {
  const measure = makeMeasurer(ctx);
  const spacing = style.letterSpacing * style.fontSize;
  const raw = style.uppercase ? text.toUpperCase() : text;

  const metrics = ctx.measureText("Hg");
  const ascent = metrics.actualBoundingBoxAscent || style.fontSize * 0.8;
  const descent = metrics.actualBoundingBoxDescent || style.fontSize * 0.2;
  const lineHeightPx = style.fontSize * style.lineHeight;

  const paragraphs = raw.split("\n");
  const rawLines: string[] = [];
  for (const para of paragraphs) {
    if (para.length === 0) {
      rawLines.push("");
      continue;
    }
    const wrapped = wrapParagraph(para, style.maxWidth, measure);
    for (const w of wrapped) rawLines.push(w);
  }

  const lines: LaidOutLine[] = [];
  let glyphIndex = 0;
  let maxLineWidth = 0;

  for (let li = 0; li < rawLines.length; li += 1) {
    const lineText = rawLines[li];
    const glyphChars: string[] = [];
    for (const ch of lineText) glyphChars.push(ch);

    let x = 0;
    let word = 0;
    const glyphs: GlyphBox[] = [];
    for (let gi = 0; gi < glyphChars.length; gi += 1) {
      const ch = glyphChars[gi];
      const w = measure(ch) + spacing;
      glyphs.push({ ch, x, w, index: glyphIndex + gi, word });
      x += w;
      if (ch === " " || ch === "\t") word += 1;
    }

    // Trailing letter-spacing should not count toward the visual width.
    const width = glyphChars.length > 0 ? Math.max(0, x - spacing) : 0;
    maxLineWidth = Math.max(maxLineWidth, width);

    lines.push({
      text: lineText,
      width,
      x: 0,
      baseline: li * lineHeightPx + ascent,
      glyphs,
      startIndex: glyphIndex,
    });
    glyphIndex += glyphChars.length;
  }

  const blockWidth = style.maxWidth > 0 ? Math.min(style.maxWidth, maxLineWidth) : maxLineWidth;
  const height = lines.length * lineHeightPx;

  // Horizontal alignment inside the block.
  const align = style.align;
  for (const line of lines) {
    if (align === "center") line.x = (blockWidth - line.width) / 2;
    else if (align === "right") line.x = blockWidth - line.width;
    else line.x = 0;
  }

  return {
    lines,
    width: Math.max(1, blockWidth),
    height: Math.max(1, height),
    fontSize: style.fontSize,
    lineHeightPx,
    ascent: ascent || descent,
  };
}

/* ------------------------------------------------------------------ *
 * Reveals
 * ------------------------------------------------------------------ */

export interface RevealUnit {
  /** Glyph indices covered by this unit. */
  indices: number[];
  start: number;
  end: number;
}

/**
 * Splits a layout into the units a reveal animates, and returns the timing for
 * each. Units are characters for typewriter/charPop and words for wordRise.
 */
export function revealUnits(
  layout: TextLayout,
  mode: string,
  totalDuration: number,
  stagger: number,
): RevealUnit[] {
  const all: GlyphBox[] = [];
  for (const line of layout.lines) all.push(...line.glyphs);

  if (mode === "none" || mode === "maskWipe" || mode === "blurIn") return [];

  const isWord = mode === "wordRise";
  const groups: GlyphBox[][] = [];
  if (isWord) {
    let current: GlyphBox[] = [];
    let currentWord = all.length > 0 ? all[0].word : 0;
    for (const g of all) {
      if (g.word !== currentWord) {
        if (current.length > 0) groups.push(current);
        current = [];
        currentWord = g.word;
      }
      current.push(g);
    }
    if (current.length > 0) groups.push(current);
  } else {
    for (const g of all) groups.push([g]);
  }

  const n = groups.length;
  const total = Math.max(0.05, totalDuration);
  let per = total - stagger * Math.max(0, n - 1);
  let step = stagger;
  if (per < 0.05) {
    per = Math.max(0.03, total / Math.max(1, n));
    step = n > 1 ? Math.max(0, (total - per) / (n - 1)) : 0;
  }

  return groups.map((group, i) => {
    const start = i * step;
    return {
      indices: group.map((g) => g.index),
      start,
      end: start + per,
    };
  });
}

/** Progress 0..1 of a single reveal unit at clip-local time `t`. */
export function unitProgress(unit: RevealUnit, t: number): number {
  if (t <= unit.start) return 0;
  if (t >= unit.end) return 1;
  const span = unit.end - unit.start;
  return span <= 0 ? 1 : (t - unit.start) / span;
}
