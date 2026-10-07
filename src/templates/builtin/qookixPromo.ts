import {
  blurIn,
  breathe,
  fadeOut,
  floatY,
  mapAnimation,
  mergeAnimations,
  offsetAnimation,
  popIn,
  riseIn,
  scaleSettle,
} from "../../core/motion";
import type { AnimationMap, Clip, EasingName, TextStyle } from "../../core/types";
import { BRAND_COOKIE_ID } from "../builtinAssets";
import {
  buildTemplateProject,
  makeBackground,
  makeClip,
  sAsset,
  sColor,
  sStr,
  TrackBuilder,
} from "../kit";
import type { PromoTemplate } from "../types";

/**
 * QookiX Launcher 宣传片 —— 完整版品牌片。
 *
 * 这是内置模板里信息量最大的一条：品牌开场 → 界面演示 → 功能亮点 → 行动号召 →
 * 收尾落版，五个镜头连成 32 秒。它同时是模板写法的参考实现，示范了如何用
 * `offsetAnimation` 把入场动效叠加到已经定位好的元素上。
 */

/* ------------------------------------------------------------------ *
 * Local motion helpers
 * ------------------------------------------------------------------ */

/** A pure single-axis ramp. Avoids the duplicate opacity curves that reusing
 * `riseIn` alongside another entrance preset would create. */
function ramp(
  path: string,
  from: number,
  to: number,
  duration: number,
  delay = 0,
  easing: EasingName = "easeOutQuart",
): AnimationMap {
  return {
    [path]: [
      { time: delay, value: from, easing: "linear" },
      { time: delay + duration, value: to, easing },
    ],
  };
}

/** Positions a clip by its centre offset from the middle of the frame. */
function place(clip: Clip, x: number, y: number, scale?: number): Clip {
  clip.transform = {
    ...clip.transform,
    x,
    y,
    scale: scale === undefined ? clip.transform.scale : scale,
  };
  return clip;
}

/** Continuous vertical drift centred on `baseY`. */
function drift(baseY: number, amplitude: number, period = 4, cycles = 8): AnimationMap {
  return offsetAnimation(floatY(amplitude, period, cycles), "transform.y", baseY);
}

function titleStyle(accent: string, accentHover: string, size: number): Partial<TextStyle> {
  return {
    fontSize: size,
    fontWeight: 800,
    lineHeight: 1.12,
    letterSpacing: -0.01,
    align: "center",
    maxWidth: 1360,
    gradient: { enabled: true, from: accentHover, to: accent, angle: 102 },
  };
}

/* ------------------------------------------------------------------ *
 * Layout constants (1920x1080, centre origin)
 * ------------------------------------------------------------------ */

const CARD_Y = 60;
const CARD_W = 470;
const CARD_H = 300;
const CARD_X = [-520, 0, 520];

