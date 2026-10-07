import { darken, lighten, withAlpha } from "../../core/color";
import { kf, mergeAnimations } from "../../core/motion";
import type { AnimationMap, Clip, EasingName, SlotRecord, ThemeTokens } from "../../core/types";
import { BRAND_COOKIE_ID } from "../builtinAssets";
import {
  buildTemplateProject,
  makeBackground,
  makeClip,
  sAsset,
  sColor,
  sRaw,
  sRecords,
  sRecAssetId,
  sRecBool,
  sRecRecords,
  sRecStr,
  sStr,
  TrackBuilder,
} from "../kit";
import type { PromoTemplate } from "../types";

/**
 * 「简约发布片」——米白底 + 焦糖强调的极简产品片。
 *
 * 全长由**面板数量**决定（默认 4 个面板 19.25 秒），不再是固定的 31.75 秒。
 *
 * 这份版式是对着一支手写的简约风宣传片（一个自包含的 HTML + GSAP 页面）
 * 一比一复刻的，所以下面每个时刻、每条缓动、每个像素都注明了它来自参考片的哪一句。
 * 参考片只做四件事：
 *
 *   1. 一张纹丝不动的米白底（`#FAF8F5`），全片唯一的对比来自字重与焦糖色；
 *   2. 左侧一列大标题 + 清单，**同一时刻只有一条是亮的**：亮的那条变成焦糖色、
 *      放大 1.15、右移 22px、模糊清零，其余压到 42% 并带 1.2px 模糊；
 *   3. 右侧一张界面卡片，**横向推移换图**：旧图整张滑出左边、新图从右边滑进来。
 *      卡片只有一组参数（尺寸 + 边框），所以"手机卡长成桌面卡"是一次尺寸+边框
 *      的补间：1105×506 + 8px 深色厚边 ↔ 1330×866 + 1px 发丝细边；
 *   4. 场景之间用**三条焦糖斜切片**扫过整屏（`0.25s 进 + 0.12s 停 + 0.25s 出`），
 *      每一次换图都藏在切片后面。
 *
 * 三处"参考片能做、渲染器做不到"的地方，以及等价替代（各自的详细说明见调用处）：
 *   - `clip-path` 斜向遮罩 → 用"移动的焦糖窄带 + 两层截图错位铺"逼近揭示方向；
 *   - CSS `skewX(-20deg)` → 形状层没有 skew，用等价的旋转 + 加大高度逼近；
 *   - 长截图在窗口内滚动 → 设备层新增 `props.scroll`（取景偏移）真实支持了。
 */

/* ------------------------------------------------------------------ *
 * 关键帧糖
 *
 * 关键帧存的是**绝对值**：`[t, from]` 不会"等到 t 再动"，而是从 0 秒起就一路
 * 飘向目标。所以只要涉及"先停住、再动"，都必须先在该时刻放一帧 `hold`。
 * ------------------------------------------------------------------ */

/** 一条曲线：(时间, 值, 进入该帧的缓动)。 */
function curve(path: string, frames: Array<[number, number | string, EasingName?]>): AnimationMap {
  return { [path]: frames.map(([time, value, easing]) => kf(time, value, easing ?? "linear")) };
}

/** `t` 之前保持 `from`，随后用 `dur` 秒过渡到 `to`。 */
function step(
  path: string,
  t: number,
  from: number | string,
  to: number | string,
  dur: number,
  easing: EasingName = "easeOutCubic",
): AnimationMap {
  return curve(path, [
    [t, from, "hold"],
    [t + dur, to, easing],
  ]);
}

/** 合并多条曲线；同一路径上的关键帧按时间拼接。 */
function merge(...maps: AnimationMap[]): AnimationMap {
  return mergeAnimations(...maps);
}

/** 按画面中心为原点摆放，并指定锚点（文字左对齐用 `anchorX = 0`）。 */
function put(clip: Clip, x: number, y: number, scale = 1, anchorX = 0.5): Clip {
  clip.transform = { ...clip.transform, x, y, scale, anchorX };
  return clip;
}

/* ------------------------------------------------------------------ *
 * 版式常量（1920×1080，画面中心为原点）
 *
 * 参考片用 CSS 的 left/top 定位，这里换算成"以画面中心为原点"的坐标：
 * `x = left + width / 2 - 960`、`y = top + height / 2 - 540`。
 * ------------------------------------------------------------------ */

/** 左侧文案面板：`padding-top:300px`、`left:104px`、宽 460、行高 76。 */
const PANEL_X = -856;
const PANEL_TITLE_Y = -186;
const ITEM_Y0 = -48;
const ITEM_GAP = 76;
/** 高亮时右移的距离与放大倍数（参考片 `hl()`：`x:22, scale:1.15`）。 */
const ITEM_LIFT = 22;
const ITEM_SCALE = 1.15;
/** 未聚焦时的透明度（参考片 `opacity:.42` + `blur(1.2px)`）。 */
const ITEM_DIM = 0.42;
/** 面板入场 / 退场：`panelIn` 0.68s power3.out、`panelOut` 0.48s power2.in。 */
const PANEL_IN_DUR = 0.68;
const PANEL_OUT_DUR = 0.48;

/** 卡片底色与手机卡的厚边色（参考片 `.screen-card` / `CARD_PHONE`）。 */
const CARD_BG = "#0D1117";
const PHONE_FRAME = "#241C16";
/** 桌面卡的细边（参考片 `1px solid rgba(180,140,105,0.14)`）。 */
const DESK_STROKE = "rgba(180,140,105,0.14)";

/** 卡片的尺寸参数。`w/h` 是**含边框**的外框尺寸，`pad` 是边框厚度。 */
interface CardSize {
  w: number;
  h: number;
  /** 卡片中心的 x（画面中心为原点）。 */
  x: number;
  /** 外框圆角。 */
  radius: number;
  /** 边框厚度：手机卡 8px，桌面卡 1px。 */
  pad: number;
}

/**
 * 两种卡片尺寸，直接对应参考片的 `SIZE_PHONE` / `SIZE_DESK`。
 *
 * `left:658, top:287, 1105×506` → 中心 (1210.5, 540) → `x = 250.5`
 * `left:548, top:107, 1330×866` → 中心 (1213, 540) → `x = 253`
 */
const SIZE_PHONE: CardSize = { w: 1105, h: 506, x: 250.5, radius: 30, pad: 8 };
const SIZE_DESK: CardSize = { w: 1330, h: 866, x: 253, radius: 30, pad: 1 };

/* ---------------- 开场与落款的版式 ---------------- */

/** `#heroLogo`：280×280 居中。 */
const HERO_LOGO_H = 280;
/** 飞向左上角后的直径：调大到 80，让左上角的品牌区更醒目。 */
const CORNER_LOGO_H = 80;
/** `#heroLogo` 的落位：距左 90px、距上 70px → 中心 (-830, -430)。 */
const CORNER_X = -830;
const CORNER_Y = -430;
/** `#heroTitle`：`font-size:66, letter-spacing:.02em`，落在 `top:calc(50% + 190px)`。 */
const HERO_TITLE_Y = 226;
/** `#heroSub`：`font-size:23, letter-spacing:.36em`，`margin-top:16px`。 */
const HERO_SUB_Y = 292;

