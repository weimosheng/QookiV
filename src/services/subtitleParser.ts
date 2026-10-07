import type { Seconds } from "../core/types";

export interface SubtitleCue {
  start: Seconds;
  end: Seconds;
  text: string;
}

/** "00:01:23,456" 或 "00:01:23.456" → 秒；也兼容 "MM:SS.ms" 短格式。 */
function parseTimestamp(ts: string): Seconds {
  const parts = ts.trim().split(/[,.]/);
  const timePart = parts[0];
  const msPart = parts[1] ?? "0";
  const segs = timePart.split(":");
  let h = 0;
  let min = 0;
  let s = 0;
  if (segs.length === 3) {
    h = +segs[0];
    min = +segs[1];
    s = +segs[2];
  } else if (segs.length === 2) {
    min = +segs[0];
    s = +segs[1];
  } else {
    s = +segs[0];
  }
  return h * 3600 + min * 60 + s + (+msPart) / Math.pow(10, msPart.length);
}

function parseBlocks(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = content.replace(/\r/g, "").trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx < 0) continue;
    const [startStr, endStr] = lines[timeLineIdx].split("-->").map((s) => s.trim());
    const text = lines.slice(timeLineIdx + 1).join("\n").trim();
    if (!text) continue;
    try {
      cues.push({ start: parseTimestamp(startStr), end: parseTimestamp(endStr), text });
    } catch {
      // 跳过无法解析的块
    }
  }
  return cues;
}

/** 解析 SubRip (.srt) 字幕。 */
export function parseSrt(content: string): SubtitleCue[] {
  return parseBlocks(content);
}

/** 解析 WebVTT (.vtt) 字幕，去掉 WEBVTT 头部和 NOTE/STYLE 块。 */
export function parseVtt(content: string): SubtitleCue[] {
  const body = content
    .replace(/\r/g, "")
    .replace(/^WEBVTT[^\n]*\n/, "")
    .replace(/^NOTE[^\n]*\n(?:.*\n)*?\n/gm, "")
    .replace(/^STYLE[^\n]*\n(?:.*\n)*?\n/gm, "");
  return parseBlocks(body);
}

export function parseSubtitle(path: string, content: string): SubtitleCue[] {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "srt") return parseSrt(content);
  if (ext === "vtt") return parseVtt(content);
  throw new Error(`不支持的字幕格式: .${ext}`);
}
