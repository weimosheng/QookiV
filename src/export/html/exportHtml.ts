import type { Asset, Project } from "../../core/types";
import {
  assetsUsedByProject,
  base64ToDataUrl,
  extensionForAsset,
  readAssetMedia,
  resolveMime,
  sanitizeFileStem,
  serializeForScript,
} from "./inlineAssets";

/**
 * 把工程导出成一个可以脱离 QookiV 独立运行的网页。
 *
 * 画面由播放器内联的同一份 `Renderer` 绘制，因此"编辑器预览 = 视频导出 =
 * 网页播放"三者共用一条渲染路径；导出器本身只做三件事：拿到播放器脚本、
 * 把素材变成 data URL（或 assets/ 目录）、拼一份完整的 HTML5 文档。
 *
 * 无论如何都不抛异常：拿不到播放器时也会返回一份能说明问题的降级页面。
 */

export interface HtmlExportOptions {
  /** "single" inlines all media as data URLs; "folder" writes an assets/ sibling directory. */
  mode: "single" | "folder";
  /** Overrides the player bundle source; by default it is fetched from the app. */
  playerSource?: string;
  /** Fired with coarse progress. */
  onProgress?: (progress: { ratio: number; message: string }) => void;
  /** Extra title shown in the browser tab. */
  title?: string;
}

export interface HtmlExportAsset {
  /** File name to write next to index.html (folder mode only). */
  name: string;
  /** Raw bytes, base64 encoded. */
  base64: string;
  mime: string;
}

export interface HtmlExportBundle {
  /** The complete index.html contents. */
  html: string;
  /** Sibling files to write next to index.html; always empty in "single" mode. */
  assets: HtmlExportAsset[];
  warnings: string[];
}

/** 播放器脚本在应用里的默认位置（由 `pnpm build:player` 产出）。 */
const DEFAULT_PLAYER_URL = "/qookiv-player.js";

/** 超过这个体积就提醒用户：浏览器加载几十 MB 的 base64 会明显变慢。 */
const LARGE_PAYLOAD_BYTES = 40 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * 素材处理
 * ------------------------------------------------------------------ */

interface InlinedMedia {
  src: string;
  asset?: HtmlExportAsset;
  bytes: number;
}

/** 生成 `assets/` 下不会被覆盖的文件名：`<assetId>.<ext>`，重名再加序号。 */
function uniqueAssetName(asset: Asset, extension: string, taken: Set<string>): string {
  const stem = sanitizeFileStem(asset.id || asset.name, "asset");
  const ext = extension || "bin";
  let name = `${stem}.${ext}`;
  let index = 2;
  while (taken.has(name)) {
    name = `${stem}-${index}.${ext}`;
    index += 1;
  }
  taken.add(name);
  return name;
}

/** 按需把单个素材变成 data URL 或 `assets/<name>`。 */
async function inlineOne(
  asset: Asset,
  mode: "single" | "folder",
  taken: Set<string>,
  warnings: string[],
): Promise<InlinedMedia> {
  const media = await readAssetMedia(asset);

  if (!media || !media.base64) {
    warnings.push(
      `素材「${asset.name || asset.id}」读取失败，已在网页中保留原始地址（可能无法显示）。`,
    );
    return { src: asset.src, bytes: 0 };
  }

  const mime = resolveMime(asset, [asset.path ?? "", asset.src], media.mime);
  const bytes = Math.floor((media.base64.length * 3) / 4);

  if (mode === "single") {
    return { src: base64ToDataUrl(media.base64, mime), bytes };
  }

  // folder 模式：优先沿用原始扩展名，其次按 MIME 推断。
  const name = uniqueAssetName(asset, extensionForAsset(asset, mime), taken);
  return {
    src: `assets/${name}`,
    asset: { name, base64: media.base64, mime },
    bytes,
  };
}

interface InlineResult {
  project: Project;
  assets: HtmlExportAsset[];
  warnings: string[];
  totalBytes: number;
}

