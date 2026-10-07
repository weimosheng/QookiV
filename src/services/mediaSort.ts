import type { Asset } from "../core/types";

/**
 * Media-pool ordering.
 *
 * Pure and separate from the panel so the ordering rules can be asserted
 * directly — "assets with unknown metadata sort last" is exactly the kind of
 * detail that silently regresses.
 */

export type SortMode = "recent" | "name" | "duration" | "size";

export const SORT_LABELS: Array<{ value: SortMode; label: string }> = [
  { value: "recent", label: "最近导入" },
  { value: "name", label: "按名称" },
  { value: "duration", label: "按时长" },
  { value: "size", label: "按大小" },
];

/**
 * Sorts a copy of `assets`.
 *
 * Missing metadata (`undefined` duration or byte size) always sorts last rather
 * than being treated as zero: an asset whose duration could not be probed is
 * unknown, not the shortest clip in the pool.
 */
export function sortAssets(assets: Asset[], mode: SortMode): Asset[] {
  const list = [...assets];
  switch (mode) {
    case "name":
      return list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    case "duration":
      return list.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1));
    case "size":
      return list.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
    case "recent":
    default:
      return list.sort((a, b) => b.addedAt - a.addedAt);
  }
}

/** Human-readable byte size; empty string when unknown. */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Case-insensitive match on name or source path. */
export function matchesQuery(asset: Asset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    asset.name.toLowerCase().includes(needle) ||
    (asset.path ?? "").toLowerCase().includes(needle)
  );
}
