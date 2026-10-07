import { lighten, readableOn, withAlpha } from "../../core/color";
import {
  delayAnimation,
  fadeOut,
  mergeAnimations,
  offsetAnimation,
  offsetPaths,
  popIn,
  pulse,
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
  sStr,
  tr,
} from "../kit";
import type { PromoTemplate } from "../types";

/**
 * 「全新版本发布」——版本号主视觉 + 四条升级亮点 + 下载按钮，全长 24 秒。
 *
 * 镜头表：
 *   0.0-5.2   产品名 / 「全新版本」徽标 / 大号版本号 / 一句话主张
 *   5.8-14.6  两条横向卡片，每条并排两条升级亮点，左右各自滑入
 *   15.4-23.0 下载按钮（胶囊 + 圆形展开）+ 版本信息行
 *
 * 4 条亮点用「两行两列」表达：每行一块大圆角底板，行内两段文字并排，
 * 这样 4 条信息只需要 2 个形状，节奏更整齐。
 *
 * 位移预设的关键帧是绝对值、末帧落在 0，所以每个滑入动作都用
 * `offsetAnimation` / `offsetPaths` 平移到底板自己的坐标上。
 */

/** 把图层摆到以画面中心为原点的绝对位置。 */
function put(clip: Clip, x: number, y: number): Clip {
  clip.transform = { ...clip.transform, x, y };
  return clip;
}

/** 升级亮点两行底板与两列文字的坐标。 */
const ROW_Y = [-70, 250];
const ITEM_X = [-360, 360];

