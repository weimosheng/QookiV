import { lighten, readableOn, withAlpha } from "../../core/color";
import {
  blurIn,
  delayAnimation,
  fadeOut,
  floatY,
  mergeAnimations,
  offsetAnimation,
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
  sAsset,
  sColor,
  sStr,
  tr,
} from "../kit";
import type { PromoTemplate } from "../types";

/**
 * 「功能速览」——三段式产品概览，全长 22 秒。
 *
 * 镜头表：
 *   0.0-3.8   主标题 + 副标题
 *   3.8-11.0  浏览器实机演示（截图槽位缺省时保留空框，仍然能看到产品界面）
 *   11.0-17.0 三张功能卡片横向铺开，逐张错位入场
 *   17.2-21.6 结尾行动号召（胶囊按钮 + 文案）
 *
 * 位移类预设（`riseIn` / `slideIn` / `floatY`）的关键帧是绝对值，末帧一律落在
 * 0，直接用在偏心元素上会把它们拉回画面中心；所以这里统一用
 * `offsetAnimation(..., "transform.y", 基准值)` 把曲线整体平移到元素自己的
 * 位置上，`put()` 里的静态坐标与动画末帧保持一致。
 */

/** 把图层摆到以画面中心为原点的绝对位置。 */
function put(clip: Clip, x: number, y: number): Clip {
  clip.transform = { ...clip.transform, x, y };
  return clip;
}

/** 三张功能卡片的水平中心坐标。 */
const CARD_X = [-570, 0, 570];

/** 卡片与卡内文字的垂直基准。 */
const CARD_Y = 80;
const CARD_TITLE_Y = 10;
const CARD_BODY_Y = 112;

