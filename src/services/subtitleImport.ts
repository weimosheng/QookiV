import { createTextClip, type TextVariant } from "../core/clips";
import type { Clip, ThemeTokens } from "../core/types";
import { isTauri, readTextFile } from "./tauri";
import { parseSubtitle, type SubtitleCue } from "./subtitleParser";

export interface SubtitleImportOptions {
  variant?: TextVariant;
  theme?: ThemeTokens;
  /** 整体时间偏移（秒），用于把字幕对齐到播放头。 */
  offset?: number;
}

/** 把字幕 cue 序列转成 TextClip[]。 */
export function cuesToClips(cues: SubtitleCue[], opts: SubtitleImportOptions = {}): Clip[] {
  const offset = opts.offset ?? 0;
  return cues.map((cue) =>
    createTextClip({
      start: cue.start + offset,
      duration: Math.max(0.1, cue.end - cue.start),
      name: cue.text.slice(0, 12) || "字幕",
      text: cue.text,
      variant: opts.variant ?? "caption",
      theme: opts.theme,
      style: { align: "center" },
    }),
  );
}

/** 从磁盘读取字幕文件并生成 TextClip[]。 */
export async function importSubtitleFile(
  path: string,
  opts: SubtitleImportOptions = {},
): Promise<Clip[]> {
  const content = isTauri()
    ? await readTextFile(path)
    : await (await fetch(path)).text();
  const cues = parseSubtitle(path, content);
  return cuesToClips(cues, opts);
}
