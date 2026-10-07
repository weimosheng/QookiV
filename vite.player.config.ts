import { defineConfig } from "vite";

/**
 * 单页播放器的独立构建。
 *
 * 产物是一个自包含的 IIFE（`public/qookiv-player.js`），由 HTML 导出器内联进
 * 生成的 `index.html`，不依赖 React、不做代码分割、不引入编辑器代码：入口只
 * 触及 `src/player/**`、`src/render/**`、`src/core/**`。
 *
 * 对应脚本：`"build:player": "vite build --config vite.player.config.ts"`。
 */
export default defineConfig({
  // 播放器走 IIFE，不需要 React 插件，也不需要 public/ 之外的静态目录。
  publicDir: false,
  build: {
    target: "es2022",
    outDir: "public",
    // 关键：public/ 里还有品牌素材等文件，绝不能清空。
    emptyOutDir: false,
    // Vite 8 minifies with oxc; `"esbuild"` would require esbuild to be installed
    // separately, which it no longer is.
    minify: true,
    cssCodeSplit: false,
    sourcemap: false,
    // 播放器自己注入 <style>，不需要单独的 CSS 产物。
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    lib: {
      entry: "src/player/main.ts",
      name: "QookiVPlayer",
      formats: ["iife"],
      fileName: () => "qookiv-player.js",
    },
  },
});