export const featureTourTemplate: PromoTemplate = {
  id: "feature-tour",
  name: "功能速览",
  description: "以卡片节奏快速过一遍核心功能，适合 20-30 秒的产品概览。",
  category: "feature",
  tags: ["功能", "卡片", "快节奏", "界面演示"],
  aspect: "16:9",
  duration: 22,
  themeKey: "presentation",
  slots: [
    { id: "title", label: "主标题", type: "text", default: "把想法变成作品", group: "文案" },
    {
      id: "subtitle",
      label: "副标题",
      type: "text",
      default: "从脚本到成片，一个窗口搞定",
      group: "文案",
    },
    { id: "feature1Title", label: "功能一 · 标题", type: "text", default: "模板即用", group: "功能卡片" },
    {
      id: "feature1Body",
      label: "功能一 · 说明",
      type: "textarea",
      default: "内置成套宣传片结构，替换文案即可成片。",
      group: "功能卡片",
    },
    { id: "feature2Title", label: "功能二 · 标题", type: "text", default: "实时预览", group: "功能卡片" },
    {
      id: "feature2Body",
      label: "功能二 · 说明",
      type: "textarea",
      default: "时间线所见即所得，改一处立刻看到结果。",
      group: "功能卡片",
    },
    { id: "feature3Title", label: "功能三 · 标题", type: "text", default: "一键导出", group: "功能卡片" },
    {
      id: "feature3Body",
      label: "功能三 · 说明",
      type: "textarea",
      default: "MP4 与 GIF 多规格导出，投放素材一次生成。",
      group: "功能卡片",
    },
    { id: "cta", label: "结尾行动号召", type: "text", default: "现在就开始创作", group: "文案" },
    {
      id: "screenshot",
      label: "产品截图",
      type: "asset",
      assetKind: "image",
      default: "",
      group: "素材",
      help: "留空时保留空白浏览器框，方便先看节奏。",
    },
    { id: "accent", label: "主色", type: "color", default: "#C97640", group: "外观" },
  ],

  build(values, ctx) {
    const theme = ctx.theme;
    const accent = sColor(values, "accent", theme.accent);
    const accentLight = lighten(accent, 0.24);
    const title = sStr(values, "title", "把想法变成作品");
    const subtitle = sStr(values, "subtitle", "从脚本到成片，一个窗口搞定");
    const cta = sStr(values, "cta", "现在就开始创作");
    const shot = sAsset(values, "screenshot", ctx, "image");
    const shotId = shot ? shot.id : "";

    const content = new TrackBuilder("visual", "内容");
    const overlay = new TrackBuilder("visual", "叠加");

    /* ---- 第一幕 0.0-3.8：主标题 ------------------------------------ */
    const hero = makeClip("text", {
      theme,
      text: title,
      variant: "hero",
      duration: 3.8,
      name: "主标题",
      // 标题居中，直接用 riseIn 就够了。
      props: {
        maxWidth: 1500,
        gradient: { enabled: true, from: theme.text1, to: accentLight, angle: 100 },
      },
      enter: riseIn(0.9, 96),
      exit: fadeOut(3.1, 0.7),
    });
    content.place(hero, 0);

    const sub = makeClip("text", {
      theme,
      text: subtitle,
      variant: "subtitle",
      duration: 2.8,
      name: "副标题",
      props: { color: theme.text2, maxWidth: 1100, letterSpacing: 0.04 },
      enter: offsetAnimation(riseIn(0.7, 50, 0.65), "transform.y", 170),
      exit: fadeOut(2.3, 0.5),
    });
    overlay.place(put(sub, 0, 170), 0.9);

    /* ---- 第二幕 3.8-11.0：浏览器实机演示 -------------------------- */
    const screen = makeClip("device", {
      theme,
      assetId: shotId,
      duration: 7.2,
      name: "产品界面",
      props: {
        device: "browser",
        assetId: shotId,
        fit: "cover",
        width: 1320,
        height: 780,
        url: "qookix.app/studio",
        radius: 20,
        tiltX: 2,
        tiltY: -5,
        padding: 0,
        shadow: true,
      },
      // 先对焦后清晰，再围绕基准线轻轻漂浮，静态截图也不会显得是死画面。
      enter: blurIn(1, 16),
      extra: offsetAnimation(floatY(9, 5, 4), "transform.y", 30),
      exit: fadeOut(6.4, 0.8),
    });
    content.place(put(screen, 0, 30), 3.8);

    /* ---- 第三幕 11.0-17.0：三张功能卡片 ---------------------------- */
    const cardStart = 11;
    const cardEnd = 17;
    const features = [
      {
        title: sStr(values, "feature1Title", "模板即用"),
        body: sStr(values, "feature1Body", "内置成套宣传片结构，替换文案即可成片。"),
      },
      {
        title: sStr(values, "feature2Title", "实时预览"),
        body: sStr(values, "feature2Body", "时间线所见即所得，改一处立刻看到结果。"),
      },
      {
        title: sStr(values, "feature3Title", "一键导出"),
        body: sStr(values, "feature3Body", "MP4 与 GIF 多规格导出，投放素材一次生成。"),
      },
    ];

    features.forEach((feature, i) => {
      const x = CARD_X[i];
      const start = cardStart + i * 0.16;
      const duration = cardEnd - start;
      const stagger = i * 0.16;

      const card = makeClip("shape", {
        theme,
        duration,
        name: `功能卡片 ${i + 1}`,
        props: {
          shape: "rect",
          width: 460,
          height: 340,
          radius: 28,
          fill: theme.mode === "dark" ? withAlpha("#ffffff", 0.07) : withAlpha("#ffffff", 0.88),
          strokeWidth: 2,
          strokeColor: withAlpha(accent, 0.5),
        },
        // 从下方托起 + 轻微回弹，三张卡片依次到位。
        enter: delayAnimation(
          mergeAnimations(
            offsetAnimation(slideIn("bottom", 0.85, 90), "transform.y", CARD_Y),
            scaleSettle(0.75, 1.06),
          ),
          stagger,
        ),
        exit: fadeOut(duration - 0.7, 0.7),
      });
      content.place(put(card, x, CARD_Y), start);

      const cardTitle = makeClip("text", {
        theme,
        text: feature.title,
        variant: "subtitle",
        duration: duration - 0.15,
        name: `卡片标题 ${i + 1}`,
        props: {
          fontSize: 50,
          fontWeight: 700,
          color: theme.text1,
          maxWidth: 380,
          lineHeight: 1.2,
        },
        enter: delayAnimation(
          offsetAnimation(riseIn(0.7, 46), "transform.y", CARD_TITLE_Y),
          stagger + 0.12,
        ),
        exit: fadeOut(duration - 0.8, 0.65),
      });
      content.place(put(cardTitle, x, CARD_TITLE_Y), start + 0.08);

      const cardBody = makeClip("text", {
        theme,
        text: feature.body,
        variant: "body",
        duration: duration - 0.25,
        name: `卡片说明 ${i + 1}`,
        props: { fontSize: 28, color: theme.text2, maxWidth: 380, lineHeight: 1.65 },
        // 对焦式淡入：只改模糊与缩放，静态坐标原地不动。
        enter: delayAnimation(blurIn(0.7, 9), stagger + 0.24),
        exit: fadeOut(duration - 0.85, 0.65),
      });
      content.place(put(cardBody, x, CARD_BODY_Y), start + 0.08);
    });

    /* ---- 第四幕 17.2-21.6：结尾行动号召 ---------------------------- */
    const pill = makeClip("shape", {
      theme,
      duration: 4.4,
      name: "按钮底",
      props: {
        shape: "rect",
        width: 720,
        height: 140,
        radius: 70,
        fillGradient: { enabled: true, from: accent, to: accentLight, angle: 90 },
        strokeWidth: 0,
      },
      // 横向展开的圆形擦除，比缩放更有仪式感。
      transitionIn: tr("circleOpen", 0.55),
      exit: fadeOut(3.6, 0.7),
    });
    content.place(put(pill, 0, 60), 17.2);

    const ctaText = makeClip("text", {
      theme,
      text: cta,
      variant: "subtitle",
      duration: 4.3,
      name: "行动号召",
      props: {
        fontSize: 46,
        fontWeight: 700,
        color: readableOn(accent),
        maxWidth: 620,
        letterSpacing: 0.06,
      },
      enter: offsetAnimation(riseIn(0.7, 40, 0.45), "transform.y", 60),
      exit: fadeOut(3.5, 0.7),
    });
    content.place(put(ctaText, 0, 60), 17.3);

    /* ---- 背景：一张主底 + 一段结尾换色 ----------------------------- */
    const background = [
      makeBackground(theme, 22, {
        pattern: "grid",
        patternColor: withAlpha(accent, 0.1),
        patternScale: 72,
        patternSpeed: 10,
        vignette: 0.42,
        blobs: [
          { x: 0.22, y: 0.26, radius: 540, color: withAlpha(accent, 0.3), speed: 4 },
          { x: 0.8, y: 0.74, radius: 470, color: withAlpha(accentLight, 0.18), speed: -3 },
        ],
      }),
      makeBackground(
        theme,
        4.8,
        {
          pattern: "dots",
          patternColor: withAlpha(accentLight, 0.14),
          patternScale: 60,
          patternSpeed: 14,
          vignette: 0.5,
          blobs: [{ x: 0.5, y: 0.52, radius: 700, color: withAlpha(accent, 0.36), speed: 2 }],
        },
        17.2,
      ),
    ];

    return buildTemplateProject(featureTourTemplate, values, ctx, [content.track, overlay.track], {
      background,
    });
  },
};