type CardEntrance =
  /** 跟着容器一起淡入（场景里的第一张卡）。 */
  | { kind: "fade"; at: number; dur: number }
  /** 从画面右侧推进来（参考片 `xPercent:100 → 0`）。 */
  | { kind: "push"; at: number; dur: number };

type CardExit =
  /** 被下一张卡推走（参考片 `xPercent:0 → -100`）。 */
  | { kind: "push"; at: number; dur: number }
  /** 原地淡出（用于收尾）。 */
  | { kind: "fade"; at: number; dur: number };

interface CardSpec {
  size: CardSize;
  /**
   * 尺寸过渡的起点：填了就说明这张卡要在入场过程中从 from 长/缩到 size
   * （截图、外框、边框厚度、圆角一起动）。安卓最后一张图就是这么从手机卡
   * 1105×506 长成桌面卡 1330×866 的。
   */
  from?: CardSize;
  /** 这张卡要额外给 `props.scroll` 打点（长截图在窗口内滚动）。 */
  scroll?: boolean;
  assetId: string;
  name: string;
  start: number;
  /** 片段终点；推走动画的尾巴要算进来。 */
  end: number;
  enter: CardEntrance;
  exit: CardExit;
}

/** 卡片外框 / 截图的盒子尺寸与圆角（截图要按边框厚度向内缩）。 */
interface CardBox {
  w: number;
  h: number;
  radius: number;
}

function boxOf(size: CardSize, kind: "frame" | "shot"): CardBox {
  if (kind === "frame") return { w: size.w, h: size.h, radius: size.radius };
  const inset = size.pad * 2;
  return {
    w: size.w - inset,
    h: size.h - inset,
    radius: Math.max(0, size.radius - size.pad),
  };
}

/**
 * 整张卡的水平位移。
 *
 * 参考片的换图是"整张推走"：旧图 `xPercent:-100`、新图 `xPercent:100 → 0`，
 * 两者用同一段行程，所以中途**严丝合缝地拼在一起**，屏幕上始终有一整张图。
 * 换算成像素：走满"一个整档" = 半个画面 + 半个卡宽。
 */
function cardTravel(size: CardSize): number {
  return 960 + size.w / 2;
}

function cardAnimation(spec: CardSpec): AnimationMap {
  const { size } = spec;
  const travel = cardTravel(size);
  const rest = size.x;
  const maps: AnimationMap[] = [];
  const pushIn = spec.enter.kind === "push" && PUSH_IN_WINDOW;
  const pushOut = spec.exit.kind === "push" && PUSH_IN_WINDOW;

  if (pushIn) {
    maps.push(
      curve("transform.x", [
        [0, rest + travel, "hold"],
        [spec.enter.at, rest + travel, "easeInOutCubic"],
        [spec.enter.at + spec.enter.dur, rest, "easeInOutCubic"],
      ]),
    );
  } else if (spec.enter.kind === "push") {
    // 不推：新卡从透明淡进来（和旧卡的淡出交叉，屏幕上不会出现空白）。
    maps.push(curve("transform.x", [[0, rest, "hold"]]));
    maps.push(step("opacity", spec.enter.at, 0, 1, spec.enter.dur, "easeInOutCubic"));
  } else {
    maps.push(curve("transform.x", [[0, rest, "hold"]]));
    maps.push(step("opacity", spec.enter.at, 0, 1, spec.enter.dur, "easeOutCubic"));
  }

  if (pushOut) {
    maps.push(
      curve("transform.x", [
        [spec.exit.at, rest, "easeInOutCubic"],
        [spec.exit.at + spec.exit.dur, rest - travel, "easeInOutCubic"],
      ]),
    );
  } else {
    maps.push(step("opacity", spec.exit.at, 1, 0, spec.exit.dur, "easeInOutCubic"));
  }

  return merge(...maps);
}

/**
 * 尺寸过渡的曲线：宽、高、圆角各来一条，外加外框的填充色与描边宽度。
 *
 * 参考片把这件事写成两条并行的补间：`#screen` 走 `SIZE_PHONE`/`SIZE_DESK`
 * （0.72s power3.inOut），`#screenCard` 走 `CARD_PHONE`/`CARD_DESK`（0.4s power2.out）。
 * 也就是**容器尺寸和数据里的边框一起动**，这里合成一条曲线，缓动用 `easeInOutCubic`
 * 逼近 power3.inOut。
 *
 * `withMotion` 控制要不要连 `transform.x` 一起动：卡片在推进来的时候 x 由推入曲线
 * 负责，这里再写一条会撞在同一时刻上（后写的说了算，卡片就会先瞬移回静止位再滑一次）。
 */
function morphCurves(
  from: CardSize,
  to: CardSize,
  at: number,
  dur: number,
  kind: "frame" | "shot",
  withMotion: boolean,
): AnimationMap {
  const a = boxOf(from, kind);
  const b = boxOf(to, kind);
  const maps: AnimationMap[] = [
    step("props.width", at, a.w, b.w, dur, "easeInOutCubic"),
    step("props.height", at, a.h, b.h, dur, "easeInOutCubic"),
    step("props.radius", at, a.radius, b.radius, dur, "easeInOutCubic"),
  ];
  if (withMotion) {
    // 两种尺寸的中心 x 差 2.5px，一起动才不会看起来"跳"了一下
    maps.push(step("transform.x", at, from.x, to.x, dur, "easeInOutCubic"));
  }
  if (kind === "frame") {
    maps.push(
      step("props.fill", at, frameFill(from), frameFill(to), dur, "easeInOutQuad"),
      step("props.strokeWidth", at, frameStroke(from), frameStroke(to), dur, "easeInOutQuad"),
    );
  }
  return merge(...maps);
}

/** 厚边卡靠填充造边框，细边卡靠描边（参考片 `CARD_PHONE` / `CARD_DESK`）。 */
function frameFill(size: CardSize): string {
  return size.pad > 4 ? PHONE_FRAME : "rgba(0,0,0,0)";
}

function frameStroke(size: CardSize): number {
  return size.pad > 4 ? 0 : 2;
}

