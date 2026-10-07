/**
 * 离线视频导出流水线（渲染 -> 编码 -> 封装 -> MP4 文件）。
 *
 * 典型用法：
 *
 * ```ts
 * const result = await exportVideo(project, mediaPool, {
 *   width: project.settings.width,
 *   height: project.settings.height,
 *   fps: project.settings.fps,
 *   includeAudio: true,
 *   onProgress: (p) => console.log(p.message, p.ratio),
 *   signal: controller.signal,
 * });
 * const url = URL.createObjectURL(result.blob);
 * ```
 *
 * 本模块只依赖 `src/core`、`src/render`、`src/engine` 中已有的公开接口，
 * 不做任何全局状态，也不会修改传入的 `project` / `media`。
 */

export * from "./capabilities";
export * from "./audio";
export * from "./exportVideo";
