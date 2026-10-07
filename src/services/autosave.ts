import { parseProject } from "../core/schema";
import type { Project } from "../core/types";
import { clearAutosaveFile, readAutosaveFile, writeAutosaveFile } from "./tauri";

/**
 * Crash recovery.
 *
 * The project is mirrored into `localStorage` while it has unsaved changes and
 * removed as soon as it is saved. That means the presence of an autosave *is*
 * the signal that a previous session ended with unsaved work — no timestamp
 * comparison or "was it clean?" heuristics needed.
 *
 * `localStorage` rather than a file in the app data directory: it survives a
 * crash, needs no extra Tauri command or capability, and works identically when
 * the UI is served in a plain browser.
 */

const KEY = "qookiv.autosave.v1";

/** Exposed so the storage format can be exercised directly in tests. */
export const AUTOSAVE_KEY = KEY;

export interface AutosaveRecord {
  /** Epoch milliseconds of the last write. */
  savedAt: number;
  /** The file the project was last saved to, if any. */
  filePath: string | null;
  project: Project;
}

/** Mirrors `project` into storage. Returns false when storage is unavailable. */
export function writeAutosave(project: Project, filePath: string | null): boolean {
  const record: AutosaveRecord = { savedAt: Date.now(), filePath, project };
  const json = JSON.stringify(record);
  // Disk mirror is best-effort and independent of the localStorage result, so a
  // full quota on the web side still leaves a recoverable copy on disk.
  void writeAutosaveFile(json);
  try {
    window.localStorage.setItem(KEY, json);
    return true;
  } catch {
    // Quota exceeded, storage disabled, or private mode: recovery is a safety
    // net, so failing to arm it must never break editing.
    return false;
  }
}

/**
 * Reads the pending autosave, if any.
 *
 * Runs the payload through `parseProject` so a truncated or hand-edited record
 * is repaired instead of throwing.
 */
export function readAutosave(): AutosaveRecord | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AutosaveRecord>;
    if (!parsed || typeof parsed.savedAt !== "number" || !parsed.project) return null;
    const { project } = parseProject(parsed.project);
    return {
      savedAt: parsed.savedAt,
      filePath: typeof parsed.filePath === "string" ? parsed.filePath : null,
      project,
    };
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: the record simply stays until the next successful write.
  }
  void clearAutosaveFile();
}

/**
 * Reads the on-disk mirror, used as a fallback when `localStorage` has been
 * cleared (cache wipe, a fresh webview instance) but the disk backup remains.
 */
export async function readAutosaveDisk(): Promise<AutosaveRecord | null> {
  const raw = await readAutosaveFile();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AutosaveRecord>;
    if (!parsed || typeof parsed.savedAt !== "number" || !parsed.project) return null;
    const { project } = parseProject(parsed.project);
    return {
      savedAt: parsed.savedAt,
      filePath: typeof parsed.filePath === "string" ? parsed.filePath : null,
      project,
    };
  } catch {
    return null;
  }
}

/** Clip count of a recovered project, used to skip empty/meaningless records. */
export function recoveryClipCount(project: Project): number {
  return project.tracks.reduce((total, track) => total + track.clips.length, 0);
}
