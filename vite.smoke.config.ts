import { defineConfig } from "vite";

/**
 * Builds the headless smoke test (`scripts/smoke.ts`) for Node.
 *
 * There is no browser available in this environment, so the engine is exercised
 * through a fake canvas instead. This config bundles the test plus the real
 * engine into one ES module that `node .scratch/smoke.js` can run.
 *
 * 产物名是 `.scratch/smoke.js`（**不是** `.mjs`）：es 格式的 lib 构建会按入口的
 * basename 命名产物，`fileName` 回调在这里并不生效——入口叫 `scripts/smoke.ts`，
 * 所以拿到 `smoke.js`。下面的 `fileName` 只是把这件事写明白，改它不影响产物名，
 * 而 `package.json` 里的 `"type": "module"` 保证 `.js` 仍是 ESM。
 */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    target: "node20",
    outDir: ".scratch",
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: "scripts/smoke.ts",
      formats: ["es"],
      fileName: () => "smoke.js",
    },
  },
});
