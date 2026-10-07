import { TRANSITION_LABELS } from "../../render/effects";
import type { Clip } from "../../core/types";

/**
 * 时间线用的短标签。
 *
 * 片段块上只有一条 tooltip，而"这个片段到底动了什么"恰恰是时间线最看不出来的东西：
 * 关键帧菱形只说明**有**动画、以及动画在什么时刻，说不清是宽高、模糊还是音量。所以把
 * 属性路径和转场都翻译成中文，拼进片段自己的 tooltip。
 *
 * 检查器里每个字段的中文标签是各自硬编码的；这里是一张专供时间线的小表，路径不在表里
 * 就原样显示（宁可露出 `props.focusX`，也不要假装知道它叫什么）。
 */

const PATH_LABELS: Record<string, string> = {
  opacity: "不透明度",
  "transform.x": "水平位移",
  "transform.y": "垂直位移",
  "transform.scale": "缩放",
  "transform.rotation": "旋转",
  "filters.blur": "模糊",
  "props.width": "宽",
  "props.height": "高",
  "props.radius": "圆角",
  "props.strokeWidth": "描边",
  "props.fill": "填充色",
  "props.volume": "音量",
  "props.style.color": "文字色",
  "props.style.fontSize": "字号",
  "props.style.letterSpacing": "字距",
};

/** 该路径在时间线上的名字。 */
export function pathLabel(path: string): string {
  return PATH_LABELS[path] ?? path;
}

/** 这个片段动了的属性名，按路径字典序（和「动效」表一致）。 */
export function animatedPathLabels(clip: Clip): string[] {
  return Object.keys(clip.animation)
    .filter((path) => (clip.animation[path]?.length ?? 0) > 0)
    .sort()
    .map(pathLabel);
}

/** 关键帧总数，用于 tooltip 里的"几帧"。 */
export function keyframeCount(clip: Clip): number {
  return Object.values(clip.animation).reduce((sum, frames) => sum + (frames?.length ?? 0), 0);
}

/** `动效 宽 / 高（4 帧）`，没有动画时返回空串。 */
export function clipMotionSummary(clip: Clip): string {
  const labels = animatedPathLabels(clip);
  if (labels.length === 0) return "";
  // 每个被动画的属性都点名：时间线上的"⇔"标记靠它说明是哪一类变化。
  return `动效 ${labels.join(" / ")}（${keyframeCount(clip)} 帧）`;
}

/** `入场 模糊溶解 0.6s · 出场 淡入淡出 0.5s`，没有转场时返回空串。 */
export function clipTransitionSummary(clip: Clip): string {
  const parts: string[] = [];
  if (clip.transitionIn && clip.transitionIn.duration > 0) {
    parts.push(`入场 ${TRANSITION_LABELS[clip.transitionIn.kind]} ${clip.transitionIn.duration.toFixed(1)}s`);
  }
  if (clip.transitionOut && clip.transitionOut.duration > 0) {
    parts.push(`出场 ${TRANSITION_LABELS[clip.transitionOut.kind]} ${clip.transitionOut.duration.toFixed(1)}s`);
  }
  return parts.join(" · ");
}
