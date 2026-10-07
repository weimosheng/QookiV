import { lighten, withAlpha } from "../../core/color";
import {
  delayAnimation,
  fadeIn,
  fadeOut,
  mergeAnimations,
  offsetAnimation,
  popIn,
  riseIn,
  scaleSettle,
  slideIn,
} from "../../core/motion";
import type { Clip } from "../../core/types";
import {
  TrackBuilder,
  buildTemplateProject,
  makeBackground,
  makeClip,
  sColor,
  sNum,
  sStr,
  tr,
} from "../kit";
import type { PromoTemplate } from "../types";

/**
 * 「数据亮点」——三个大数字撑满画面，全长 18 秒。
 *
 * 镜头表：
 *   0.0-3.6   标题（自上而下滑入）+ 主色短横线
 *   2.2-15.6  三组「数字 + 说明」分列排开，逐个错位入场，中间用细分割线分隔
 *   14.4-17.6 数据来源行
 *
 * 数字用 `popIn` 缩放弹入 + `slideIn` 上托，说明文字用 `riseIn` 跟随；
 * 三列各带 0.26 秒错位，视线会自然从左扫到右。位移曲线统一用
 * `offsetAnimation` 平移到各自的列坐标上。
 */

/** 把图层摆到以画面中心为原点的绝对位置。 */
function put(clip: Clip, x: number, y: number): Clip {
  clip.transform = { ...clip.transform, x, y };
  return clip;
}

/** 去掉多余的尾随零，让 12.80 显示为 12.8。 */
function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const text = String(rounded);
  return text.indexOf(".") >= 0 ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** 三列数据的水平中心，以及大字 / 说明的垂直基准。 */
const COLUMN_X = [-580, 0, 580];
const NUMBER_Y = -60;
const LABEL_Y = 170;

