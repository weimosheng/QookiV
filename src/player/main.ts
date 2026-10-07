import { effectiveDuration, formatTimecode } from "../core/time";
import type { Project, Seconds } from "../core/types";
import { Renderer } from "../render/Renderer";
import { audioAt, mediaAt, PlayerMediaPool } from "./mediaProvider";

/**
 * QookiV 单页播放器的入口。
 *
 * 这是一个"零依赖、零框架"的 IIFE：宿主页面只需要一个 `<div id="qookiv-root">`
 * 或 `document.body`，播放器自己建 DOM、自己注入样式。画面由编辑器同款
 * `Renderer` 绘制，所以导出的网页、编辑器预览和视频导出的像素是一致的。
 */

export interface PlayerOptions {
  /** 允许尝试自动播放（浏览器策略下通常会先静音播放）。 */
  autoplay?: boolean;
  /** 播放结束后回到开头继续。 */
  loop?: boolean;
  /** 覆盖强调色。 */
  accent?: string;
}

declare global {
  interface Window {
    __QOOKIV_PROJECT__?: unknown;
    __QOOKIV_OPTIONS__?: PlayerOptions;
  }
}

const DEFAULT_ACCENT = "#C97640";
const BRAND_BG = "#0b0d12";
const RENDER_QUALITY = "preview" as const;
const STEP_SECONDS = 1;

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function fallbackText(text: string, message: string): string {
  return text.length > 0 ? text : message;
}

