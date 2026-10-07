import { readRecentFile, writeRecentFile } from "./tauri";

/**
 * Recently opened projects, mirrored to `localStorage` and an on-disk
 * `recent.json` — the same dual-store strategy as the autosave draft, so the
 * list survives a cache wipe as long as the app data directory is intact.
 */

const KEY = "qookiv.recent.v1";
const MAX = 24;

export interface RecentProject {
  /** Absolute path of the `.qookiv` file on disk. */
  path: string;
  name: string;
  /** Epoch milliseconds of the last save that produced this entry. */
  savedAt: number;
  templateId?: string;
  duration?: number;
  /** JPEG dataURL of a preview frame, ~320px wide. */
  thumbnail?: string;
}

function normalize(list: unknown): RecentProject[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: RecentProject[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Partial<RecentProject>;
    if (typeof r.path !== "string" || typeof r.name !== "string" || typeof r.savedAt !== "number") {
      continue;
    }
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push({
      path: r.path,
      name: r.name,
      savedAt: r.savedAt,
      templateId: typeof r.templateId === "string" ? r.templateId : undefined,
      duration: typeof r.duration === "number" ? r.duration : undefined,
      thumbnail: typeof r.thumbnail === "string" ? r.thumbnail : undefined,
    });
  }
  out.sort((a, b) => b.savedAt - a.savedAt);
  return out.slice(0, MAX);
}

function persist(list: RecentProject[]): void {
  const json = JSON.stringify(list);
  void writeRecentFile(json);
  try {
    window.localStorage.setItem(KEY, json);
  } catch {
    // Quota or disabled storage: the disk mirror still holds the list.
  }
}

/** Reads the list from `localStorage` (synchronous, primary). */
export function readRecent(): RecentProject[] {
  try {
    return normalize(JSON.parse(window.localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

/** Reads the list from the on-disk mirror (fallback when localStorage is empty). */
export async function readRecentDisk(): Promise<RecentProject[]> {
  const raw = await readRecentFile();
  if (!raw) return [];
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Adds or refreshes an entry. Same path → updated in place and bumped to the
 * top; the list is capped at {@link MAX}. Returns the new list and persists it.
 */
export function addRecent(entry: RecentProject): RecentProject[] {
  const existing = readRecent();
  const old = existing.find((r) => r.path === entry.path);
  const merged = old && !entry.thumbnail && old.thumbnail
    ? { ...entry, thumbnail: old.thumbnail }
    : entry;
  const next = existing.filter((r) => r.path !== entry.path);
  next.unshift(merged);
  const capped = next.slice(0, MAX);
  persist(capped);
  return capped;
}

/** Removes the entry for `path` (e.g. after a failed open or a user delete). */
export function removeRecent(path: string): RecentProject[] {
  const next = readRecent().filter((r) => r.path !== path);
  persist(next);
  return next;
}

/** Clears every entry from both stores. */
export function clearRecent(): void {
  persist([]);
}