/** 一张卡 = 外框（厚边或细描边）+ 一张截图（bare 设备层自带圆角裁切）。 */
function buildCard(track: TrackBuilder, theme: ThemeTokens, spec: CardSpec): void {
  const { size, from } = spec;
  const duration = spec.end - spec.start;
  const motion = cardAnimation(spec);

  // 尺寸过渡跟入场同时开始（参考片两条补间都从换图时刻起）。推进来的卡片
  // x 由推入曲线负责，尺寸过渡不能再写 x（会撞在同一时刻）。
  const morphAt = spec.enter.at;
  const morphDur = spec.enter.dur;
  const morphOf = (kind: "frame" | "shot"): AnimationMap =>
    from ? morphCurves(from, size, morphAt, morphDur, kind, spec.enter.kind === "fade") : {};

  /**
   * 长截图在窗口内滚动（参考片给那张 GitHub 长图写的 `y: 0 → -(实高 - 窗高)`，
   * 2.7s、power2.inOut、比换图晚 0.35s 起）。这里用设备层新增的 `props.scroll`
   * （0→1 的"滚到底比例"）表达同一件事，渲染层再按截图实高换算成像素。
   */
  const scrollOf = (): AnimationMap =>
    spec.scroll
      ? step("props.scroll", (spec.enter.kind === "push" ? spec.enter.at : 0) + 0.35, 0, 1, 2.7, "easeInOutQuad")
      : {};

  const frameBox = boxOf(size, "frame");
  const frame = makeClip("shape", {
    theme,
    duration,
    name: `${spec.name} · 外框`,
    props: {
      shape: "rect",
      width: frameBox.w,
      height: frameBox.h,
      radius: frameBox.radius,
      fill: frameFill(size),
      strokeWidth: frameStroke(size),
      strokeColor: size.pad > 4 ? "rgba(0,0,0,0)" : DESK_STROKE,
    },
  });
  frame.animation = merge(motion, morphOf("frame"));
  track.place(put(frame, size.x, 0), spec.start);

  const shotBox = boxOf(size, "shot");
  const shot = makeClip("device", {
    theme,
    duration,
    name: spec.name,
    props: {
      device: "bare",
      assetId: spec.assetId,
      fit: "cover",
      width: shotBox.w,
      height: shotBox.h,
      radius: shotBox.radius,
      frameColor: CARD_BG,
      url: "",
      tiltX: 0,
      tiltY: 0,
      padding: 0,
      shadow: false,
      scroll: 0,
    },
  });
  shot.animation = merge(motion, morphOf("shot"), scrollOf());
  track.place(put(shot, size.x, 0), spec.start);
}

/* ------------------------------------------------------------------ *
 * 左侧文案面板
 * ------------------------------------------------------------------ */

interface PanelItemSpec {
  text: string;
  /** 时间线上亮起的时刻。 */
  at: number;
  /** 时间线上重新变暗的时刻；不填则一直亮到面板退场。 */
  off?: number;
}

/**
 * 面板 = 一个大标题 + 若干清单条目。
 *
 * 条目是**独立片段**（不是一段多行文字），因为高亮要同时改颜色、模糊、缩放与
 * 位移——只有一帧一条才能各自持有曲线。代价是同一轨道上多条并发，时间线会按
 * 泳道把它们错开显示。
 */
function buildPanel(
  track: TrackBuilder,
  theme: ThemeTokens,
  palette: Palette,
  spec: { title: string; start: number; out: number; items: PanelItemSpec[] },
): void {
  const duration = spec.out + PANEL_OUT_DUR - spec.start;
  const out = spec.out - spec.start;

  const title = makeClip("text", {
    theme,
    text: spec.title,
    variant: "title",
    duration,
    name: `面板 · ${spec.title}`,
    props: {
      fontSize: 104,
      fontWeight: 800,
      lineHeight: 1.04,
      letterSpacing: 0.02,
      align: "left",
      maxWidth: 620,
      color: palette.ink,
    },
  });
  // 参考片 `panelIn`：`{opacity:0, y:48} → {opacity:1, y:0}`，0.68s power3.out。
  title.animation = merge(
    step("transform.y", 0, PANEL_TITLE_Y + 48, PANEL_TITLE_Y, PANEL_IN_DUR, "easeOutCubic"),
    step("opacity", 0, 0, 1, PANEL_IN_DUR, "easeOutQuad"),
    // `panelOut`：`{opacity:1, y:0} → {opacity:0, y:-42}`，0.48s power2.in。
    step("transform.y", out, PANEL_TITLE_Y, PANEL_TITLE_Y - 42, PANEL_OUT_DUR, "easeInCubic"),
    step("opacity", out, 1, 0, PANEL_OUT_DUR, "easeInCubic"),
  );
  track.place(put(title, PANEL_X, PANEL_TITLE_Y, 1, 0), spec.start);

  spec.items.forEach((item, index) => {
    const y = ITEM_Y0 + ITEM_GAP * index;
    const at = item.at - spec.start;
    const off = item.off === undefined ? undefined : item.off - spec.start;
    const dimInFlight = off === undefined ? 1 : ITEM_DIM;

    const clip = makeClip("text", {
      theme,
      text: item.text,
      variant: "subtitle",
      duration,
      name: `清单 ${index + 1} · ${item.text}`,
      props: {
        fontSize: 44,
        fontWeight: 800,
        lineHeight: 1,
        letterSpacing: 0.02,
        align: "left",
        maxWidth: 640,
        color: palette.muted,
      },
    });

    clip.animation = merge(
      // 跟着面板浮起、淡入到"未聚焦"状态
      step("transform.y", 0, y + 48, y, PANEL_IN_DUR, "easeOutCubic"),
      step("opacity", 0, 0, ITEM_DIM, PANEL_IN_DUR, "easeOutQuad"),
      // 聚焦（参考片 `hl()` 的"亮"分支）：`back.out(2)`、0.55s
      step("props.style.color", at, palette.muted, palette.caramel, 0.55, "easeOutBack"),
      step("opacity", at, ITEM_DIM, 1, 0.55, "easeOutQuad"),
      step("filters.blur", at, 1.2, 0, 0.45, "easeOutQuad"),
      step("transform.scale", at, 1, ITEM_SCALE, 0.55, "easeOutBack"),
      step("transform.x", at, PANEL_X, PANEL_X + ITEM_LIFT, 0.55, "easeOutBack"),
      // 退场：面板整体上移淡出
      step("transform.y", out, y, y - 42, PANEL_OUT_DUR, "easeInCubic"),
      step("opacity", out, dimInFlight, 0, PANEL_OUT_DUR, "easeInCubic"),
    );

    if (off !== undefined) {
      // 失焦（参考片 `hl()` 的"暗"分支）：`power2.out`、0.46s
      clip.animation = merge(
        clip.animation,
        step("props.style.color", off, palette.caramel, palette.muted, 0.46, "easeOutQuad"),
        step("opacity", off, 1, ITEM_DIM, 0.46, "easeOutQuad"),
        step("filters.blur", off, 0, 1.2, 0.46, "easeOutQuad"),
        step("transform.scale", off, ITEM_SCALE, 1, 0.46, "easeOutQuad"),
        step("transform.x", off, PANEL_X + ITEM_LIFT, PANEL_X, 0.46, "easeOutQuad"),
      );
    }

    track.place(put(clip, PANEL_X, y, 1, 0), spec.start);
  });
}


/* ------------------------------------------------------------------ *
 * 斜切扫场
 * ------------------------------------------------------------------ */

/**
 * 斜切扫场：三条不同深浅的焦糖切片，斜 20°、同一段行程。
 *
 * 参考片的 `.sw` 是 `width:80%`（=1536）、`height:128%`（=1382）、`top:-14%`，
 * `transform: skewX(-20deg) translateX(-3400px)`，行程 `-3200 → 0 → 3200`，
 * 用时 `SW_DUR 0.25 → SW_HOLD 0.12 → 0.25`，三片错开 `0.045s`。
 *
 * 形状层没有 skew，用等价的旋转逼近（旋转会让横边也斜过来，所以高度必须留够，
 * 否则看到的是"三个歪掉的正方形"）：
 *
 *   1. **要盖满整屏**，三条切片的横向排布（`SWEEP_REST`）得往右挪——原来按
 *      "三块拼满 1536"排的静止位，最右那条的右边缘只到 `422+1536·cos20 ≈ 1865`，
 *      画面右侧会一直留着一条没盖住的竖缝；
 *   2. 排布一往右挪，最右那条切片的**左上角就会转进画面**，横边露出来；
 *   3. 所以高度也得加：在旋转 20° 的局部坐标里，画面左上角落在最右切片的
 *      `u ≈ 1486 < 1536`、`v ≈ 2037` 处，取 `SWEEP_H = 2290` 才包得住它。
 *
 * 参考片用 0.25s 扫过，这里为了"三条同时盖住画面"的窗口够宽（换图要藏在里面）
 * 放慢到 `SWEEP_CROSS`，并把停留延长到 `SWEEP_HOLD`。
 */