export const statsHighlightTemplate: PromoTemplate = {
  id: "stats-highlight",
  name: "数据亮点",
  description: "三个大号数字配说明文字，适合用结果说话的成绩单式短片。",
  category: "data",
  tags: ["数据", "成绩单", "大数字"],
  aspect: "16:9",
  duration: 18,
  themeKey: "presentation",
  slots: [
    { id: "title", label: "标题", type: "text", default: "数字会说话", group: "文案" },
    { id: "value1", label: "数字一", type: "number", default: 12.8, min: 0, max: 99999, step: 0.1, group: "第一组" },
    { id: "suffix1", label: "数字一 · 后缀", type: "text", default: "x", group: "第一组" },
    { id: "label1", label: "数字一 · 说明", type: "text", default: "渲染速度提升", group: "第一组" },
    { id: "value2", label: "数字二", type: "number", default: 98, min: 0, max: 99999, step: 1, group: "第二组" },
    { id: "suffix2", label: "数字二 · 后缀", type: "text", default: "%", group: "第二组" },
    { id: "label2", label: "数字二 · 说明", type: "text", default: "导出一次成功率", group: "第二组" },
    { id: "value3", label: "数字三", type: "number", default: 240, min: 0, max: 99999, step: 1, group: "第三组" },
    { id: "suffix3", label: "数字三 · 后缀", type: "text", default: "+", group: "第三组" },
    { id: "label3", label: "数字三 · 说明", type: "text", default: "内置模板与素材", group: "第三组" },
    {
      id: "footer",
      label: "数据来源",
      type: "text",
      default: "数据来自 QookiX 实验室内部测试",
      group: "文案",
    },
    { id: "accent", label: "主色", type: "color", default: "#C97640", group: "外观" },
  ],

  build(values, ctx) {
    const theme = ctx.theme;
    const accent = sColor(values, "accent", theme.accent);
    const accentLight = lighten(accent, 0.26);
    const title = sStr(values, "title", "数字会说话");
    const footer = sStr(values, "footer", "数据来自 QookiX 实验室内部测试");
    const dividerColor =
      theme.mode === "dark" ? withAlpha("#ffffff", 0.12) : withAlpha("#000000", 0.1);

    const stats = [
      {
        value: sNum(values, "value1", 12.8),
        suffix: sStr(values, "suffix1", "x"),
        label: sStr(values, "label1", "渲染速度提升"),
      },
      {
        value: sNum(values, "value2", 98),
        suffix: sStr(values, "suffix2", "%"),
        label: sStr(values, "label2", "导出一次成功率"),
      },
      {
        value: sNum(values, "value3", 240),
        suffix: sStr(values, "suffix3", "+"),
        label: sStr(values, "label3", "内置模板与素材"),
      },
    ];

    const content = new TrackBuilder("visual", "内容");

    /* ---- 标题 0.0-3.6 ---------------------------------------------- */
    const titleText = makeClip("text", {
      theme,
      text: title,
      variant: "title",
      duration: 3.6,
      name: "标题",
      props: {
        fontSize: 64,
        fontWeight: 700,
        color: theme.text1,
        letterSpacing: 0.1,
        maxWidth: 1300,
      },
      enter: mergeAnimations(fadeIn(0.7, 0.1), scaleSettle(0.9, 0.95, 0.1)),
      transitionIn: tr("slideUp", 0.6),
      exit: fadeOut(2.9, 0.7),
    });
    content.place(put(titleText, 0, -380), 0);

    const underline = makeClip("shape", {
      theme,
      duration: 3.05,
      name: "标题短横线",
      props: {
        shape: "rect",
        width: 180,
        height: 8,
        radius: 4,
        fill: accent,
        strokeWidth: 0,
      },
      enter: mergeAnimations(fadeIn(0.4, 0.3), scaleSettle(0.6, 0.2, 0.3)),
      exit: fadeOut(2.5, 0.55),
    });
    content.place(put(underline, 0, -280), 0.35);

    /* ---- 三组数据 2.2-15.6 ----------------------------------------- */
    const statStart = 2.2;
    const statEnd = 15.6;

    stats.forEach((stat, i) => {
      const x = COLUMN_X[i];
      const stagger = i * 0.26;

      const numberStart = statStart + stagger;
      const numberDuration = statEnd - numberStart;
      const number = makeClip("text", {
        theme,
        text: `${formatNumber(stat.value)}${stat.suffix}`,
        variant: "hero",
        duration: numberDuration,
        name: `数字 ${i + 1}`,
        props: {
          fontSize: 190,
          fontWeight: 800,
          maxWidth: 900,
          letterSpacing: -0.02,
          gradient: { enabled: true, from: accent, to: accentLight, angle: 100 },
          glowBlur: 30,
          glowColor: withAlpha(accent, 0.35),
        },
        // 缩放弹入 + 从下方托起，两段曲线同时跑，落点正好是本列坐标。
        enter: delayAnimation(
          mergeAnimations(
            popIn(0.85, 0.86),
            offsetAnimation(slideIn("bottom", 0.8, 70), "transform.y", NUMBER_Y),
          ),
          stagger,
        ),
        exit: fadeOut(numberDuration - 0.9, 0.8),
      });
      content.place(put(number, x, NUMBER_Y), numberStart);

      const labelStart = statStart + 0.3 + stagger;
      const labelDuration = statEnd - labelStart;
      const label = makeClip("text", {
        theme,
        text: stat.label,
        variant: "body",
        duration: labelDuration,
        name: `说明 ${i + 1}`,
        props: { fontSize: 32, color: theme.text2, lineHeight: 1.5, maxWidth: 460 },
        enter: delayAnimation(
          offsetAnimation(riseIn(0.7, 46), "transform.y", LABEL_Y),
          stagger + 0.1,
        ),
        exit: fadeOut(labelDuration - 0.9, 0.8),
      });
      content.place(put(label, x, LABEL_Y), labelStart);

      // 第一、二列右边的细分割线，最后一列不需要。
      if (i < COLUMN_X.length - 1) {
        const divider = makeClip("shape", {
          theme,
          duration: statEnd - 2,
          name: `分割线 ${i + 1}`,
          props: {
            shape: "rect",
            width: 2,
            height: 240,
            radius: 1,
            fill: dividerColor,
            strokeWidth: 0,
          },
          enter: delayAnimation(
            mergeAnimations(fadeIn(0.5), scaleSettle(0.7, 0.3)),
            stagger + 0.1,
          ),
          exit: fadeOut(statEnd - 2 - 0.9, 0.8),
        });
        content.place(put(divider, x + 290, 40), 2);
      }
    });

    /* ---- 数据来源 14.4-17.6 ---------------------------------------- */
    const footerText = makeClip("text", {
      theme,
      text: footer,
      variant: "caption",
      duration: 3.2,
      name: "数据来源",
      props: { fontSize: 28, color: theme.text3, letterSpacing: 0.08, maxWidth: 1400 },
      enter: offsetAnimation(riseIn(0.8, 40, 0.3), "transform.y", 430),
      exit: fadeOut(2.6, 0.6),
    });
    content.place(put(footerText, 0, 430), 14.4);

    /* ---- 背景 ------------------------------------------------------- */
    const background = [
      makeBackground(theme, 18, {
        pattern: "grid",
        patternColor: withAlpha(accent, 0.09),
        patternScale: 68,
        patternSpeed: 9,
        vignette: 0.48,
        blobs: [
          { x: 0.5, y: 0.24, radius: 620, color: withAlpha(accent, 0.24), speed: 2.5 },
          { x: 0.16, y: 0.82, radius: 420, color: withAlpha(accentLight, 0.16), speed: -3 },
        ],
      }),
    ];

    return buildTemplateProject(statsHighlightTemplate, values, ctx, [content.track], { background });
  },
};