export const qookixPromoTemplate: PromoTemplate = {
  id: "qookix-promo",
  name: "QookiX 启动器宣传片",
  description:
    "32 秒完整品牌片：曲奇 Logo 开场、浏览器界面演示、三张功能卡、行动号召与落版，QookiX 官方橙色预设。",
  category: "product",
  tags: ["QookiX", "完整片", "界面演示", "品牌"],
  aspect: "16:9",
  duration: 32,
  themeKey: "presentation",

  slots: [
    { id: "appName", label: "产品名称", type: "text", default: "QookiX Launcher", group: "文案" },
    { id: "tagline", label: "一句话介绍", type: "text", default: "全新 Minecraft 启动器", group: "文案" },
    {
      id: "url",
      label: "浏览器地址栏",
      type: "text",
      default: "qookix.local",
      group: "文案",
      help: "界面演示窗口顶部显示的网址。",
    },
    {
      id: "caption1",
      label: "演示字幕 1",
      type: "text",
      default: "一站式整合版本与资源",
      group: "界面演示",
    },
    {
      id: "caption2",
      label: "演示字幕 2",
      type: "text",
      default: "秒开游戏，不再等待",
      group: "界面演示",
    },
    {
      id: "caption3",
      label: "演示字幕 3",
      type: "text",
      default: "云端同步，随处继续",
      group: "界面演示",
    },
    { id: "sectionTitle", label: "功能区标题", type: "text", default: "核心功能", group: "功能亮点" },    { id: "feature1Title", label: "功能 1 · 标题", type: "text", default: "一站式整合", group: "功能亮点" },
    {
      id: "feature1Body",
      label: "功能 1 · 说明",
      type: "textarea",
      default: "版本、整合包、资源与光影统一管理，不再东拼西凑。",
      group: "功能亮点",
    },
    { id: "feature2Title", label: "功能 2 · 标题", type: "text", default: "秒开游戏", group: "功能亮点" },
    {
      id: "feature2Body",
      label: "功能 2 · 说明",
      type: "textarea",
      default: "优化启动链路与内存占用，点开就能进游戏。",
      group: "功能亮点",
    },
    { id: "feature3Title", label: "功能 3 · 标题", type: "text", default: "云端同步", group: "功能亮点" },
    {
      id: "feature3Body",
      label: "功能 3 · 说明",
      type: "textarea",
      default: "存档、配置与键位跟着账号走，换台电脑继续玩。",
      group: "功能亮点",
    },
    { id: "ctaTitle", label: "号召标题", type: "text", default: "现在就开始", group: "行动号召" },
    { id: "ctaButton", label: "按钮文字", type: "text", default: "立即下载", group: "行动号召" },
    { id: "ctaSub", label: "按钮下方说明", type: "text", default: "qookix.local/download", group: "行动号召" },
    { id: "wordmark", label: "落版文字", type: "text", default: "QookiX", group: "落版" },
    {
      id: "accent",
      label: "主题色",
      type: "color",
      default: "#C97640",
      group: "外观",
      help: "默认取用 QookiX 品牌橙。",
    },
    {
      id: "logo",
      label: "品牌 Logo",
      type: "asset",
      assetKind: "image",
      default: BRAND_COOKIE_ID,
      group: "素材",
    },
    {
      id: "screenshot",
      label: "产品截图 / 录屏",
      type: "asset",
      assetKind: "image",
      default: "",
      group: "素材",
      help: "留空时自动使用素材库里的第一张图片。",
    },
  ],

  build(values, ctx) {
    const theme = ctx.theme;
    const accent = sColor(values, "accent", theme.accent);
    const accentHover = theme.accentHover;
    const appName = sStr(values, "appName", "QookiX Launcher");
    const tagline = sStr(values, "tagline", "全新 Minecraft 启动器");
    const url = sStr(values, "url", "qookix.local");
    const wordmark = sStr(values, "wordmark", "QookiX");
    const ctaTitle = sStr(values, "ctaTitle", "现在就开始");
    const ctaButton = sStr(values, "ctaButton", "立即下载");
    const ctaSub = sStr(values, "ctaSub", "qookix.local/download");
    const sectionTitle = sStr(values, "sectionTitle", "核心功能");

    const logoAsset = sAsset(values, "logo", ctx, "image");
    const screenshot = sAsset(values, "screenshot", ctx, "image");
    const logoId = logoAsset?.id ?? BRAND_COOKIE_ID;

    const content = new TrackBuilder("visual", "内容");
    const put = (time: number, clip: Clip) => {
      content.at(time).push(clip);
      return clip;
    };

    /* ---------------- 镜头一 · 品牌开场 (0 – 6.3s) ---------------- */

    const logo = makeClip("image", {
      theme,
      assetId: logoId,
      name: "品牌 Logo",
      duration: 6.3,
      props: { fit: "contain" },
      enter: mergeAnimations(
        mapAnimation(popIn(0.8, 0.58), "transform.scale", (v) => v * 0.34),
        offsetAnimation(ramp("transform.y", 90, 0, 0.9, 0, "easeOutBack"), "transform.y", -130),
      ),
      extra: mapAnimation(breathe(0.018, 3.4, 4), "transform.scale", (v) => v * 0.34),
    });
    put(0, place(logo, 0, -130, 0.34));

    const title = makeClip("text", {
      theme,
      text: appName,
      variant: "hero",
      duration: 3.5,
      name: "产品名称",
      props: { ...titleStyle(accent, accentHover, 132), glowBlur: 26, glowColor: "rgba(201,118,64,0.35)" },
      enter: mergeAnimations(
        riseIn(0.85, 80, 0, "easeOutBack"),
        offsetAnimation(fadeInRange(0.5), "opacity", 0),
      ),
      exit: fadeOut(2.9, 0.6),
    });
    put(2.4, place(title, 0, 168));

    const taglineClip = makeClip("text", {
      theme,
      text: tagline,
      variant: "subtitle",
      duration: 2.9,
      name: "一句话介绍",
      props: {
        color: theme.text2,
        fontSize: 46,
        fontWeight: 500,
        letterSpacing: 0.04,
        align: "center",
        maxWidth: 1200,
      },
      enter: mergeAnimations(riseIn(0.8, 50, 0.12), offsetAnimation(fadeInRange(0.5, 0.12), "opacity", 0)),
      exit: fadeOut(2.3, 0.6),
    });
    put(3.5, place(taglineClip, 0, 262));

    /* ---------------- 镜头二 · 界面演示 (6.0 – 14.4s) ---------------- */

    const device = makeClip("device", {
      theme,
      assetId: screenshot?.id ?? "",
      name: "界面演示",
      duration: 8.4,
      props: {
        device: "browser",
        width: 1280,
        height: 720,
        url,
        radius: 18,
        tiltY: -9,
        tiltX: 5,
        shadow: true,
        fit: "cover",
        frameColor: theme.bg2,
      },
      enter: mergeAnimations(blurIn(0.95, 24), scaleSettle(1.9, 1.1)),
      exit: fadeOut(7.9, 0.5),
      extra: drift(-40, 9, 4.2, 4),
    });
    put(6.0, place(device, 0, -40));

    const captions = [
      sStr(values, "caption1", "一站式整合版本与资源"),
      sStr(values, "caption2", "秒开游戏，不再等待"),
      sStr(values, "caption3", "云端同步，随处继续"),
    ];
    captions.forEach((text, i) => {
      const start = 7.2 + i * 2.4;
      const caption = makeClip("text", {
        theme,
        text,
        variant: "body",
        duration: 2.5,
        name: `演示字幕 ${i + 1}`,
        props: {
          color: theme.text1,
          fontSize: 44,
          fontWeight: 600,
          letterSpacing: 0.02,
          align: "center",
          maxWidth: 1100,
          reveal: "wordRise",
          revealDuration: 0.75,
          revealStagger: 0.07,
          glowBlur: 14,
          glowColor: "rgba(0,0,0,0.6)",
        },
        enter: riseIn(0.6, 40, 0, "easeOutCubic"),
        exit: fadeOut(1.9, 0.55),
      });
      put(start, place(caption, 0, 436));
    });

    /* ---------------- 镜头三 · 功能亮点 (13.7 – 21.6s) ---------------- */

    const section = makeClip("text", {
      theme,
      text: sectionTitle,
      variant: "title",
      duration: 1.6,
      name: "功能区标题",
      props: {
        fontSize: 54,
        fontWeight: 700,
        letterSpacing: 0.24,
        align: "center",
        maxWidth: 900,
        color: theme.text3,
        reveal: "maskWipe",
        revealDuration: 0.7,
      },
      enter: fadeInRange(0.5),
      exit: fadeOut(1.1, 0.5),
    });
    put(13.7, place(section, 0, -302));

    const features = [
      {
        title: sStr(values, "feature1Title", "一站式整合"),
        body: sStr(values, "feature1Body", ""),
      },
      {
        title: sStr(values, "feature2Title", "秒开游戏"),
        body: sStr(values, "feature2Body", ""),
      },
      {
        title: sStr(values, "feature3Title", "云端同步"),
        body: sStr(values, "feature3Body", ""),
      },
    ];

    features.forEach((feature, i) => {
      const cx = CARD_X[i] ?? 0;
      const start = 14.0 + i * 0.45;

      const card = makeClip("shape", {
        theme,
        duration: 7.6 - i * 0.45,
        name: `功能卡 ${i + 1}`,
        props: {
          shape: "rect",
          width: CARD_W,
          height: CARD_H,
          radius: 30,
          fill: "rgba(255,255,255,0.045)",
          strokeWidth: 2,
          strokeColor: "rgba(232,154,90,0.22)",
        },
        enter: mergeAnimations(
          popIn(0.7, 0.86, 0, "easeOutBack"),
          offsetAnimation(ramp("transform.y", 60, 0, 0.8), "transform.y", CARD_Y),
        ),
        exit: fadeOut(6.9 - i * 0.45, 0.55),
      });
      put(start, place(card, cx, CARD_Y));

      const dot = makeClip("shape", {
        theme,
        duration: 7.6 - i * 0.45,
        name: `功能卡 ${i + 1} · 标记`,
        props: {
          shape: "ellipse",
          width: 58,
          height: 58,
          fill: accent,
          fillGradient: { enabled: true, from: accentHover, to: accent, angle: 120 },
        },
        enter: popIn(0.6, 0.2, 0.12 + i * 0.05, "easeOutBack"),
        exit: fadeOut(6.9 - i * 0.45, 0.55),
      });
      put(start + 0.05, place(dot, cx, CARD_Y - 66));

      const cardTitle = makeClip("text", {
        theme,
        text: feature.title,
        variant: "title",
        duration: 7.5 - i * 0.45,
        name: `功能卡 ${i + 1} · 标题`,
        props: {
          fontSize: 42,
          fontWeight: 700,
          align: "center",
          maxWidth: CARD_W - 80,
          color: theme.text1,
          reveal: "wordRise",
          revealDuration: 0.6,
          revealStagger: 0.06,
        },
        enter: fadeInRange(0.45, 0.18),
        exit: fadeOut(6.85 - i * 0.45, 0.55),
      });
      put(start + 0.1, place(cardTitle, cx, CARD_Y + 42));

      const cardBody = makeClip("text", {
        theme,
        text: feature.body,
        variant: "body",
        duration: 7.4 - i * 0.45,
        name: `功能卡 ${i + 1} · 说明`,
        props: {
          fontSize: 27,
          fontWeight: 400,
          lineHeight: 1.55,
          align: "center",
          maxWidth: CARD_W - 96,
          color: theme.text3,
        },
        enter: fadeInRange(0.5, 0.3),
        exit: fadeOut(6.8 - i * 0.45, 0.55),
      });
      put(start + 0.15, place(cardBody, cx, CARD_Y + 116));
    });

    /* ---------------- 镜头四 · 行动号召 (21.5 – 27.2s) ---------------- */

    const ctaTitleClip = makeClip("text", {
      theme,
      text: ctaTitle,
      variant: "hero",
      duration: 5.7,
      name: "号召标题",
      props: titleStyle(accent, accentHover, 118),
      enter: mergeAnimations(popIn(0.75, 0.88), offsetAnimation(ramp("transform.y", 60, 0, 0.85), "transform.y", -150)),
      exit: fadeOut(5.0, 0.6),
    });
    put(21.5, place(ctaTitleClip, 0, -150));

    const button = makeClip("shape", {
      theme,
      duration: 5.2,
      name: "下载按钮",
      props: {
        shape: "rect",
        width: 430,
        height: 104,
        radius: 52,
        fill: accent,
        fillGradient: { enabled: true, from: accentHover, to: accent, angle: 100 },
        strokeWidth: 0,
        strokeColor: accent,
      },
      enter: mergeAnimations(
        popIn(0.65, 0.6, 0.18, "easeOutBack"),
        offsetAnimation(fadeInRange(0.4, 0.18), "opacity", 0),
      ),
      exit: fadeOut(4.55, 0.6),
    });
    put(22.1, place(button, 0, 70));

    const buttonLabel = makeClip("text", {
      theme,
      text: ctaButton,
      variant: "title",
      duration: 5.0,
      name: "按钮文字",
      props: {
        fontSize: 42,
        fontWeight: 700,
        letterSpacing: 0.02,
        align: "center",
        maxWidth: 380,
        color: "#1b1008",
      },
      enter: fadeInRange(0.45, 0.34),
      exit: fadeOut(4.45, 0.6),
    });
    put(22.2, place(buttonLabel, 0, 70));

    const ctaSubClip = makeClip("text", {
      theme,
      text: ctaSub,
      variant: "caption",
      duration: 4.6,
      name: "按钮说明",
      props: {
        fontSize: 30,
        fontWeight: 500,
        letterSpacing: 0.06,
        align: "center",
        maxWidth: 900,
        color: theme.text3,
      },
      enter: fadeInRange(0.5, 0.55),
      exit: fadeOut(4.0, 0.6),
    });
    put(22.6, place(ctaSubClip, 0, 186));

    /* ---------------- 镜头五 · 落版 (27.0 – 32s) ---------------- */

    const endLogo = makeClip("image", {
      theme,
      assetId: logoId,
      name: "落版 Logo",
      duration: 5.0,
      props: { fit: "contain" },
      enter: mergeAnimations(
        mapAnimation(popIn(0.7, 0.7), "transform.scale", (v) => v * 0.2),
        offsetAnimation(ramp("transform.y", 40, 0, 0.8), "transform.y", -58),
      ),
      exit: fadeOut(4.2, 0.8),
    });
    put(27.0, place(endLogo, 0, -58, 0.2));

    const endWord = makeClip("text", {
      theme,
      text: wordmark,
      variant: "hero",
      duration: 4.5,
      name: "落版文字",
      props: {
        fontSize: 92,
        fontWeight: 800,
        letterSpacing: 0.05,
        align: "center",
        maxWidth: 900,
        color: theme.text1,
      },
      enter: fadeInRange(0.6, 0.25),
      exit: fadeOut(3.7, 0.8),
    });
    put(27.5, place(endWord, 0, 152));

    /* ---------------- 背景 ---------------- */

    const background = [
      makeBackground(
        theme,
        32,
        {
          color: theme.bg0,
          gradient: { enabled: true, from: theme.bg1, to: theme.bg0, angle: 145 },
          pattern: "pixelGrid",
          patternColor: "rgba(201,118,64,0.055)",
          patternScale: 72,
          patternSpeed: 10,
          vignette: 0.42,
          blobs: [
            { x: 0.22, y: 0.26, radius: 620, color: "rgba(201,118,64,0.32)", speed: 4 },
            { x: 0.8, y: 0.7, radius: 540, color: "rgba(165,83,46,0.24)", speed: -3 },
          ],
        },
        0,
      ),
    ];

    return buildTemplateProject(qookixPromoTemplate, values, ctx, [content.track], { background });
  },
};

/** Simple fade-in from 0 to 1, used where only opacity should move. */
function fadeInRange(duration: number, delay = 0): AnimationMap {
  return ramp("opacity", 0, 1, duration, delay, "easeOutQuad");
}