const SWEEP_TILT = -20;
const SWEEP_W = 1536;
const SWEEP_H = 2290;
const SWEEP_REST = [-365, 156, 677];
const SWEEP_TRAVEL = 3200;
const SWEEP_STAGGER = 0.045;
/** 每条切片从画面外扫进静止位所用的时间（参考片 `SW_DUR`）。 */
const SWEEP_CROSS = 0.45;
/**
 * 三片拼满整屏后停留的时长。
 *
 * 参考片是 0.12s，这里给 0.3s：**藏换图**要用这段时间。换图是"整张推走"，
 * 被扫场盖住的那几次压到 0.45s，所以"三条切片同时压住画面"的窗口
 * （≈ `SWEEP_CROSS − 2·SWEEP_STAGGER + SWEEP_HOLD`）必须比 0.45s 宽出一截，
 * 否则推入的头尾会从切片边缘露出来。
 */
const SWEEP_HOLD = 0.3;

function buildSweep(
  track: TrackBuilder,
  theme: ThemeTokens,
  spec: { at: number; colors: string[] },
): void {
  spec.colors.forEach((color, i) => {
    const delay = SWEEP_STAGGER * i;
    const rest = SWEEP_REST[i];
    const hold = delay + SWEEP_CROSS + SWEEP_HOLD;
    const duration = hold + SWEEP_CROSS + 0.08;

    const bar = makeClip("shape", {
      theme,
      duration,
      name: `扫场 ${i + 1}`,
      props: { shape: "rect", width: SWEEP_W, height: SWEEP_H, radius: 0, fill: color },
    });
    bar.animation = merge(
      curve("transform.x", [
        [0, rest - SWEEP_TRAVEL, "hold"],
        [delay, rest - SWEEP_TRAVEL, "hold"],
        [delay + SWEEP_CROSS, rest, "easeInOutCubic"],
        [hold, rest, "hold"],
        [hold + SWEEP_CROSS, rest + SWEEP_TRAVEL, "easeInQuad"],
      ]),
      step("opacity", delay, 0, 1, SWEEP_CROSS, "easeOutCubic"),
    );
    bar.transform = { ...bar.transform, x: rest, y: 0, rotation: SWEEP_TILT };
    track.place(bar, spec.at);
  });
}

/* ------------------------------------------------------------------ *
 * 模板
 * ------------------------------------------------------------------ */

interface Palette {
  cream: string;
  caramel: string;
  caramelL: string;
  caramelD: string;
  ink: string;
  ink2: string;
  muted: string;
  line: string;
}

/** 换图时长：被扫场盖住的那几次压缩到 0.45s（参考片 `quiet`）。 */
const PUSH_DUR_QUIET = 0.45;

/**
 * 换图用"整张推走"还是"原地交叉溶解"。
 *
 * 参考片能推，是因为两张截图都画在 `#screenCard` 里，而那个盒子有
 * `overflow:hidden`——推的过程被裁在一个**固定窗口**内，观众看到的是
 * "窗口里的画面往左换掉"。QookiV 的截图层画在卡片之上、没有父层裁切，
 * 两张图各推各的，中途就会露出底下的米白（`.scratch/out/ref-swap.png` 里
 * 第 6 帧能看到那条缝）。
 *
 * 所以默认走交叉溶解：同样的 0.45s 时长、同样的曲线，卡片一步不动，
 * 屏幕上不会有缝。想改回推进（并且愿意接受那条缝，或者以后给模板加窗口裁切）
 * 把这个常量改成 `true` 即可。
 */
const PUSH_IN_WINDOW = false;

/** 扫场提前换图的提前量（盖满窗口正中 = 扫场起点 + 1.055）。 */
const HIDDEN_LEAD = 1.055;

/* ------------------------------------------------------------------ *
 * 动态面板 / 链接的默认值
 *
 * 这些是 `list` 槽位的默认条目——用户第一次打开模板时看到的内容，和改造前
 * 的固定 4 面板 / 4 链接完全一致。用户增删面板后，存档里存的就是新条目。
 *
 * 第二张卡带着 `morph: true`：它是第一张“桌面尺寸”的卡，也就是说这里正好是
 * 参考片里那张图“从手机卡长成桌面卡”的时刻，而不是“小卡走掉、大卡进来”。
 * 这个开关现在是**数据**，用户可以把它勾到任意一张卡上。
 * ------------------------------------------------------------------ */

const DEFAULT_PANELS = [
  {
    type: "feature",
    title: "安卓版",
    items: [{ text: "正式上线", image: "", morph: false, scroll: false }],
  },
  {
    type: "feature",
    title: "翻译",
    items: [{ text: "多语言支持", image: "", morph: true, scroll: false }],
  },
  {
    type: "feature",
    title: "按键绑定",
    items: [{ text: "可视化设置", image: "", morph: false, scroll: false }],
  },
  {
    type: "feature",
    title: "小工具",
    items: [{ text: "种子地图", image: "", morph: false, scroll: false }],
  },
] as unknown as SlotRecord[];

const DEFAULT_LINKS = [
  {
    tag: "桌面版",
    url: "https://github.com/weimosheng/QookiX-Launcher",
    badge: "GPL-3.0",
    ver: "现已更新至 v0.11.0",
  },
  {
    tag: "安卓版",
    url: "https://github.com/ZhaYi-Miao/QookiX-Launcher-Android",
    badge: "GPL-3.0",
    ver: "现已更新至 v1.1.0",
  },
  {
    tag: "翻译服务 API 后端",
    url: "https://github.com/ZhaYi-Miao/QookiX-Translate-Platform",
    badge: "MIT",
    ver: "现已更新至 v1.0.0",
  },
  {
    tag: "QookiX 视频",
    url: "https://github.com/ZhaYi-Miao/QookiX-Video",
    badge: "GPL-3.0",
    ver: "",
  },
] as unknown as SlotRecord[];