async function inlineProjectAssets(
  project: Project,
  options: HtmlExportOptions,
  warnings: string[],
): Promise<InlineResult> {
  const used = assetsUsedByProject(project);
  const nextAssets: Asset[] = [];
  const exported: HtmlExportAsset[] = [];
  const taken = new Set<string>();
  const total = Math.max(1, used.length);
  let inlinedBytes = 0;

  if (used.length === 0 && project.assets.length > 0) {
    warnings.push("工程里的素材没有被任何剪辑引用，导出页面不会包含它们。");
  }

  for (let i = 0; i < used.length; i += 1) {
    const asset = used[i];
    options.onProgress?.({
      ratio: 0.05 + (i / total) * 0.85,
      message: `正在处理素材 ${i + 1}/${used.length}：${asset.name || asset.id}`,
    });

    const inlined = await inlineOne(asset, options.mode, taken, warnings);
    if (inlined.asset) exported.push(inlined.asset);
    inlinedBytes += inlined.bytes;

    // 导出页面不需要本地磁盘路径：既泄露隐私，在浏览器里也毫无意义。
    const next: Asset = { ...asset, src: inlined.src };
    delete next.path;
    nextAssets.push(next);
  }

  // 未被引用的素材一并剔除，避免把整包素材都塞进网页。
  return {
    project: { ...project, assets: nextAssets },
    assets: exported,
    warnings,
    totalBytes: inlinedBytes,
  };
}

/* ------------------------------------------------------------------ *
 * 文档拼装
 * ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function documentTitle(project: Project, extra?: string): string {
  const name = project.name || "QookiV 宣传片";
  return extra ? `${extra} · ${name}` : name;
}

/** `<script>` 里内联 JSON 必须切断 `</script`，这里用 `<\/script` 兜底。 */
function safeScriptText(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1");
}

interface DocumentParts {
  projectJson: string;
  optionsJson: string;
  playerSource: string;
  title: string;
  warnings: string[];
}