export const versionLaunchTemplate: PromoTemplate = {
  id: "version-launch",
  name: "全新版本发布",
  description: "大号版本号主视觉配四条升级亮点，最后落到下载按钮，适合新版本上线。",
  category: "launch",
  tags: ["版本发布", "升级亮点", "下载引导"],
  aspect: "16:9",
  duration: 24,
  themeKey: "presentation",
  slots: [
    { id: "productName", label: "产品名", type: "text", default: "QookiX Studio", group: "文案" },
    { id: "version", label: "版本号", type: "text", default: "v2.0", group: "文案" },
    {
      id: "headline",
      label: "版本主张",
      type: "text",
      default: "全新版本 · 更快更稳",
      group: "文案",
    },
    { id: "item1", label: "亮点一", type: "text", default: "启动速度提升 40%，打开即用", group: "升级亮点" },
    {
      id: "item2",
      label: "亮点二",
      type: "text",
      default: "时间线支持多轨吸附与磁吸对齐",
      group: "升级亮点",
    },
    {
      id: "item3",
      label: "亮点三",
      type: "text",
      default: "导出预设扩展到 12 种分辨率",
      group: "升级亮点",
    },
    {
      id: "item4",
      label: "亮点四",
      type: "text",
      default: "全新的深色界面与快捷键体系",
      group: "升级亮点",
    },
    { id: "ctaText", label: "按钮文案", type: "text", default: "立即下载", group: "行动号召" },
    {
      id: "ctaSub",
      label: "按钮副文案",
      type: "text",
      default: "支持 Windows 10 / 11 · 免费试用 30 天",
      group: "行动号召",
    },
    { id: "accent", label: "主色", type: "color", default: "#C97640", group: "外观" },
  ],

  build(values, ctx) {
    const theme = ctx.theme;
    const accent = sColor(values, "accent", theme.accent);
    const accentLight = lighten(accent, 0.24);
    const productName = sStr(values, "productName", "QookiX Studio");
    const version = sStr(values, "version", "v2.0");
    const headline = sStr(values, "headline", "全新版本 · 更快更稳");
    const ctaText = sStr(values, "ctaText", "立即下载");
    const ctaSub = sStr(values, "ctaSub", "支持 Windows 10 / 11 · 免费试用 30 天");

    const content = new TrackBuilder("visual", "内容");
    const overlay = new TrackBuilder("visual", "叠加");

    /* ---- 第一幕 0.0-5.2：版本号主视觉 ------------------------------ */
    const eyebrow = makeClip("text", {
      theme,
      text: productName,
      variant: "subtitle",
      duration: 5,
      name: "产品名",
      props: {
        fontSize: 36,
        fontWeight: 600,
        color: theme.text3,
        letterSpacing: 0.34,
        uppercase: true,
        maxWidth: 1200,
      },
      enter: offsetAnimation(riseIn(0.8, 40, 0.15), "transform.y", -430),
      exit: fadeOut(4.3, 0.7),
    });
    overlay.place(put(eyebrow, 0, -430), 0.2);

    const badge = makeClip("text", {
      theme,
      text: "全新版本",
      variant: "badge",
      duration: 5.05,
      name: "版本徽标",
      props: {
        fontSize: 30,
        fontWeight: 600,
        color: accentLight,
        letterSpacing: 0.3,
        uppercase: true,
        maxWidth: 900,
        // 文字自带的圆角底板，省掉一个形状图层。
        background: {
          enabled: true,
          color: withAlpha(accent, 0.16),
          paddingX: 30,
          paddingY: 16,
          radius: 999,
        },
      },
      enter: popIn(0.75, 0.82, 0.1),
      exit: fadeOut(4.35, 0.7),
    });
    overlay.place(put(badge, 0, -300), 0.15);

    const versionText = makeClip("text", {
      theme,
      text: version,
      variant: "hero",
      duration: 5.2,
      name: "版本号",
      props: {
        fontSize: 250,
        fontWeight: 800,
        maxWidth: 1000,
        letterSpacing: 0.02,
        gradient: { enabled: true, from: accentLight, to: accent, angle: 100 },
        glowBlur: 36,
        glowColor: withAlpha(accent, 0.4),
      },
      // 从下方升起的同时轻微放大，落地后再补一下心跳式的脉冲。
      enter: mergeAnimations(riseIn(1, 120), popIn(1, 0.86), pulse(2.05, 0.5, 1.03)),
      exit: fadeOut(4.4, 0.8),
    });
    content.place(versionText, 0);

    const headlineText = makeClip("text", {
      theme,
      text: headline,
      variant: "title",
      duration: 4.7,
      name: "版本主张",
      props: { fontSize: 58, fontWeight: 600, color: theme.text1, letterSpacing: 0.08, maxWidth: 1200 },
      enter: offsetAnimation(riseIn(0.85, 50, 0.45), "transform.y", 230),
      exit: fadeOut(4, 0.7),
    });
    content.place(put(headlineText, 0, 230), 0.5);

    /* ---- 第二幕 5.8-14.6：四条升级亮点 ----------------------------- */
    const gridStart = 5.8;
    const gridEnd = 14.6;
    const items = [
      sStr(values, "item1", "启动速度提升 40%，打开即用"),
      sStr(values, "item2", "时间线支持多轨吸附与磁吸对齐"),
      sStr(values, "item3", "导出预设扩展到 12 种分辨率"),
      sStr(values, "item4", "全新的深色界面与快捷键体系"),
    ];

    const sectionTitle = makeClip("text", {
      theme,
      text: "升级亮点",
      variant: "title",
      duration: gridEnd - gridStart,
      name: "小节标题",
      props: {
        fontSize: 46,
        fontWeight: 600,
        color: theme.text2,
        letterSpacing: 0.2,
        maxWidth: 900,
      },
      transitionIn: tr("slideUp", 0.5),
      exit: fadeOut(gridEnd - gridStart - 0.7, 0.7),
    });
    overlay.place(put(sectionTitle, 0, -430), gridStart);

    ROW_Y.forEach((rowY, rowIndex) => {
      const rowStart = gridStart + rowIndex * 0.2;
      const rowCard = makeClip("shape", {
        theme,
        duration: gridEnd - rowStart,
        name: `亮点底板 ${rowIndex + 1}`,
        props: {
          shape: "rect",
          width: 1440,
          height: 250,
          radius: 26,
          fill: theme.mode === "dark" ? withAlpha("#ffffff", 0.06) : withAlpha("#ffffff", 0.88),
          strokeWidth: 2,
          strokeColor: withAlpha(accent, 0.4),
        },
        enter: delayAnimation(
          mergeAnimations(
            offsetAnimation(slideIn("bottom", 0.8, 70), "transform.y", rowY),
            scaleSettle(0.7, 1.04),
          ),
          rowIndex * 0.2,
        ),
        exit: fadeOut(gridEnd - rowStart - 0.7, 0.7),
      });
      content.place(put(rowCard, 0, rowY), rowStart);

      // 行内两条亮点：左列从左侧滑入、右列从右侧滑入，各自带着自己的坐标。
      ITEM_X.forEach((itemX, columnIndex) => {
        const itemIndex = rowIndex * ITEM_X.length + columnIndex;
        const itemStart = gridStart + itemIndex * 0.18 + 0.1;
        const from: "left" | "right" = columnIndex === 0 ? "left" : "right";
        const itemText = makeClip("text", {
          theme,
          text: items[itemIndex],
          variant: "body",
          duration: gridEnd - itemStart - 0.1,
          name: `亮点 ${itemIndex + 1}`,
          props: {
            fontSize: 32,
            color: theme.text1,
            lineHeight: 1.5,
            maxWidth: 620,
          },
          enter: delayAnimation(
            offsetPaths(slideIn(from, 0.75, 90), { "transform.x": itemX, "transform.y": rowY }),
            itemIndex * 0.18 + 0.1,
          ),
          exit: fadeOut(gridEnd - itemStart - 0.8, 0.7),
        });
        content.place(put(itemText, itemX, rowY), itemStart);
      });
    });

    /* ---- 第三幕 15.4-23.0：下载按钮 -------------------------------- */
    const downloadPill = makeClip("shape", {
      theme,
      duration: 7.6,
      name: "下载按钮底",
      props: {
        shape: "rect",
        width: 540,
        height: 132,
        radius: 66,
        fillGradient: { enabled: true, from: accent, to: accentLight, angle: 90 },
        strokeWidth: 0,
      },
      transitionIn: tr("circleOpen", 0.55),
      exit: fadeOut(6.9, 0.7),
    });
    content.place(put(downloadPill, 0, 80), 15.4);

    const downloadText = makeClip("text", {
      theme,
      text: ctaText,
      variant: "subtitle",
      duration: 7.5,
      name: "下载按钮文案",
      props: {
        fontSize: 44,
        fontWeight: 700,
        color: readableOn(accent),
        letterSpacing: 0.08,
        maxWidth: 460,
      },
      enter: offsetAnimation(riseIn(0.7, 40, 0.45), "transform.y", 80),
      exit: fadeOut(6.8, 0.7),
    });
    content.place(put(downloadText, 0, 80), 15.5);

    const subText = makeClip("text", {
      theme,
      text: ctaSub,
      variant: "body",
      duration: 6.8,
      name: "按钮副文案",
      props: { fontSize: 30, color: theme.text3, letterSpacing: 0.06, maxWidth: 1100 },
      enter: offsetAnimation(riseIn(0.7, 36, 0.5), "transform.y", 230),
      exit: fadeOut(6.1, 0.7),
    });
    content.place(put(subText, 0, 230), 16.2);

    /* ---- 背景 ------------------------------------------------------- */
    const background = [
      makeBackground(theme, 24, {
        pattern: "pixelGrid",
        patternColor: withAlpha(accent, 0.06),
        patternScale: 88,
        patternSpeed: 8,
        vignette: 0.45,
        blobs: [
          { x: 0.18, y: 0.22, radius: 560, color: withAlpha(accent, 0.26), speed: 3 },
          { x: 0.84, y: 0.78, radius: 500, color: withAlpha(accentLight, 0.16), speed: -2.5 },
        ],
      }),
      makeBackground(
        theme,
        8.6,
        {
          pattern: "grid",
          patternColor: withAlpha(accentLight, 0.12),
          patternScale: 64,
          patternSpeed: 12,
          vignette: 0.5,
          blobs: [{ x: 0.5, y: 0.55, radius: 680, color: withAlpha(accent, 0.34), speed: 2 }],
        },
        15.4,
      ),
    ];

    return buildTemplateProject(versionLaunchTemplate, values, ctx, [content.track, overlay.track], {
      background,
    });
  },
};
