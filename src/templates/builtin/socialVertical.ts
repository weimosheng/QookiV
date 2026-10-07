import { lighten, readableOn, withAlpha } from "../../core/color";
import {
  breathe,
  delayAnimation,
  fadeOut,
  mergeAnimations,
  offsetAnimation,
  popIn,
  riseIn,
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
 * 「社媒竖屏快剪」——9:16 竖屏，全长 15 秒。
 *
 * 镜头表：
 *   0.0-3.4   两行堆叠的大字标题（整帧向上冲入）+ 副标题
 *   2.6-9.0   手机界面演示，画面下方三条短字幕依次快速切换
 *   9.3-13.8  回到标题 + 主色按钮，收尾号召
 *
 * 竖屏所有元素都靠 `transform.y` 排布（-600 ~ +600，避开平台 UI 遮挡），
 * 宽度统一压在 900 以内。字幕和按钮用 `slideIn("bottom")` 上托，曲线用
 * `offsetAnimation` 平移到各自的基准线，避免末帧把元素拉回画面中心。
 */

/** 把图层摆到以画面中心为原点的绝对位置。 */
function put(clip: Clip, x: number, y: number): Clip {
  clip.transform = { ...clip.transform, x, y };
  return clip;
}

/** 竖屏各元素的垂直基准。 */
const HERO_Y = -480;
const SUB_Y = -300;
const PHONE_Y = 180;
const CAPTION_Y = 480;
const CLOSING_Y = -120;
const CTA_Y = 300;

export const socialVerticalTemplate: PromoTemplate = {
  id: "social-vertical",
  name: "社媒竖屏快剪",
  description: "9:16 竖屏快剪，大字标题配手机演示与快切字幕，适合抖音 / 视频号。",
  category: "social",
  tags: ["竖屏", "短视频", "字幕快切"],
  aspect: "9:16",
  duration: 15,
  themeKey: "presentation",
  slots: [
    {
      id: "headline",
      label: "主标题",
      type: "textarea",
      default: "一句话\n做出宣传片",
      group: "文案",
      help: "支持换行，建议两行以内。",
    },
    { id: "subline", label: "副标题", type: "text", default: "竖屏快剪 · 15 秒讲清楚", group: "文案" },
    { id: "caption1", label: "字幕一", type: "text", default: "拖入素材就能剪", group: "字幕" },
    { id: "caption2", label: "字幕二", type: "text", default: "模板一键套用", group: "字幕" },
    { id: "caption3", label: "字幕三", type: "text", default: "导出即投放全平台", group: "字幕" },
    { id: "cta", label: "按钮文案", type: "text", default: "下载 QookiX", group: "行动号召" },
    {
      id: "shot",
      label: "竖屏截图",
      type: "asset",
      assetKind: "image",
      default: "",
      group: "素材",
      help: "建议使用竖向截图或录屏。",
    },
    { id: "accent", label: "主色", type: "color", default: "#C97640", group: "外观" },
  ],

  build(values, ctx) {
    const theme = ctx.theme;
    const accent = sColor(values, "accent", theme.accent);
    const accentLight = lighten(accent, 0.24);
    const headline = sStr(values, "headline", "一句话\n做出宣传片");
    const subline = sStr(values, "subline", "竖屏快剪 · 15 秒讲清楚");
    const cta = sStr(values, "cta", "下载 QookiX");
    const shot = sAsset(values, "shot", ctx, "image");
    const shotId = shot ? shot.id : "";
    const captions = [
      sStr(values, "caption1", "拖入素材就能剪"),
      sStr(values, "caption2", "模板一键套用"),
      sStr(values, "caption3", "导出即投放全平台"),
    ];
    const plateColor =
      theme.mode === "dark" ? withAlpha(theme.bg0, 0.74) : withAlpha("#ffffff", 0.88);

    const content = new TrackBuilder("visual", "内容");
    const overlay = new TrackBuilder("visual", "叠加");

    /* ---- 开场大字 0.0-3.4 ------------------------------------------ */
    const hero = makeClip("text", {
      theme,
      text: headline,
      variant: "hero",
      duration: 3.4,
      name: "主标题",
      props: {
        fontSize: 96,
        fontWeight: 800,
        lineHeight: 1.18,
        maxWidth: 900,
        gradient: { enabled: true, from: theme.text1, to: accentLight, angle: 100 },
        glowBlur: 24,
        glowColor: withAlpha(accent, 0.28),
      },
      // 整帧向上冲入的转场 + 弹入缩放，是竖屏短视频最常见的开场力度。
      transitionIn: tr("slideUp", 0.5),
      enter: popIn(0.95, 0.84),
      exit: fadeOut(2.8, 0.6),
    });
    content.place(put(hero, 0, HERO_Y), 0);

    const sub = makeClip("text", {
      theme,
      text: subline,
      variant: "body",
      duration: 2.5,
      name: "副标题",
      props: {
        fontSize: 40,
        fontWeight: 500,
        color: theme.text2,
        letterSpacing: 0.06,
        maxWidth: 860,
        lineHeight: 1.4,
      },
      enter: offsetAnimation(riseIn(0.7, 40, 0.3), "transform.y", SUB_Y),
      exit: fadeOut(1.8, 0.6),
    });
    content.place(put(sub, 0, SUB_Y), 0.7);

    /* ---- 手机演示 2.6-9.0 ------------------------------------------ */
    const phone = makeClip("device", {
      theme,
      assetId: shotId,
      duration: 6.4,
      name: "手机界面",
      props: {
        device: "phone",
        assetId: shotId,
        fit: "cover",
        width: 620,
        height: 1120,
        radius: 64,
        padding: 0,
        shadow: true,
      },
      transitionIn: tr("slideUp", 0.55),
      // 呼吸式缩放：只改 scale，`put()` 定的坐标不会被吃掉。
      extra: delayAnimation(breathe(0.012, 3.4, 4), 1),
      exit: fadeOut(5.6, 0.8),
    });
    content.place(put(phone, 0, PHONE_Y), 2.6);

    /* ---- 三条快切字幕 2.9-8.9 -------------------------------------- */
    captions.forEach((caption, i) => {
      const start = 2.9 + i * 2;
      const captionText = makeClip("text", {
        theme,
        text: caption,
        variant: "body",
        duration: 2,
        name: `字幕 ${i + 1}`,
        props: {
          fontSize: 34,
          fontWeight: 600,
          color: theme.text1,
          maxWidth: 500,
          lineHeight: 1.4,
          letterSpacing: 0.04,
          // 文字自带的圆角底板，像平台自带字幕条。
          background: {
            enabled: true,
            color: plateColor,
            paddingX: 26,
            paddingY: 16,
            radius: 999,
          },
        },
        enter: mergeAnimations(
          popIn(0.5, 0.86),
          offsetAnimation(slideIn("bottom", 0.45, 45), "transform.y", CAPTION_Y),
        ),
        exit: fadeOut(1.55, 0.45),
      });
      overlay.place(put(captionText, 0, CAPTION_Y), start);
    });

    /* ---- 收尾号召 9.3-13.8 ----------------------------------------- */
    const closing = makeClip("text", {
      theme,
      text: headline,
      variant: "title",
      duration: 4.4,
      name: "收尾标题",
      props: {
        fontSize: 76,
        fontWeight: 800,
        lineHeight: 1.16,
        maxWidth: 900,
        color: theme.text1,
        letterSpacing: 0.02,
      },
      enter: offsetAnimation(riseIn(0.85, 50, 0.15), "transform.y", CLOSING_Y),
      exit: fadeOut(3.7, 0.6),
    });
    content.place(put(closing, 0, CLOSING_Y), 9.3);

    const pill = makeClip("shape", {
      theme,
      duration: 3.9,
      name: "按钮底",
      props: {
        shape: "rect",
        width: 620,
        height: 140,
        radius: 70,
        fillGradient: { enabled: true, from: accent, to: accentLight, angle: 90 },
        strokeWidth: 0,
      },
      transitionIn: tr("circleOpen", 0.5),
      exit: fadeOut(3.3, 0.6),
    });
    content.place(put(pill, 0, CTA_Y), 9.9);

    const ctaText = makeClip("text", {
      theme,
      text: cta,
      variant: "subtitle",
      duration: 3.8,
      name: "按钮文案",
      props: {
        fontSize: 46,
        fontWeight: 700,
        color: readableOn(accent),
        letterSpacing: 0.06,
        maxWidth: 520,
      },
      enter: offsetAnimation(riseIn(0.6, 30, 0.4), "transform.y", CTA_Y),
      exit: fadeOut(3.2, 0.6),
    });
    content.place(put(ctaText, 0, CTA_Y), 10);

    /* ---- 背景 ------------------------------------------------------- */
    const background = [
      makeBackground(theme, 15, {
        pattern: "grid",
        patternColor: withAlpha(accent, 0.1),
        patternScale: 76,
        patternSpeed: 12,
        vignette: 0.5,
        blobs: [
          { x: 0.3, y: 0.18, radius: 520, color: withAlpha(accent, 0.3), speed: 3.5 },
          { x: 0.72, y: 0.78, radius: 560, color: withAlpha(accentLight, 0.18), speed: -2.5 },
        ],
      }),
      makeBackground(
        theme,
        5.8,
        {
          pattern: "dots",
          patternColor: withAlpha(accentLight, 0.14),
          patternScale: 64,
          patternSpeed: 16,
          vignette: 0.52,
          blobs: [{ x: 0.5, y: 0.62, radius: 720, color: withAlpha(accent, 0.34), speed: 2 }],
        },
        9.2,
      ),
    ];

    return buildTemplateProject(socialVerticalTemplate, values, ctx, [content.track, overlay.track], {
      background,
    });
  },
};