function buildHtmlDocument(parts: DocumentParts): string {
  const title = escapeHtml(parts.title);
  const hasPlayer = parts.playerSource.trim().length > 0;

  const head = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    '  <meta name="color-scheme" content="dark" />',
    `  <title>${title}</title>`,
    "  <style>",
    "    html,body{margin:0;padding:0;height:100%;background:#0b0d12;}",
    "    body{overflow:hidden;}",
    "    #qookiv-root{width:100%;height:100%;min-height:100vh;background:#0b0d12;}",
    "    .qv-static{max-width:680px;margin:0 auto;padding:12vh 28px;color:#f3eee8;",
    '      font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.8;}',
    "    .qv-static h1{font-size:20px;margin:0 0 12px;color:#C97640;}",
    "    .qv-static p{margin:0 0 12px;color:rgba(243,238,232,.82);}",
    "    .qv-static code{padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.08);font-size:13px;}",
    "    .qv-static ul{padding-left:20px;color:rgba(243,238,232,.7);font-size:13px;}",
    "  </style>",
    "</head>",
    "<body>",
    '  <div id="qookiv-root"></div>',
  ].join("\n");

  const dataScript = [
    "  <script>",
    `    window.__QOOKIV_PROJECT__ = ${parts.projectJson};`,
    `    window.__QOOKIV_OPTIONS__ = ${parts.optionsJson};`,
    "  </script>",
  ].join("\n");

  const noscript = [
    "  <noscript>",
    '    <div class="qv-static">',
    `      <h1>${escapeHtml(parts.title)}</h1>`,
    "      <p>这个页面需要 JavaScript 才能播放：画面由播放器逐帧合成。</p>",
    "      <p>请在浏览器设置里启用 JavaScript 后刷新。</p>",
    "    </div>",
    "  </noscript>",
  ].join("\n");

  const warningList =
    parts.warnings.length > 0
      ? [
          '    <div class="qv-static">',
          "      <h1>导出提示</h1>",
          "      <ul>",
          ...parts.warnings.map((warning) => `        <li>${escapeHtml(warning)}</li>`),
          "      </ul>",
          "    </div>",
        ].join("\n")
      : "";

  const playerBlock = hasPlayer
    ? ["  <script>", safeScriptText(parts.playerSource), "  </script>"].join("\n")
    : [
        "  <script>",
        "    (function () {",
        "      var host = document.getElementById('qookiv-root') || document.body;",
        "      var box = document.createElement('div');",
        "      box.className = 'qv-static';",
        "      var heading = document.createElement('h1');",
        "      heading.textContent = document.title;",
        "      var line1 = document.createElement('p');",
        "      line1.textContent = '这个页面缺少播放器脚本，因此无法播放。';",
        "      var line2 = document.createElement('p');",
        "      line2.innerHTML = '请在 QookiV 里先执行 <code>pnpm build:player</code> 生成 <code>public/qookiv-player.js</code>，然后重新导出。';",
        "      var line3 = document.createElement('p');",
        "      line3.textContent = '下面是本页所包含的工程数据（可用于排查问题）：';",
        "      var pre = document.createElement('pre');",
        "      pre.style.cssText = 'max-height:40vh;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:12px;color:rgba(243,238,232,.6);';",
        "      pre.textContent = JSON.stringify(window.__QOOKIV_PROJECT__ || {}, null, 2);",
        "      box.appendChild(heading);",
        "      box.appendChild(line1);",
        "      box.appendChild(line2);",
        "      box.appendChild(line3);",
        "      box.appendChild(pre);",
        "      host.appendChild(box);",
        "    })();",
        "  </script>",
      ].join("\n");

  // 顺序很重要：工程数据 → <noscript> 兜底 → 播放器脚本 → 无脚本时的降级内容
  // → 导出告警。告警始终放在最后，既不遮挡画面，也不会漏掉。
  return [
    head,
    dataScript,
    noscript,
    playerBlock,
    hasPlayer ? "" : warningList,
    "</body>",
    "</html>",
    "",
  ]
    .filter((section) => section.length > 0)
    .join("\n");
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/** 拉取构建好的播放器脚本；失败返回 `null`。 */
async function loadPlayerSource(): Promise<string | null> {
  if (typeof fetch !== "function") return null;
  try {
    const response = await fetch(DEFAULT_PLAYER_URL);
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function exportStandaloneHtml(
  project: Project,
  options: HtmlExportOptions,
): Promise<HtmlExportBundle> {
  const warnings: string[] = [];
  const report = (ratio: number, message: string): void => {
    try {
      options.onProgress?.({ ratio: Math.max(0, Math.min(1, ratio)), message });
    } catch {
      // 进度回调是宿主的事，坏了也不该影响导出。
    }
  };

  report(0.02, "正在准备播放器脚本…");
  let playerSource = options.playerSource ?? "";
  if (!playerSource) {
    const fetched = await loadPlayerSource();
    if (fetched) playerSource = fetched;
    else {
      warnings.push(
        "未能加载播放器脚本（public/qookiv-player.js）。请先在工程根目录执行 " +
          '"pnpm build:player" 生成该文件，然后重新导出；当前页面只能显示工程数据，无法播放。',
      );
    }
  }

  const inlined = await inlineProjectAssets(project, options, warnings);
  report(0.9, "正在生成网页…");

  if (options.mode === "single" && inlined.totalBytes * 1.34 > LARGE_PAYLOAD_BYTES) {
    const mb = Math.round((inlined.totalBytes * 1.34) / (1024 * 1024));
    warnings.push(
      `内联素材总量约 ${mb} MB（base64 会再膨胀约 1/3），浏览器打开和拖动进度都可能会卡顿；` +
        '建议改用 "folder" 模式导出成 assets/ 目录。',
    );
  }
  if (playerSource) report(0.94, "正在内联播放器与项目数据…");

  const html = buildHtmlDocument({
    projectJson: serializeForScript(inlined.project),
    optionsJson: serializeForScript({
      autoplay: false,
      loop: false,
      accent: project.theme?.accent,
    }),
    playerSource,
    title: documentTitle(project, options.title),
    warnings,
  });

  report(1, "导出完成");

  return {
    html,
    assets: options.mode === "single" ? [] : inlined.assets,
    warnings: inlined.warnings,
  };
}