export const minimalPromoTemplate: PromoTemplate = {
  id: "minimal-promo",
  name: "简约发布片",
  description:
    "米白 + 焦糖的极简产品片：左侧清单逐条聚焦、右侧界面卡片横向推进、斜切扫场换场。默认 4 个面板 19.25 秒，面板越多越长。",
  category: "product",
  tags: ["简约", "浅色", "清单聚焦", "界面演示", "扫场转场"],
  aspect: "16:9",
  /**
   * 标称时长 = **默认槽位**建出来的长度（`TOTAL`，4 个面板 × 1 项）。
   *
   * 这个值会被 `build()` 里的 `settings.duration = TOTAL` 覆盖，而面板数量由表单
   * 决定，所以真实时长会随面板增减变化。它在这里只用来给画廊/检查器显示一个诚实的
   * 数字——曾经写死成重做之前的 31.75，于是卡片上写着"31.75s"、套用出来只有 19.25s。
   */
  duration: 19.25,
  themeKey: "minimalCream",

  slots: [
    { id: "appName", label: "产品名称", type: "text", default: "QookiX Launcher", group: "开场" },
    {
      id: "tagline",
      label: "一句话介绍",
      type: "text",
      default: "安卓版 · 现已上线",
      group: "开场",
      help: "参考片开场标题下面那行小字；留空则不出现。",
    },

    {
      id: "panels",
      label: "内容面板",
      type: "list",
      default: DEFAULT_PANELS,
      group: "内容面板",
      help: "每一个面板是视频里的一段。功能展示型有清单聚焦 + 配图卡片推进；纯内容型只有标题与项。",
      item: {
        addLabel: "添加面板",
        max: 8,
        fields: [
          {
            id: "type",
            label: "面板类型",
            type: "select",
            default: "feature",
            options: [
              { value: "feature", label: "功能展示（清单聚焦 + 配图）" },
              { value: "content", label: "纯内容（标题 + 项）" },
            ],
          },
          { id: "title", label: "面板标题", type: "text", default: "新面板" },
          {
            id: "items",
            label: "项列表",
            type: "list",
            default: [{ text: "新条目", image: "", morph: false, scroll: false }] as unknown as SlotRecord[],
            item: {
              addLabel: "添加一项",
              max: 8,
              fields: [
                { id: "text", label: "介绍", type: "text", default: "新条目" },
                {
                  id: "image",
                  label: "配图",
                  type: "asset",
                  assetKind: "image",
                  default: "",
                  help: "留空时自动使用素材库里的第一张图片。",
                },
                {
                  id: "morph",
                  label: "从手机尺寸长大",
                  type: "boolean",
                  default: false,
                  help: "勾上之后这张卡在入场时**原地**从手机卡尺寸长到桌面卡尺寸（不是“小卡走掉、大卡进来”）。通常勾在切换成桌面布局的那一张上。",
                },
                {
                  id: "scroll",
                  label: "长截图滚动",
                  type: "boolean",
                  default: false,
                  help: "配图是长截图时勾上：入场后 2.7 秒内从顶部滚到底。",
                },
              ],
            },
          },
        ],
      },
    },

    { id: "outro1", label: "落版 · 第一行", type: "text", default: "更多精彩", group: "落版" },
    { id: "outro2", label: "落版 · 第二行", type: "text", default: "等你探索", group: "落版" },
    {
      id: "links",
      label: "落版链接",
      type: "list",
      default: DEFAULT_LINKS,
      group: "落版链接",
      item: {
        addLabel: "添加链接",
        max: 8,
        fields: [
          { id: "tag", label: "标签", type: "text", default: "" },
          { id: "url", label: "地址", type: "text", default: "" },
          { id: "badge", label: "协议", type: "text", default: "" },
          {
            id: "ver",
            label: "版本行",
            type: "text",
            default: "",
            help: "留空则这张卡片不展开版本行。",
          },
        ],
      },
    },

    {
      id: "accent",
      label: "主题色",
      type: "color",
      default: "#C98858",
      group: "外观",
      help: "默认取用简约风的焦糖色，整支片子的强调色都由它派生。",
    },
    {
      id: "logo",
      label: "品牌 Logo",
      type: "asset",
      assetKind: "image",
      default: BRAND_COOKIE_ID,
      group: "素材",
    },
  ],

  build(values, ctx) {
    const theme = ctx.theme;
    const caramel = sColor(values, "accent", theme.accent);
    const palette: Palette = {
      cream: theme.bg0,
      caramel,
      caramelL: lighten(caramel, 0.22),
      caramelD: darken(caramel, 0.16),
      ink: theme.text1,
      ink2: theme.text2,
      muted: theme.text3,
      line: theme.bg2,
    };
    const appName = sStr(values, "appName", "QookiX Launcher");
    const logoAsset = sAsset(values, "logo", ctx, "image");
    const logoId = logoAsset?.id ?? BRAND_COOKIE_ID;
    /**
     * Logo 图层的缩放基准。
     *
     * 参考片里 `#heroLogo` 是一个**固定 280×280 的盒子**、`object-fit:contain`，
     * 所以缩放和素材分辨率无关。QookiV 的图片层是**满幅**的（`measure` 返回整幅画面，
     * 不是素材尺寸），`fit:"contain"` 再按素材宽高比在里面等比放置，于是
     * "画到 H 高"对应的 scale 是：
     *
     *   `H × max(素材宽/素材高, 1) / 画幅高`
     *
     * 用素材实高当基准就错了——同一个图标换成 2 倍分辨率的文件，画面里就会大一圈。
     */
    const logoAspect = Math.max(
      (logoAsset?.width || 1) / Math.max(1, logoAsset?.height || 1),
      1,
    );
    const logoScaleFor = (targetH: number): number => (targetH * logoAspect) / 1080;

    /* ---------------- 动态面板时间轴 ---------------- */
    /**
     * 面板数量由表单决定，时间轴按面板数量分配。
     *
     * 节奏：每个面板 = 入场 0.8s + 每项聚焦 1.8s + 退场 1.0s；面板间隔 1.0s（藏一次扫场）。
     * 开场固定 3.40s，落版固定 4.25s，中间全部给面板。
     */
    const HERO_END = 3.4;
    const ITEM_FOCUS_OFFSET = 0.8;
    const ITEM_GAP = 1.8;
    const PANEL_TAIL = 1.0;
    const PANEL_GAP = 1.0;
    /** 落版前留出的间隔，比面板间略大，让收尾衔接更舒缓、扫场不叠到一起。 */
    const OUTRO_GAP = 1.4;
    const OUTRO_DUR = 4.25;

    const rawPanels = sRecords(values, "panels", DEFAULT_PANELS);
    const panelSpecs = rawPanels.map((panel) => {
      const type = sRecStr(panel, "type", "feature") === "content" ? "content" : "feature";
      const title = sRecStr(panel, "title", "新面板");
      const itemRecords = sRecRecords(panel, "items", []);
      const items = itemRecords.map((rec) => ({
        text: sRecStr(rec, "text", "新条目"),
        imageId: sRecAssetId(rec, "image", ctx),
        morph: sRecBool(rec, "morph", false),
        scroll: sRecBool(rec, "scroll", false),
      }));
      return { type, title, items };
    });

    /** 每个面板的起止时刻 + 其内每项的聚焦时刻。 */
    let cursor = HERO_END;
    const panelTimeline = panelSpecs.map((spec) => {
      const start = cursor;
      const itemCount = Math.max(1, spec.items.length);
      const out = start + ITEM_FOCUS_OFFSET + (itemCount - 1) * ITEM_GAP + PANEL_TAIL;
      const items = spec.items.map((item, k) => ({
        ...item,
        at: start + ITEM_FOCUS_OFFSET + k * ITEM_GAP,
        off: k < spec.items.length - 1 ? start + ITEM_FOCUS_OFFSET + (k + 1) * ITEM_GAP : undefined,
      }));
      cursor = out + PANEL_GAP;
      return { ...spec, start, out, items };
    });
    const outroStart = Math.max(HERO_END + 1, cursor - PANEL_GAP + OUTRO_GAP);
    const TOTAL = outroStart + OUTRO_DUR;

    const text = new TrackBuilder("visual", "文案");
    const screens = new TrackBuilder("visual", "界面演示");
    const overlays = new TrackBuilder("visual", "转场");

    /* ---------------- 开场 0.00 – 3.80 ---------------- */

    /**
     * 图标落位后的 `transform`（画面中心为原点）。
     *
     * 图片层的盒子是满幅 1920×1080，`fit:contain` 把方图居中放进去；**实测**可见
     * 方块的中心就等于 `transform` 的值——落位设计值 −834 / −486 对应屏幕上
     * (126, 54)、边长 52，正是参考片 `left:658+? ` 的位置。
     *
     * 我一度以为要补一项 `(1080 − 目标高)/2`（"方块缩小后会往盒子中心偏"），
     * 结果那是错的模型：按它去移会把图标整块推出画面（实测偏 514px）。
     * 所以这里就是设计值，别再动。
     */
    const cornerCenterX = CORNER_X;
    const cornerCenterY = CORNER_Y;

    // 参考片：`#heroLogo` 从 `{opacity:0, scale:.5, y:26}` 弹到满尺寸，
    // 1.05s `back.out(1.8)`，起点 0.15s。
    const heroLogoStart = 0.15;
    /** Logo 退场安排在落版开始前，避免和落版 Logo 撞在一起。 */
    const logoFadeAt = outroStart - 0.7 - heroLogoStart;
    const logoFadeEnd = outroStart - 0.35 - heroLogoStart;
    const heroLogo = makeClip("image", {
      theme,
      assetId: logoId,
      name: "品牌 Logo",
      duration: logoFadeEnd + 0.1,
      props: { fit: "contain" },
    });
    heroLogo.animation = merge(
      curve("opacity", [
        [0, 0, "hold"],
        [1.05, 1, "easeOutBack"],
        [logoFadeAt, 1, "hold"],
        [logoFadeEnd, 0, "easeInCubic"],
      ]),
      curve("transform.scale", [
        [0, logoScaleFor(HERO_LOGO_H * 0.5), "hold"],
        [1.05, logoScaleFor(HERO_LOGO_H), "easeOutBack"],
        // 参考片：3.00s 起 0.80s power3.inOut 飞到左上角，scale 1 → 0.1857
        [2.85, logoScaleFor(HERO_LOGO_H), "hold"],
        [3.38, logoScaleFor(CORNER_LOGO_H), "easeInOutCubic"],
      ]),
      curve("transform.x", [
        // 参考片：2.45s 向右让位 -250（0.5s power3.out）→ 3.00s 一起飞到左上角。
        [2.3, 0, "hold"],
        [2.8, -250, "easeOutCubic"],
        [3.38, cornerCenterX, "easeInOutCubic"],
      ]),
      curve("transform.y", [
        [0, 26, "hold"],
        [1.05, 0, "easeOutBack"],
        [2.85, 0, "hold"],
        [3.38, cornerCenterY, "easeInOutCubic"],
      ]),
      // 参考片：被文字出来的劲往右带一下（`rotate:14` @2.55 → `0` @2.90）
      curve("transform.rotation", [
        [2.4, 0, "hold"],
        [2.89, 14, "easeOutQuad"],
        [3.38, 0, "easeOutQuad"],
      ]),
    );
    screens.place(put(heroLogo, 0, 0, logoScaleFor(HERO_LOGO_H)), heroLogoStart);

    // 品牌标题：logo 落到左上角后淡入，和大标题（2.75s 已退场）错开，避免两个标题同屏。
    const brandStart = 3.38;
    const brandFadeAt = outroStart - 0.7 - brandStart;
    const brandFadeEnd = outroStart - 0.35 - brandStart;
    const brand = makeClip("text", {
      theme,
      text: appName,
      variant: "subtitle",
      duration: brandFadeEnd + 0.1,
      name: "品牌标题",
      props: {
        fontSize: 38,
        fontWeight: 800,
        letterSpacing: 0.02,
        align: "left",
        maxWidth: 600,
        color: palette.ink,
      },
    });
    brand.animation = merge(
      step("opacity", 0, 0, 1, 0.5, "easeOutCubic"),
      step("opacity", brandFadeAt, 1, 0, brandFadeEnd - brandFadeAt, "easeInCubic"),
    );
    text.place(put(brand, CORNER_X + CORNER_LOGO_H / 2 + 24, CORNER_Y + 8, 1, 0), brandStart);

    // 参考片 `#heroTitle`：`{opacity:0, y:44} → 0`，0.8s power3.out，0.50s 起。
    const heroTitle = makeClip("text", {
      theme,
      text: appName,
      variant: "hero",
      duration: 2.25,
      name: "产品名称",
      props: {
        fontSize: 66,
        fontWeight: 800,
        lineHeight: 1.1,
        letterSpacing: 0.02,
        align: "center",
        maxWidth: 1500,
        color: palette.ink,
      },
    });
    heroTitle.animation = merge(
      step("transform.y", 0, HERO_TITLE_Y + 44, HERO_TITLE_Y, 0.8, "easeOutCubic"),
      step("opacity", 0, 0, 1, 0.8, "easeOutQuad"),
      // 参考片 2.30s：`#heroText {opacity:1,y:0} → {opacity:0,y:-30}`，0.45s power2.in
      step("transform.y", 1.8, HERO_TITLE_Y, HERO_TITLE_Y - 30, 0.45, "easeInCubic"),
      step("opacity", 1.8, 1, 0, 0.45, "easeInCubic"),
    );
    text.place(put(heroTitle, 0, HERO_TITLE_Y), 0.5);

    /**
     * 一句话介绍：**空字符串是有效值**（用户清空这一格＝不要这一行）。
     *
     * 所以这里不能用 `sStr` —— 它把空串当成"这一格没给"并回退到默认文案，
     * 于是清空之后那一行照样出现。`sRaw` 拿到的才是用户真正的选择。
     */
    const taglineRaw = sRaw(values, "tagline");
    const tagline = typeof taglineRaw === "string" ? taglineRaw : "安卓版 · 现已上线";
    if (tagline.trim().length > 0) {
      const heroSub = makeClip("text", {
        theme,
        text: tagline,        variant: "subtitle",
        duration: 1.89,
        name: "一句话介绍",
        props: {
          fontSize: 23,
          fontWeight: 600,
          lineHeight: 1.2,
          letterSpacing: 0.36,
          align: "center",
          maxWidth: 1200,
          color: palette.caramel,
        },
      });
      heroSub.animation = merge(
        step("transform.y", 0, HERO_SUB_Y + 26, HERO_SUB_Y, 0.7, "easeOutCubic"),
        step("opacity", 0, 0, 1, 0.7, "easeOutQuad"),
        step("transform.y", 1.44, HERO_SUB_Y, HERO_SUB_Y - 30, 0.45, "easeInCubic"),
        step("opacity", 1.44, 1, 0, 0.45, "easeInCubic"),
      );
      text.place(put(heroSub, 0, HERO_SUB_Y), 0.86);
    }


    /* ---------------- 内容面板（数据驱动） ---------------- */

    /**
     * 面板数量由表单的 `panels` 槽位决定。功能展示型逐条聚焦；纯内容型所有项同时亮起
     * （把聚焦时刻叠到同一帧，视觉上就是"一起出现并保持"）。
     */
    panelTimeline.forEach((panel) => {
      const items =
        panel.type === "content"
          ? panel.items.map((item) => ({ text: item.text, at: panel.start + 0.8, off: undefined }))
          : panel.items.map((item) => ({ text: item.text, at: item.at, off: item.off }));
      buildPanel(text, theme, palette, {
        title: panel.title,
        start: panel.start,
        out: panel.out,
        items: items.length > 0 ? items : [{ text: " ", at: panel.start + 0.8 }],
      });
    });

    /* ---------------- 界面卡片（按功能展示面板的项配图，横向推进换图） ---------------- */

    /**
     * 每个功能展示面板的每一项配一张图，按时间顺序推进换图。
     * 第一张 fade 入场（手机卡尺寸），后续 push（桌面卡尺寸）；最后一张在落版前 fade 退场。
     * 倒序建立：先建立的在上层，"旧卡压着新卡滑走"成立。
     */
    const cardItems = panelTimeline
      .filter((panel) => panel.type === "feature" && panel.items.length > 0)
      .flatMap((panel) =>
        panel.items.map((item) => ({
          imageId: item.imageId,
          at: item.at,
          panelTitle: panel.title,
          morph: item.morph,
          scroll: item.scroll,
        })),
      );

    if (cardItems.length > 0) {
      const lastCardEnd = outroStart - 0.2;
      const cards: CardSpec[] = cardItems.map((ci, i) => {
        const isFirst = i === 0;
        const isLast = i === cardItems.length - 1;
        const next = cardItems[i + 1];
        /*
         * 勾了「从手机尺寸长大」的卡：**终点是桌面卡、起点是手机卡**，入场过程中
         * 宽/高/圆角/边框一起插值。参考片里安卓段最后那张图就是这么处理的——“小卡
         * 走掉、大卡进来”会把那次换场变成一次硬切。
         *
         * 没勾选时照旧：第一张是手机卡，其余是桌面卡。
         */
        const size = isFirst && !ci.morph ? SIZE_PHONE : SIZE_DESK;
        const enter: CardEntrance = isFirst
          ? { kind: "fade", at: 0.12, dur: 0.9 }
          : { kind: "push", at: 0, dur: PUSH_DUR_QUIET };
        const exit: CardExit = isLast
          ? { kind: "fade", at: Math.max(0.5, lastCardEnd - ci.at - 0.4), dur: 0.4 }
          : { kind: "push", at: next.at - ci.at, dur: PUSH_DUR_QUIET };
        return {
          size,
          from: ci.morph ? SIZE_PHONE : undefined,
          scroll: ci.scroll,
          assetId: ci.imageId,
          name: `${ci.panelTitle} · 卡 ${i + 1}`,
          start: ci.at,
          end: isLast ? lastCardEnd : next.at + PUSH_DUR_QUIET,
          enter,
          exit,
        };
      });
      [...cards].reverse().forEach((card) => buildCard(screens, theme, card));
    }

    /* ---------------- 落版（默认 15.00 – 19.25，随面板数量浮动） ---------------- */

    /**
     * 落版是"左边文案 + 右边仓库卡"两列，参考片用 flex 居中排开。
     *
     * 它的两个列是 `#outroText`（约 490 宽）和 `#oRepos`（880 宽），间隙 150，
     * 合计 1520，居中后整体落在 200..1720。换算到画面中心：
     * 文案列右缘 = 200 + 490 - 960 = **-270**，仓库卡左缘 = 200 + 490 + 150 - 960 = **-120**。
     *
     * 一开始我把它们都放在画面中心附近，结果文案被仓库卡整片盖住——两列必须
     * 按这个换算分开摆。
     */
    const outroTextX = -270;
    const repoX = -120 + 440;
    /** 参考片 `#outroText` 的 `padding-top:44px`（相对 `#outroCols` 的 top:290）。 */
    const outroTextTop = 37;

    const outro1 = makeClip("text", {
      theme,
      text: sStr(values, "outro1", "更多精彩"),
      variant: "hero",
      duration: 4.25,
      name: "落版 · 第一行",
      props: {
        fontSize: 100,
        fontWeight: 800,
        lineHeight: 1.14,
        letterSpacing: 0.06,
        align: "right",
        maxWidth: 900,
        color: palette.ink,
      },
    });
    // 参考片 27.50：`{opacity:0, y:70} → {opacity:1, y:0}`，0.8s `back.out(1.6)`
    outro1.animation = merge(
      step("transform.y", 0, outroTextTop + 70, outroTextTop, 0.8, "easeOutBack"),
      step("opacity", 0, 0, 1, 0.8, "easeOutBack"),
    );
    text.place(put(outro1, outroTextX, outroTextTop, 1, 1), outroStart);

    const outro2 = makeClip("text", {
      theme,
      text: sStr(values, "outro2", "等你探索"),
      variant: "hero",
      duration: 3.75,
      name: "落版 · 第二行",
      props: {
        fontSize: 100,
        fontWeight: 800,
        lineHeight: 1.14,
        letterSpacing: 0.06,
        align: "right",
        maxWidth: 900,
        color: palette.caramel,
      },
    });
    outro2.animation = merge(
      step("transform.y", 0, outroTextTop + 70 + 114, outroTextTop + 114, 0.8, "easeOutBack"),
      step("opacity", 0, 0, 1, 0.8, "easeOutBack"),
    );
    text.place(put(outro2, outroTextX, outroTextTop + 114, 1, 1), outroStart + 0.5);

    // 参考片 `.o-repo`：`border-radius:24`、`padding:9px 24px 10px`、`gap:20`，
    // 主行是 `标签 + 地址 + 协议`，版本行默认 `height:0`，落版开始 0.85s 起逐张展开。
    const links = sRecords(values, "links", DEFAULT_LINKS).map((rec) => ({
      tag: sRecStr(rec, "tag", ""),
      url: sRecStr(rec, "url", ""),
      badge: sRecStr(rec, "badge", ""),
      ver: sRecStr(rec, "ver", ""),
    }));

    const repoStart = outroStart + 0.7;
    // 整列一起淡入：参考片 `#oRepos {opacity:0, y:34} → {opacity:1, y:0}`，0.7s
    const repoTop = -218;
    links.forEach((link, i) => {
      const cardH = 68;
      const y = repoTop + (cardH + 20) * i;
      const duration = TOTAL - repoStart;
      const cardLeft = repoX - 440;
      const cardRight = repoX + 440;
      const cardPad = 24;

      let tagTextW = 0;
      for (const ch of link.tag) {
        if (ch === " ") tagTextW += 5;
        else if (/[\u4e00-\u9fff]/.test(ch)) tagTextW += 17;
        else tagTextW += 10;
      }
      const tagPillW = tagTextW + 36;
      const tagX = cardLeft + cardPad;
      const urlX = tagX + tagPillW + 20;
      const badgeX = cardRight - cardPad;

      const card = makeClip("shape", {
        theme,
        duration,
        name: `链接卡 ${i + 1}`,
        props: {
          shape: "rect",
          width: 880,
          height: cardH,
          radius: 24,
          fill: "rgba(255,253,250,0.82)",
          strokeWidth: 2,
          strokeColor: "rgba(180,140,105,0.2)",
        },
      });
      card.animation = merge(
        step("opacity", 0, 0, 1, 0.7, "easeOutCubic"),
        step("transform.y", 0, y + 34, y, 0.7, "easeOutCubic"),
      );
      text.place(put(card, repoX, y), repoStart);

      const tag = makeClip("text", {
        theme,
        text: link.tag,
        variant: "badge",
        duration,
        name: `链接 ${i + 1} · 标签`,
        props: {
          fontSize: 17,
          fontWeight: 800,
          letterSpacing: 0.06,
          align: "center",
          maxWidth: 260,
          color: "#FFF9F4",
          background: { enabled: true, color: palette.caramel, paddingX: 18, paddingY: 8, radius: 99 },
        },
      });

      const url = makeClip("text", {
        theme,
        text: link.url,
        variant: "caption",
        duration,
        name: `链接 ${i + 1} · 地址`,
        props: {
          fontSize: 18,
          fontWeight: 800,
          letterSpacing: 0,
          align: "left",
          maxWidth: 560,
          color: palette.caramelD,
        },
      });

      const badge = makeClip("text", {
        theme,
        text: link.badge,
        variant: "badge",
        duration,
        name: `链接 ${i + 1} · 协议`,
        props: {
          fontSize: 17,
          fontWeight: 800,
          letterSpacing: 0.06,
          align: "center",
          maxWidth: 200,
          // 参考片这条是"描边药丸"（`border:1.5px solid`）：文字图层画不了单边
          // 描边，所以退成焦糖色文字，在米白卡上同样读得出是"协议徽章"。
          color: palette.caramel,
        },
      });

      const mainY = y - 6;
      for (const clip of [tag, url, badge]) {
        clip.animation = merge(
          step("opacity", 0, 0, 1, 0.7, "easeOutCubic"),
          step("transform.y", 0, mainY + 34, mainY, 0.7, "easeOutCubic"),
        );
      }
      text.place(put(tag, tagX, mainY, 1, 0), repoStart);
      text.place(put(url, urlX, mainY, 1, 0), repoStart);
      text.place(put(badge, badgeX, mainY, 1, 1), repoStart);

      // 版本行：`height: 0 → auto`、`opacity 0 → 1`、`margin-top 0 → 7`，
      // 28.85s 起逐张错开 0.14s（参考片 `.o-ver`）。
      if (link.ver.trim().length > 0) {
        const ver = makeClip("text", {
          theme,
          text: link.ver,
          variant: "caption",
          duration: duration - (0.65 + i * 0.14),
          name: `链接 ${i + 1} · 版本`,
          props: {
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: 0.05,
            align: "left",
            maxWidth: 800,
            color: palette.ink2,
          },
        });
        const verY = y + 22;
        ver.animation = merge(
          step("opacity", 0, 0, 1, 0.45, "easeOutCubic"),
          step("transform.y", 0, verY - 16, verY, 0.45, "easeOutCubic"),
        );
        text.place(put(ver, cardLeft + cardPad, verY, 1, 0), outroStart + 1.35 + i * 0.14);
      }
    });

    // 落版品牌（参考片 `#oBrand`：`top:730`，Logo 108px + 产品名 33px，
    // 29.75s 起：整体 `{opacity:0, y:44} → 0` 0.75s，Logo 另有 `scale .5, rotate -14` 0.9s `back.out(2)`）
    const outroLogo = makeClip("image", {
      theme,
      assetId: logoId,
      name: "落版 Logo",
      duration: 2.0,
      props: { fit: "contain" },
    });
    outroLogo.animation = merge(
      // 参考片 `#oLogoBox`：`108×108`，`{scale:.5, rotate:-14} → {scale:1, rotate:0}`
      curve("transform.scale", [
        [0, logoScaleFor(108 * 0.5), "hold"],
        [0.9, logoScaleFor(108), "easeOutBack"],
      ]),
      curve("transform.rotation", [
        [0, -14, "hold"],
        [0.9, 0, "easeOutBack"],
      ]),
      curve("opacity", [
        [0, 0, "hold"],
        [0.75, 1, "easeOutCubic"],
      ]),
      curve("transform.y", [
        [0, 236 + 44, "hold"],
        [0.75, 236, "easeOutCubic"],
      ]),
    );
    screens.place(put(outroLogo, 0, 236, logoScaleFor(108)), outroStart + 2.25);

    const outroName = makeClip("text", {
      theme,
      text: appName,
      variant: "subtitle",
      duration: 2.0,
      name: "落版产品名",
      props: {
        fontSize: 33,
        fontWeight: 800,
        letterSpacing: 0.02,
        align: "center",
        maxWidth: 900,
        color: palette.ink,
      },
    });
    outroName.animation = merge(
      step("transform.y", 0, 336 + 44, 336, 0.75, "easeOutCubic"),
      step("opacity", 0, 0, 1, 0.75, "easeOutCubic"),
    );
    text.place(put(outroName, 0, 336), outroStart + 2.25);

    /* ---------------- 扫场与收尾 ---------------- */

    /**
     * 扫场藏在面板切换之间：从第二个面板起，每次切换前 `HIDDEN_LEAD` 秒开始扫，
     * 盖住卡片推进的接缝。最后一个扫场盖住面板区到落版的过渡。
     */
    const sweepColors = [palette.caramel, palette.caramelL, "#D89A6C"];
    const sweepAts: number[] = [];
    for (let i = 1; i < panelTimeline.length; i += 1) {
      sweepAts.push(panelTimeline[i].start - HIDDEN_LEAD);
    }
    sweepAts.push(outroStart - HIDDEN_LEAD);
    sweepAts.forEach((at) => {
      if (at > 0.5) buildSweep(overlays, theme, { at, colors: sweepColors });
    });

    /**
     * 收尾遮罩（参考片 `#veil`）。
     *
     * 它**淡入之后保持不透明**：参考片是循环播放的，veil 盖住画面后 `repeat` 回到
     * 开头，观众看到的是一次干净的复位。QookiV 导出到此结束，所以同样保持不透明——
     * 片尾停在米白上，和接下一支片子时的硬边问题一起解决了。
     */
    const veil = makeClip("shape", {
      theme,
      duration: 0.38,
      name: "收尾遮罩",
      props: {
        shape: "rect",
        width: 1920,
        height: 1080,
        radius: 0,
        fill: palette.cream,
      },
    });
    veil.animation = curve("opacity", [
      [0, 0, "hold"],
      [0.38, 1, "linear"],
    ]);
    overlays.place(put(veil, 0, 0), TOTAL - 0.38);

    /* ---------------- 背景：一张纹丝不动的米白 ---------------- */

    const background = [
      makeBackground(theme, TOTAL, {
        color: palette.cream,
        gradient: { enabled: true, from: "#FDFBF8", to: palette.cream, angle: 160 },
        // 极简风靠留白，不靠纹理：不要图案、不要光斑、不要暗角。
        pattern: "none",
        patternColor: withAlpha(palette.caramel, 0.04),
        patternScale: 96,
        patternSpeed: 8,
        vignette: 0,
        blobs: [],
      }),
    ];

    const project = buildTemplateProject(
      minimalPromoTemplate,
      values,
      ctx,
      [screens.track, text.track, overlays.track],
      { background },
    );
    // 面板数量决定实际时长，覆盖模板的标称 duration。
    project.settings.duration = TOTAL;
    return project;
  },
};
