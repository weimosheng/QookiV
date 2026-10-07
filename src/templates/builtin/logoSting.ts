import { lighten, withAlpha } from "../../core/color";
import {
  delayAnimation,
  dropIn,
  fadeIn,
  fadeOut,
  mergeAnimations,
  offsetAnimation,
  popIn,
  riseIn,
  scaleSettle,
  wobble,
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
import { BRAND_COOKIE_ID } from "../builtinAssets";
import type { PromoTemplate } from "../types";

/**
 * 「品牌 Logo 演绎」——8 秒品牌 sting。
 *
 * 镜头表：
 *   0.00-7.40  两层光晕椭圆由小扩大，像品牌光从中心散开
 *   0.35-7.40  曲奇 Logo 掉入 + 弹缩（带主色辉光）
 *   1.20-7.40  主色短横线从中心撑开
 *   1.50-7.40  产品名浮起淡入（大字距）
 *   2.10-7.40  标语浮起淡入；两颗四角星点缀
 *
 * Logo 用「无边框 device」当作可定尺寸的图片容器（device 有 width / height，
 * 而 image 图层的包围盒是整帧），这样缩放是围绕 Logo 本身生效的；`dropIn`
 * 的落点用 `offsetAnimation` 平移到 Logo 的基准线上。
 */

/** 把图层摆到以画面中心为原点的绝对位置。 */
function put(clip: Clip, x: number, y: number): Clip {
  clip.transform = { ...clip.transform, x, y };
  return clip;
}

/** 中轴各元素的垂直基准。 */
const LOGO_Y = -100;
const RULE_Y = 150;
const NAME_Y = 220;
const TAGLINE_Y = 320;

export const logoStingTemplate: PromoTemplate = {
  id: "logo-sting",
  name: "品牌 Logo 演绎",
  description: "8 秒品牌 sting：光晕展开、Logo 弹入、产品名浮起，适合片头或片尾。",
  category: "brand",
  tags: ["品牌", "片头", "Logo", "短"],
  aspect: "16:9",
  duration: 8,
  themeKey: "presentation",
  slots: [
    { id: "productName", label: "产品名", type: "text", default: "QookiX", group: "文案" },
    { id: "tagline", label: "标语", type: "text", default: "让创作更简单", group: "文案" },
    {
      id: "logo",
      label: "Logo 素材",
      type: "asset",
      assetKind: "image",
      default: BRAND_COOKIE_ID,
      group: "素材",
      help: "默认使用内置的 QookiX 曲奇标识。",
    },
    { id: "accent", label: "主色", type: "color", default: "#C97640", group: "外观" },
  ],

  build(values, ctx) {
    const theme = ctx.theme;
    const accent = sColor(values, "accent", theme.accent);
    const accentLight = lighten(accent, 0.35);
    const productName = sStr(values, "productName", "QookiX");
    const tagline = sStr(values, "tagline", "让创作更简单");
    const logoId = sStr(values, "logo", BRAND_COOKIE_ID) || BRAND_COOKIE_ID;

    const content = new TrackBuilder("visual", "内容");

    /* ---- 光晕：两层椭圆由小扩大 ------------------------------------ */
    const halo = makeClip("shape", {
      theme,
      duration: 7.4,
      name: "外圈光晕",
      props: {
        shape: "ellipse",
        width: 1000,
        height: 1000,
        fill: withAlpha(accent, 0.1),
        strokeWidth: 0,
      },
      enter: mergeAnimations(scaleSettle(1.6, 0.06), fadeIn(0.8, 0.1)),
      exit: fadeOut(6.5, 0.9),
    });
    content.place(put(halo, 0, LOGO_Y), 0);

    const ring = makeClip("shape", {
      theme,
      duration: 7.2,
      name: "内圈光环",
      props: {
        shape: "ellipse",
        width: 720,
        height: 720,
        fill: withAlpha(accent, 0.14),
        strokeWidth: 3,
        strokeColor: withAlpha(accent, 0.4),
      },
      enter: mergeAnimations(scaleSettle(1.5, 0.05, 0.2), fadeIn(0.7, 0.2)),
      exit: fadeOut(6.4, 0.8),
    });
    content.place(put(ring, 0, LOGO_Y), 0.2);

    /* ---- Logo 0.35-7.40 -------------------------------------------- */
    const logo = makeClip("device", {
      theme,
      assetId: logoId,
      duration: 7.05,
      name: "品牌标识",
      props: {
        device: "bare",
        assetId: logoId,
        fit: "contain",
        width: 380,
        height: 380,
        radius: 0,
        padding: 0,
        shadow: false,
      },
      // 掉入的同时由小放大，再叠一层缩放冲击的转场。
      enter: mergeAnimations(
        popIn(0.9, 0.5),
        offsetAnimation(dropIn(0.6, 70), "transform.y", LOGO_Y),
      ),
      transitionIn: tr("zoomBlur", 0.45),
      exit: fadeOut(6.3, 0.75),
    });
    // 主色辉光：Renderer 会把 filters.shadowBlur 直接交给画布阴影。
    logo.filters = { ...logo.filters, shadowBlur: 60, shadowColor: withAlpha(accent, 0.9) };
    content.place(put(logo, 0, LOGO_Y), 0.35);

    /* ---- 短横线 / 产品名 / 标语 ------------------------------------ */
    const rule = makeClip("shape", {
      theme,
      duration: 6.2,
      name: "分隔短横线",
      props: {
        shape: "rect",
        width: 260,
        height: 6,
        radius: 3,
        fill: withAlpha(accent, 0.8),
        strokeWidth: 0,
      },
      enter: mergeAnimations(fadeIn(0.4, 0.1), scaleSettle(0.7, 0.15, 0.1)),
      exit: fadeOut(5.5, 0.7),
    });
    content.place(put(rule, 0, RULE_Y), 1.2);

    const nameText = makeClip("text", {
      theme,
      text: productName,
      variant: "title",
      duration: 5.9,
      name: "产品名",
      props: {
        fontSize: 76,
        fontWeight: 700,
        color: theme.text1,
        letterSpacing: 0.28,
        maxWidth: 1200,
      },
      // 边淡入边向上浮起，字距拉到 0.28em 让品牌名更稳。
      enter: offsetAnimation(riseIn(1, 44, 0.2), "transform.y", NAME_Y),
      exit: fadeOut(5.2, 0.7),
    });
    content.place(put(nameText, 0, NAME_Y), 1.5);

    const taglineText = makeClip("text", {
      theme,
      text: tagline,
      variant: "body",
      duration: 5.3,
      name: "标语",
      props: {
        fontSize: 30,
        fontWeight: 400,
        color: theme.text3,
        letterSpacing: 0.4,
        maxWidth: 1000,
      },
      enter: offsetAnimation(riseIn(0.9, 30, 0.3), "transform.y", TAGLINE_Y),
      exit: fadeOut(4.6, 0.7),
    });
    content.place(put(taglineText, 0, TAGLINE_Y), 2.1);

    /* ---- 四角星点缀 ------------------------------------------------ */
    const sparks = [
      { x: -330, y: -230, size: 46, start: 1, duration: 6.1, degrees: 10 },
      { x: 310, y: 90, size: 34, start: 1.35, duration: 5.75, degrees: -14 },
    ];
    sparks.forEach((spark, i) => {
      const star = makeClip("shape", {
        theme,
        duration: spark.duration,
        name: `星芒 ${i + 1}`,
        props: {
          shape: "star",
          width: spark.size,
          height: spark.size,
          points: 4,
          innerRadius: 0.32,
          fill: accentLight,
          strokeWidth: 0,
        },
        enter: delayAnimation(
          mergeAnimations(popIn(0.5, 0.4), wobble(1.1, spark.degrees)),
          spark.start,
        ),
        exit: fadeOut(spark.duration - 0.6, 0.6),
      });
      content.place(put(star, spark.x, spark.y), spark.start);
    });

    /* ---- 背景：缓慢旋转的主色光芒 ---------------------------------- */
    const background = [
      makeBackground(theme, 8, {
        pattern: "rays",
        patternColor: withAlpha(accent, 0.1),
        patternScale: 72,
        patternSpeed: 6,
        vignette: 0.56,
        blobs: [{ x: 0.5, y: 0.44, radius: 760, color: withAlpha(accent, 0.32), speed: 2 }],
      }),
    ];

    return buildTemplateProject(logoStingTemplate, values, ctx, [content.track], { background });
  },
};