function wrapScore(value: number, size: number): number {
  if (size <= 0) return 0;
  return ((value % size) + size) % size;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function setVar(el: HTMLElement, name: string, value: string): void {
  try {
    el.style.setProperty(name, value);
  } catch {
    // 老浏览器忽略自定义属性；不影响播放。
  }
}

function appendStyle(target: HTMLElement, css: string): void {
  const style = document.createElement("style");
  style.setAttribute("data-qookiv-player", "style");
  style.textContent = css;
  target.appendChild(style);
}

/** 只在宿主完全没有样式能力时才需要，正常情况下永远用不到。 */
function applyCriticalStyles(el: HTMLElement, styles: Record<string, string>): void {
  for (const key of Object.keys(styles)) {
    try {
      el.style.setProperty(key, styles[key]);
    } catch {
      // 忽略：CSS 里已经有同一份声明。
    }
  }
}

function parseStartParam(): number {
  try {
    if (typeof window === "undefined" || !window.location) return 0;
    const raw = new URLSearchParams(window.location.search).get("t");
    if (raw === null) return 0;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function currentFullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function toggleFullscreen(el: HTMLElement): void {
  const anyEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => void;
  };
  const doc = document as Document & {
    webkitExitFullscreen?: () => void;
    webkitFullscreenEnabled?: boolean;
  };
  const fullscreenElement = currentFullscreenElement();
  try {
    if (fullscreenElement) {
      if (typeof doc.exitFullscreen === "function") {
        void doc.exitFullscreen().catch(() => undefined);
      } else if (typeof doc.webkitExitFullscreen === "function") {
        doc.webkitExitFullscreen();
      }
      return;
    }
    if (typeof el.requestFullscreen === "function") {
      void el.requestFullscreen().catch(() => undefined);
    } else if (typeof anyEl.webkitRequestFullscreen === "function") {
      anyEl.webkitRequestFullscreen();
    }
  } catch {
    // 全屏被策略拒绝时静默失败，不影响其它控制。
  }
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

const PLAYER_CSS = `
.qv-root *{box-sizing:border-box;}
.qv-root{
  position:relative;display:flex;flex-direction:column;
  width:100%;height:100%;min-height:100vh;
  margin:0;padding:0;overflow:hidden;
  background:var(--qv-bg,#0b0d12);color:#f3eee8;
  font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.qv-stage{
  position:relative;flex:1 1 auto;min-height:0;
  display:flex;align-items:center;justify-content:center;
  padding:14px;overflow:hidden;
  background-image:radial-gradient(rgba(255,255,255,.045) 1px,transparent 1px);
  background-size:22px 22px;background-position:center;
}
.qv-stage:fullscreen{padding:0;background-image:none;background:var(--qv-bg,#0b0d12);}
.qv-canvas{
  display:block;max-width:100%;max-height:100%;
  border-radius:6px;background:#000;
  box-shadow:0 18px 54px rgba(0,0,0,.62);
  outline:none;
}
.qv-hint{
  position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  padding:8px 16px;border-radius:999px;
  background:rgba(11,13,18,.74);border:1px solid rgba(201,118,64,.32);
  color:rgba(243,238,232,.86);font-size:13px;letter-spacing:.02em;
  opacity:0;pointer-events:none;transition:opacity .18s ease;
  white-space:nowrap;
}
.qv-hint[data-visible="1"]{opacity:1;}
.qv-overlay{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(120% 120% at 50% 45%,rgba(0,0,0,.24),rgba(0,0,0,.58));
  opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease;
}
.qv-overlay[data-visible="1"]{opacity:1;visibility:visible;}
.qv-overlay-button{
  display:flex;align-items:center;justify-content:center;
  width:84px;height:84px;padding:0;border:none;border-radius:50%;
  background:linear-gradient(140deg,var(--qv-accent,#C97640),var(--qv-accent-deep,#a2542a));
  color:#fff;cursor:pointer;pointer-events:auto;
  box-shadow:0 14px 40px rgba(0,0,0,.5);
  transition:transform .16s ease,filter .16s ease;
}
.qv-overlay-button:hover{transform:scale(1.05);filter:brightness(1.08);}
.qv-overlay-button svg{width:34px;height:34px;margin-left:3px;}
.qv-bar{
  flex:0 0 auto;display:flex;align-items:center;gap:14px;
  padding:10px 16px;
  background:rgba(12,14,20,.94);border-top:1px solid rgba(255,255,255,.07);
}
.qv-bar button{
  display:flex;align-items:center;justify-content:center;
  width:38px;height:38px;padding:0;
  border:1px solid rgba(255,255,255,.10);border-radius:10px;
  background:rgba(255,255,255,.045);color:#f3eee8;cursor:pointer;
  transition:background .16s ease,border-color .16s ease,transform .1s ease;
}
.qv-bar button:hover{background:rgba(255,255,255,.10);border-color:rgba(201,118,64,.5);}
.qv-bar button:active{transform:scale(.95);}
.qv-bar button svg{width:19px;height:19px;}
.qv-play[data-playing="1"]{background:rgba(201,118,64,.22);border-color:rgba(201,118,64,.62);}
.qv-time{
  font-family:"Cascadia Mono",Consolas,"SFMono-Regular",monospace;
  font-size:12.5px;letter-spacing:.02em;color:rgba(243,238,232,.82);
  font-variant-numeric:tabular-nums;white-space:nowrap;
}
.qv-time em{font-style:normal;color:rgba(243,238,232,.38);}
.qv-scrub{
  -webkit-appearance:none;appearance:none;
  flex:1 1 auto;min-width:80px;height:5px;margin:0;
  border-radius:999px;background:rgba(255,255,255,.14);outline:none;cursor:pointer;
}
.qv-scrub::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;
  width:14px;height:14px;border-radius:50%;border:none;
  background:var(--qv-accent,#C97640);cursor:pointer;
  box-shadow:0 0 0 4px rgba(201,118,64,.18);
}
.qv-scrub::-moz-range-thumb{
  width:14px;height:14px;border-radius:50%;border:none;
  background:var(--qv-accent,#C97640);cursor:pointer;
}
.qv-scrub:focus-visible{box-shadow:0 0 0 2px rgba(201,118,64,.55);}
.qv-volume{display:flex;align-items:center;gap:8px;transition:opacity .18s ease;}
.qv-volume svg{width:17px;height:17px;color:rgba(243,238,232,.6);}
.qv-volume input{
  -webkit-appearance:none;appearance:none;
  width:84px;height:4px;margin:0;border-radius:999px;
  background:rgba(255,255,255,.14);outline:none;cursor:pointer;
}
.qv-volume input::-webkit-slider-thumb{
  -webkit-appearance:none;appearance:none;
  width:11px;height:11px;border-radius:50%;border:none;
  background:var(--qv-accent,#C97640);cursor:pointer;
}
.qv-volume input::-moz-range-thumb{
  width:11px;height:11px;border-radius:50%;border:none;
  background:var(--qv-accent,#C97640);cursor:pointer;
}
.qv-fallback{
  margin:auto;max-width:640px;padding:28px 32px;text-align:center;
  color:rgba(243,238,232,.86);font-size:14px;line-height:1.7;
}
.qv-fallback code{
  display:inline-block;padding:2px 6px;border-radius:6px;
  background:rgba(255,255,255,.07);font-size:12.5px;
}
@media (max-width:640px){
  .qv-bar{gap:10px;padding:8px 10px;}
  .qv-volume{display:none;}
  .qv-overlay-button{width:66px;height:66px;}
}
`;

/* ------------------------------------------------------------------ *
 * 图标
 * ------------------------------------------------------------------ */

const ICON_PLAY =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6L19 12z" fill="currentColor"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>';
const ICON_VOLUME =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z" fill="currentColor"/><path d="M15.2 8.6a4.6 4.6 0 0 1 0 6.8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M17.6 6.2a7.8 7.8 0 0 1 0 11.6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z" fill="currentColor"/><path d="M15.4 9.4l4.6 5.2M20 9.4l-4.6 5.2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
const ICON_FULL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

interface PlayerParts {
  root: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLElement;
  overlayButton: HTMLButtonElement;
  hint: HTMLElement;
  playButton: HTMLButtonElement;
  scrub: HTMLInputElement;
  timeLabel: HTMLElement;
  volumeGroup: HTMLElement;
  volumeIcon: HTMLElement;
  volume: HTMLInputElement;
  fullscreenButton: HTMLButtonElement;
}

function buildParts(host: HTMLElement, project: Project, accent: string, hasAudio: boolean): PlayerParts {
  const root = make("div", "qv-root");
  root.setAttribute("data-qookiv-player", "root");
  setVar(root, "--qv-accent", accent);
  setVar(root, "--qv-bg", BRAND_BG);
  applyCriticalStyles(root, {
    position: "relative",
    display: "flex",
    "flex-direction": "column",
    width: "100%",
    height: "100%",
    "min-height": "100vh",
    margin: "0",
    overflow: "hidden",
    background: BRAND_BG,
  });

  const stage = make("div", "qv-stage");
  applyCriticalStyles(stage, {
    position: "relative",
    flex: "1 1 auto",
    "min-height": "0",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    overflow: "hidden",
  });

  const canvas = make("canvas", "qv-canvas");
  canvas.width = Math.max(1, Math.round(project.settings.width));
  canvas.height = Math.max(1, Math.round(project.settings.height));
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", project.name || "QookiV 宣传片");
  applyCriticalStyles(canvas, {
    display: "block",
    "max-width": "100%",
    "max-height": "100%",
  });

  const hint = make("div", "qv-hint");
  applyCriticalStyles(hint, {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%,-50%)",
    opacity: "0",
    "pointer-events": "none",
  });

  const overlay = make("div", "qv-overlay");
  applyCriticalStyles(overlay, {
    position: "absolute",
    inset: "0",
    display: "flex",
    "align-items": "center",
    "justify-content": "center",
    opacity: "0",
    visibility: "hidden",
    "pointer-events": "none",
  });

  const overlayButton = make("button", "qv-overlay-button");
  overlayButton.type = "button";
  overlayButton.setAttribute("aria-label", "播放");
  overlayButton.innerHTML = ICON_PLAY;
  overlay.appendChild(overlayButton);

  stage.appendChild(canvas);
  stage.appendChild(hint);
  stage.appendChild(overlay);

  // ---- 传输栏 -------------------------------------------------------
  const bar = make("div", "qv-bar");
  applyCriticalStyles(bar, {
    flex: "0 0 auto",
    display: "flex",
    "align-items": "center",
    gap: "14px",
    padding: "10px 16px",
  });

  const playButton = make("button", "qv-play");
  playButton.type = "button";
  playButton.setAttribute("aria-label", "播放/暂停");
  playButton.innerHTML = ICON_PLAY;
  playButton.dataset.playing = "0";

  const timeLabel = make("span", "qv-time");

  const scrub = make("input", "qv-scrub");
  scrub.type = "range";
  scrub.min = "0";
  scrub.max = "1000";
  scrub.step = "1";
  scrub.value = "0";
  scrub.setAttribute("aria-label", "进度");

  const volumeGroup = make("div", "qv-volume");
  const volumeIcon = make("span");
  volumeIcon.innerHTML = ICON_VOLUME;
  const volume = make("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "100";
  volume.step = "1";
  volume.value = "85";
  volume.setAttribute("aria-label", "音量");
  volumeGroup.appendChild(volumeIcon);
  volumeGroup.appendChild(volume);
  volumeGroup.hidden = !hasAudio;
  if (!hasAudio) volumeGroup.style.display = "none";

  const fullscreenButton = make("button", "qv-fullscreen");
  fullscreenButton.type = "button";
  fullscreenButton.setAttribute("aria-label", "全屏");
  fullscreenButton.innerHTML = ICON_FULL;

  bar.appendChild(playButton);
  bar.appendChild(timeLabel);
  bar.appendChild(scrub);
  bar.appendChild(volumeGroup);
  bar.appendChild(fullscreenButton);

  root.appendChild(stage);
  root.appendChild(bar);

  if (host.firstChild) host.insertBefore(root, host.firstChild);
  else host.appendChild(root);

  return {
    root,
    stage,
    canvas,
    overlay,
    overlayButton,
    hint,
    playButton,
    scrub,
    timeLabel,
    volumeGroup,
    volumeIcon,
    volume,
    fullscreenButton,
  };
}

/** 挂载播放器；返回一个停止函数，便于宿主卸载。 */
export function mount(project: Project, options: PlayerOptions = {}): () => void {
  const host =
    document.getElementById("qookiv-root") ??
    (document.body as HTMLElement | null);
  if (!host) return () => undefined;

  // 宿主页面可能已经有自己的背景；这里只补一层品牌底色，避免加载时白闪。
  applyCriticalStyles(document.body, { margin: "0", background: BRAND_BG });

  const accent = fallbackText(options.accent ?? "", DEFAULT_ACCENT);
  const pool = new PlayerMediaPool(project);
  const renderer = new Renderer(project, pool);
  const duration = Math.max(0.001, effectiveDuration(project));
  const fps = project.settings.fps > 0 ? project.settings.fps : 30;
  const startAt = Math.min(parseStartParam(), duration);
  const parts = buildParts(host, project, accent, pool.hasAudio(project));

  appendStyle(parts.root, PLAYER_CSS);

  const ctx = parts.canvas.getContext("2d");
  if (!ctx) {
    parts.root.textContent = "当前浏览器不支持 Canvas 2D，无法播放该宣传片。";
    return () => undefined;
  }

  /* ---- 状态 -------------------------------------------------------- */

  let currentTime: Seconds = startAt;
  let playing = false;
  let scrubbing = false;
  let destroyed = false;
  let rafId = 0;
  let lastFrameMs = 0;
  let userGesture = false;
  let globalMuted = false;
  let volumeValue = 0.85;
  let needsSeek = true;
  let seekInFlight = false;
  let playToken = 0;
  let lastTimecode = "";

  /* ---- 尺寸 -------------------------------------------------------- */

  const fitCanvas = (): void => {
    const cw = parts.stage.clientWidth > 0 ? parts.stage.clientWidth : window.innerWidth;
    const ch = parts.stage.clientHeight > 0 ? parts.stage.clientHeight : window.innerHeight;
    const padding = 28;
    const availW = Math.max(1, cw - padding);
    const availH = Math.max(1, ch - padding);
    const ratio = parts.canvas.width / parts.canvas.height || 16 / 9;
    let w = availW;
    let h = w / ratio;
    if (h > availH) {
      h = availH;
      w = h * ratio;
    }
    parts.canvas.style.width = `${Math.round(w)}px`;
    parts.canvas.style.height = `${Math.round(h)}px`;
  };

  /* ---- 界面刷新 ---------------------------------------------------- */

  const setHint = (text: string, visible: boolean): void => {
    if (text) parts.hint.textContent = text;
    parts.hint.dataset.visible = visible ? "1" : "0";
  };

  const refreshOverlay = (): void => {
    const visible = !playing && currentTime < 0.05;
    parts.overlay.dataset.visible = visible ? "1" : "0";
    parts.overlay.style.visibility = visible ? "visible" : "hidden";
  };

  const refreshTimecode = (): void => {
    const now = formatTimecode(currentTime, fps);
    const total = formatTimecode(duration, fps);
    const next = `${now}/${total}`;
    if (next === lastTimecode) return;
    lastTimecode = next;
    // 只有时间码是数字，直接拼进去是安全的；错误信息一律走 textContent。
    parts.timeLabel.innerHTML = `<em>${now}</em> / ${total}`;
  };

  const refreshScrub = (): void => {
    if (scrubbing) return;
    parts.scrub.value = String(Math.round((currentTime / duration) * 1000));
  };

  const refreshPlayButton = (): void => {
    parts.playButton.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    parts.playButton.dataset.playing = playing ? "1" : "0";
    parts.playButton.setAttribute("aria-label", playing ? "暂停" : "播放");
    parts.overlayButton.setAttribute("aria-label", playing ? "暂停" : "播放");
    parts.overlayButton.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  };

  const refreshVolumeIcon = (): void => {
    const silent = globalMuted || volumeValue <= 0.001;
    parts.volumeIcon.innerHTML = silent ? ICON_MUTED : ICON_VOLUME;
  };

  /* ---- 播放控制 ---------------------------------------------------- */

  const renderNow = (time: Seconds): void => {
    if (destroyed) return;
    renderer.renderFrame(ctx, Math.max(0, Math.min(time, duration)), {
      quality: RENDER_QUALITY,
    });
  };

  const stopMedia = (): void => {
    pool.pauseAll();
  };

  /** 精确 seek：等所有视频真正 settle 之后再画一帧。 */
  const preciseSeek = async (time: Seconds): Promise<void> => {
    const token = ++playToken;
    needsSeek = false;
    seekInFlight = true;
    setHint("定位中…", true);
    try {
      await pool.seekAll(mediaAt(project, time));
    } catch {
      // 单个素材失败不应中断播放。
    }
    if (destroyed || token !== playToken) return;
    seekInFlight = false;
    renderNow(time);
    setHint("", false);
  };

  const requestSeek = (time: Seconds): void => {
    currentTime = time;
    needsSeek = true;
    refreshScrub();
    refreshTimecode();
    refreshOverlay();
  };

  const play = (): void => {
    if (destroyed || playing) return;
    if (currentTime >= duration - 0.01) currentTime = 0;
    needsSeek = true;
    playing = true;
    lastFrameMs = 0;
    parts.canvas.focus();
    refreshPlayButton();
    refreshOverlay();
    setHint("", false);

    // 对 seek 尚未就位的视频先精确对齐再起播，避免开头几帧跳动。
    void pool.seekAll(mediaAt(project, currentTime)).then(() => {
      if (destroyed || !playing) return;
      renderNow(currentTime);
      pool.setMuted(globalMuted);
      pool.runAudio(audioAt(project, currentTime));
    });
  };

  const pause = (): void => {
    if (!playing) {
      refreshPlayButton();
      refreshOverlay();
      return;
    }
    playing = false;
    playToken += 1;
    stopMedia();
    refreshPlayButton();
    refreshOverlay();
    needsSeek = false;
    void preciseSeek(currentTime);
  };

  const toggle = (): void => {
    userGesture = true;
    if (playing) pause();
    else play();
  };

  const seekToTime = (time: Seconds, exact: boolean): void => {
    const wrapped = options.loop ? wrapScore(time, duration) : time;
    const target = Math.max(0, Math.min(wrapped, duration));
    const wasPlaying = playing;
    requestSeek(target);
    if (wasPlaying && exact) {
      pool.pauseAll();
      void preciseSeek(target);
    } else if (wasPlaying) {
      // 播放中拖动：暂停元素，让 rAF 立刻重新对齐后再起播。
      pool.pauseAll();
      playToken += 1;
    } else {
      stopMedia();
      if (exact) void preciseSeek(target);
    }
  };

  /* ---- 主循环 ------------------------------------------------------ */

  const stopAtEnd = (): void => {
    playing = false;
    stopMedia();
    currentTime = duration;
    refreshPlayButton();
    refreshOverlay();
    refreshScrub();
    refreshTimecode();
    needsSeek = true;
    void preciseSeek(duration);
  };

  const loop = (ms: number): void => {
    if (destroyed) return;
    const now = ms || 0;

    if (playing) {
      if (lastFrameMs === 0) lastFrameMs = now;
      const delta = (now - lastFrameMs) / 1000;
      lastFrameMs = now;
      if (delta > 0) currentTime += delta;

      if (currentTime >= duration) {
        if (options.loop) {
          currentTime = wrapScore(currentTime, duration);
          needsSeek = true;
          pool.pauseAll();
          playToken += 1;
        } else {
          stopAtEnd();
          rafId = window.requestAnimationFrame(loop);
          return;
        }
      }

      const active = mediaAt(project, currentTime);
      pool.runVideos(active);
      pool.runAudio(audioAt(project, currentTime));
      for (const item of active) {
        if (!pool.isReady(item.assetId)) needsSeek = true;
      }

      renderNow(currentTime);
      refreshScrub();
      refreshTimecode();
    } else if (needsSeek && !seekInFlight) {
      needsSeek = false;
      void preciseSeek(currentTime);
    }

    rafId = window.requestAnimationFrame(loop);
  };

  /* ---- 交互绑定 ---------------------------------------------------- */

  const onCanvasClick = (): void => {
    userGesture = true;
    toggle();
  };

  const onTimelineInput = (): void => {
    userGesture = true;
    scrubbing = true;
    const ratio = Number(parts.scrub.value) / 1000;
    const target = Math.max(0, Math.min(duration, ratio * duration));
    currentTime = target;
    refreshTimecode();
    stopMedia();
    playToken += 1;
    // 拖动时立刻画一帧（可能是上一帧），让手指下的画面有反馈；
    // 松手后再精确 seek 到帧边界。
    renderNow(target);
    needsSeek = true;
  };

  const onTimelineCommit = (): void => {
    scrubbing = false;
    const target = currentTime;
    if (playing) {
      // 松手后回到播放状态：主循环会在下一帧重新对齐并继续跑。
      needsSeek = true;
      pool.pauseAll();
      playToken += 1;
    } else {
      void preciseSeek(target);
    }
  };

  const onVolumeInput = (): void => {
    userGesture = true;
    volumeValue = Number(parts.volume.value) / 100;
    globalMuted = volumeValue <= 0.001;
    pool.setMuted(globalMuted);
    refreshVolumeIcon();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key) {
      case " ":
      case "Spacebar":
        event.preventDefault();
        userGesture = true;
        toggle();
        break;
      case "ArrowLeft":
        event.preventDefault();
        seekToTime(currentTime - STEP_SECONDS, true);
        break;
      case "ArrowRight":
        event.preventDefault();
        seekToTime(currentTime + STEP_SECONDS, true);
        break;
      case "Home":
        event.preventDefault();
        seekToTime(0, true);
        break;
      case "End":
        event.preventDefault();
        seekToTime(duration, true);
        break;
      case "f":
      case "F":
        event.preventDefault();
        toggleFullscreen(parts.root);
        break;
      default:
        break;
    }
  };

  const onFullscreenChange = (): void => {
    const active = !!currentFullscreenElement();
    parts.fullscreenButton.setAttribute("aria-label", active ? "退出全屏" : "全屏");
    fitCanvas();
  };

  const onResize = (): void => {
    fitCanvas();
  };

  /** 首次交互时解除"自动播放静音"。 */
  const onFirstGesture = (): void => {
    if (userGesture) return;
    userGesture = true;
    if (!globalMuted) pool.setMuted(false);
  };

  parts.canvas.addEventListener("click", onCanvasClick);
  parts.overlayButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle();
  });
  parts.playButton.addEventListener("click", toggle);
  parts.fullscreenButton.addEventListener("click", () => toggleFullscreen(parts.root));
  parts.volume.addEventListener("input", onVolumeInput);
  parts.volume.addEventListener("change", onVolumeInput);
  parts.scrub.addEventListener("input", onTimelineInput);
  parts.scrub.addEventListener("change", onTimelineCommit);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);
  window.addEventListener("pointerdown", onFirstGesture, true);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(parts.stage);
  }

  /* ---- 起播 -------------------------------------------------------- */

  fitCanvas();
  refreshPlayButton();
  refreshOverlay();
  refreshScrub();
  refreshTimecode();
  refreshVolumeIcon();
  if (pool.hasAudio(project)) {
    parts.volume.value = String(Math.round(volumeValue * 100));
  }

  renderNow(currentTime);
  needsSeek = true;

  if (options.autoplay) {
    // 浏览器策略：自动播放必须静音起步，用户第一次交互后再恢复声音。
    globalMuted = true;
    pool.setMuted(true);
    refreshVolumeIcon();
    play();
    setHint("已静音自动播放，点击画面即可开启声音", true);
    window.setTimeout(() => {
      if (!userGesture) setHint("", false);
    }, 4200);
  } else {
    void preciseSeek(currentTime);
  }

  rafId = window.requestAnimationFrame(loop);

  /* ---- 卸载 -------------------------------------------------------- */

  return () => {
    destroyed = true;
    playToken += 1;
    if (rafId) window.cancelAnimationFrame(rafId);
    if (resizeObserver) resizeObserver.disconnect();
    pool.pauseAll();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("pointerdown", onFirstGesture, true);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    if (parts.root.parentNode) parts.root.parentNode.removeChild(parts.root);
    // 池子里的元素没有公共销毁 API，这里只解除引用，交给 GC。
    void pool;
  };
}

/* ------------------------------------------------------------------ *
 * 自举
 * ------------------------------------------------------------------ */

function bootstrap(): void {
  if (typeof document === "undefined") return;
  const project = window.__QOOKIV_PROJECT__ as Project | undefined;
  const host = document.getElementById("qookiv-root");

  if (!project) {
    showFallback(host, "未找到项目数据：页面里缺少 window.__QOOKIV_PROJECT__。");
    return;
  }
  if (!host && !document.body) return;

  try {
    mount(project, window.__QOOKIV_OPTIONS__ ?? {});
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    showFallback(host, `播放器初始化失败：${reason}`);
  }
}

function showFallback(host: HTMLElement | null, message: string): void {
  const target = host ?? document.body;
  if (!target) return;
  applyCriticalStyles(target, {
    margin: "0",
    "min-height": "100vh",
    display: "flex",
    background: BRAND_BG,
    color: "#f3eee8",
  });
  const box = make("div", "qv-fallback", message);
  appendStyle(target, PLAYER_CSS);
  target.appendChild(box);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
}
