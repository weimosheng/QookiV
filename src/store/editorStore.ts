import { create } from "zustand";
import { clipEnd } from "../core/time";
import { newId } from "../core/ids";
import { createProject, createTrack, findClip, findClipRef, findTrack, normalizeProject } from "../core/project";
import { createAudioClip } from "../core/clips";
import { clampZoom } from "../core/zoom";
import { playback } from "../engine/PlaybackEngine";
import type {
  AnimationMap,
  Asset,
  Clip,
  FilterState,
  Keyframe,
  Project,
  SlotValue,
  Track,
  TrackKind,
  Transform,
} from "../core/types";
/**
 * Editor state.
 *
 * The project is the single source of truth and every mutation goes through
 * `commit`, which snapshots the previous value for undo. Playhead time is *not*
 * stored here — it lives in `PlaybackEngine` so a 60 Hz playhead never re-renders
 * the React shell.
 */

const HISTORY_LIMIT = 60;

export type LeftTab = "media" | "templates";
export type InspectorTab = "basic" | "motion" | "effects";

/** Explicit patch shape: `Partial<Clip>` collapses badly over a union. */
export interface ClipPatch {
  name?: string;
  start?: number;
  duration?: number;
  trimIn?: number;
  speed?: number;
  enabled?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: GlobalCompositeOperation;
  transform?: Partial<Transform>;
  filters?: Partial<FilterState>;
  props?: Record<string, unknown>;
  animation?: AnimationMap;
  transitionIn?: Clip["transitionIn"];
  transitionOut?: Clip["transitionOut"];
}

export type ClipUpdater = (clip: Clip) => Clip;

/**
 * A copied clip plus the track it came from.
 *
 * Remembering the source track is what lets a paste land back on the track the
 * user copied from instead of piling everything onto the active one.
 */
export interface ClipboardEntry {
  clip: Clip;
  trackId: string;
  trackKind: TrackKind;
}

/** Where a dragged asset would land, for the timeline's drop indicator. */
export interface DropHint {
  trackId: string;
  time: number;
  duration: number;
}

function dropUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function applyPatch(clip: Clip, patch: ClipPatch): Clip {
  const base = { ...clip, ...dropUndefined(patch) } as Clip;
  if (patch.transform) base.transform = { ...clip.transform, ...patch.transform };
  if (patch.filters) base.filters = { ...clip.filters, ...patch.filters };
  if (patch.props) {
    base.props = {
      ...(clip.props as unknown as Record<string, unknown>),
      ...patch.props,
    } as unknown as Clip["props"];
  }
  if (patch.animation !== undefined) base.animation = patch.animation;
  return base;
}

function mapClips(project: Project, ids: Set<string>, fn: (clip: Clip) => Clip): Project {
  let touched = false;
  const tracks = project.tracks.map((track) => {
    // A locked track is read-only: property edits, keyframes and speed changes
    // all flow through here, so this single guard keeps them off.
    if (track.locked) return track;
    if (!track.clips.some((c) => ids.has(c.id))) return track;
    touched = true;
    return {
      ...track,
      clips: track.clips.map((c) => (ids.has(c.id) ? fn(c) : c)),
    };
  });
  return touched ? { ...project, tracks } : project;
}

/**
 * Adds a track in the right section.
 *
 * Visual tracks go above the audio section rather than at the very end: the
 * timeline renders visual tracks first (reversed) and then audio, so appending a
 * layer track would otherwise make it appear *below* the audio rows and leave the
 * sections interleaved in the array.
 */
function insertTrack(tracks: Track[], track: Track): Track[] {
  if (track.kind === "audio") return [...tracks, track];
  const firstAudio = tracks.findIndex((t) => t.kind === "audio");
  if (firstAudio < 0) return [...tracks, track];
  const next = [...tracks];
  next.splice(firstAudio, 0, track);
  return next;
}

function withTimestamp(project: Project): Project {
  return { ...project, updatedAt: Date.now() };
}

/**
 * Merges overlapping time intervals so a ripple delete can measure "how much was
 * removed before this point" once, instead of shifting clip by clip (which would
 * double-count overlapping removals).
 */
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    const [from, to] = sorted[i];
    if (from <= last[1] + 1e-6) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

export interface EditorState {
  project: Project;
  selection: string[];
  activeTrackId: string | null;
  /** Timeline scale, in pixels per second. */
  zoom: number;
  leftTab: LeftTab;
  inspectorTab: InspectorTab;
  status: string | null;
  statusKind: "info" | "error" | "success";
  filePath: string | null;
  dirty: boolean;

  past: Project[];
  future: Project[];
  pendingSnapshot: Project | null;

  /* project lifecycle */
  newProject: (project?: Project) => void;
  loadProject: (project: Project, filePath?: string | null, warnings?: string[]) => void;
  renameProject: (name: string) => void;
  updateSettings: (patch: Partial<Project["settings"]>, opts?: { history?: boolean }) => void;
  markSaved: (filePath: string | null) => void;
  /**
   * Flags unsaved changes.
   *
   * Used after restoring an autosave: the restored project must count as dirty so
   * the recovery net re-arms immediately if the app dies again before a save.
   */
  markDirty: () => void;

  /* history */
  commit: (recipe: (project: Project) => Project, opts?: { history?: boolean }) => void;
  beginHistory: () => void;
  endHistory: () => void;
  undo: () => void;
  redo: () => void;

  /* selection */
  select: (ids: string[], mode?: "replace" | "add" | "toggle") => void;
  clearSelection: () => void;
  setActiveTrack: (trackId: string | null) => void;
  /** Every clip on an unlocked, visible track. */
  selectAll: () => void;

  /* clipboard */
  clipboard: ClipboardEntry[] | null;
  copySelection: () => void;
  cutSelection: () => void;
  /** Pastes at the playhead, or at `atTime`, keeping relative spacing. */
  pasteClipboard: (atTime?: number) => void;

  /* asset drag (media pool -> timeline) */
  dragAsset: Asset | null;
  setDragAsset: (asset: Asset | null) => void;
  dropHint: DropHint | null;
  setDropHint: (hint: DropHint | null) => void;

  /* assets */
  addAssets: (assets: Asset[]) => void;
  removeAsset: (assetId: string) => void;
  renameAsset: (assetId: string, name: string) => void;
  /**
   * Re-points an asset at a different file.
   *
   * Keeps the asset id, which is the whole point: every clip on the timeline
   * references assets by id, so relinking repairs the project in place instead of
   * forcing the user to rebuild their edit.
   */
  relinkAsset: (
    assetId: string,
    patch: {
      path: string;
      src: string;
      name?: string;
      duration?: number;
      width?: number;
      height?: number;
      hasAudio?: boolean;
      bytes?: number;
    },
  ) => void;

  /* clips */
  addClip: (trackId: string, clip: Clip) => void;
  /**
   * 一次插入若干片段（可顺带登记刚导入的素材），整批只占一步撤销。
   *
   * 从系统拖入多个文件时用它：`addClip` + `addAssets` 分开调用会留下两步撤销，
   * 而用户眼里那就是"一次拖放"。
   */
  addClips: (entries: Array<{ trackId: string; clip: Clip }>, assets?: Asset[]) => void;
  /**
   * 把片段复制到指定位置（Alt + 拖动用）。
   *
   * 与 `duplicateClips` 的区别是**不**把副本排在原件后面，而是插在给定的轨道与时刻——
   * 拖动结束后原件已经移走了，要补回它原来待的地方，靠的就是调用方在拖动开始时记下的
   * 位置。返回新建片段的 id。
   */
  copyClipsAt: (
    placements: Array<{ clipId: string; trackId: string; start: number }>,
    opts?: { history?: boolean },
  ) => string[];
  updateClip: (id: string, patch: ClipPatch | ClipUpdater, opts?: { history?: boolean }) => void;
  updateClips: (
    ids: string[],
    patch: ClipPatch | ClipUpdater,
    opts?: { history?: boolean },
  ) => void;
  deleteClips: (ids: string[]) => void;
  /** Deletes clips and slides later clips on the same track left to close the hole. */
  rippleDelete: (ids: string[]) => void;
  /** Packs a track's clips back to back from time 0. */
  closeGaps: (trackId: string) => void;
  renameTrack: (trackId: string, name: string) => void;
  duplicateClips: (ids: string[]) => void;
  splitAt: (time: number) => void;
  /**
   * Moves a video clip's embedded audio onto its own audio track.
   *
   * The picture clip keeps its position and trim but is muted, so the sound is
   * heard once rather than twice. The new audio clip takes the same source, trim
   * and speed, and carries the volume keyframes with it so fades survive.
   */
  detachAudio: (clipId: string) => void;
  moveClips: (ids: string[], deltaTime: number, targetTrackId?: string) => void;
  /**
   * Sets clips to absolute positions, optionally moving them between tracks.
   *
   * Dragging must use this rather than repeated `moveClips` calls: a drag is a
   * series of absolute targets, and applying incremental deltas to an
   * already-moved clip would compound the offset.
   */
  placeClips: (
    placements: Array<{ clipId: string; trackId: string; start: number }>,
    opts?: { history?: boolean },
  ) => void;
  setClipSpeed: (id: string, speed: number) => void;

  /* keyframes */
  setKeyframes: (
    clipId: string,
    path: string,
    frames: Keyframe[],
    opts?: { history?: boolean },
  ) => void;
  /**
   * Moves every keyframe sitting at `fromTime` to `toTime`, across all properties.
   *
   * The timeline draws one merged row of keyframe diamonds per clip, so dragging a
   * diamond means "move this moment" — every property's keyframe at that instant
   * travels together, which is also what makes the gesture predictable.
   */
  moveKeyframesAt: (
    clipId: string,
    fromTime: number,
    toTime: number,
    opts?: { history?: boolean },
  ) => void;
  toggleKeyframe: (clipId: string, path: string, localTime: number, value: number | string) => void;
  clearAnimation: (clipId: string, path?: string) => void;

  /* tracks */
  addTrack: (kind: TrackKind) => void;
  removeTrack: (trackId: string) => void;
  updateTrack: (trackId: string, patch: Partial<Omit<Track, "id" | "clips">>) => void;
  /**
   * Moves a track one slot in paint order.
   *
   * `up` moves it later in the array, i.e. painted on top of its neighbours — the
   * order the timeline shows. Only swaps with a track of the same kind so the
   * audio and visual sections never interleave.
   */
  moveTrack: (trackId: string, direction: "up" | "down") => void;
  duplicateTrack: (trackId: string) => void;
  clearTrack: (trackId: string) => void;

  /* templates */
  applyTemplateProject: (
    project: Project,
    templateId: string,
    values: Record<string, SlotValue>,
  ) => void;
  setSlot: (
    slotId: string,
    value: SlotValue,
    rebuild: (p: Project) => Project,
    opts?: { history?: boolean },
  ) => void;

  /* ui */
  /** Bumped whenever the timeline should re-fit its zoom to the whole project. */
  fitRequest: number;
  requestFit: () => void;
  setZoom: (zoom: number) => void;
  setLeftTab: (tab: LeftTab) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  setStatus: (message: string | null, kind?: "info" | "error" | "success") => void;
}

export const useEditor = create<EditorState>()((set, get) => {
  /** Pushes the current project onto the undo stack and installs `next`. */
  const install = (next: Project, history = true): void => {
    const state = get();
    const normalized = normalizeProject(withTimestamp(next));
    if (normalized === state.project) return;

    // Drop selections that point at clips which no longer exist.
    const alive = new Set<string>();
    for (const track of normalized.tracks) for (const c of track.clips) alive.add(c.id);
    const selection = state.selection.filter((id) => alive.has(id));

    playback.setDuration(normalized);

    set({
      project: normalized,
      selection,
      activeTrackId:
        state.activeTrackId && normalized.tracks.some((t) => t.id === state.activeTrackId)
          ? state.activeTrackId
          : (normalized.tracks[0]?.id ?? null),
      past: history ? [...state.past, state.project].slice(-HISTORY_LIMIT) : state.past,
      future: history ? [] : state.future,
      dirty: true,
    });
  };

  return {
    project: createProject(),
    selection: [],
    clipboard: null,
    dragAsset: null,
    dropHint: null,
    activeTrackId: null,
    zoom: 60,
    leftTab: "media",
    inspectorTab: "basic",
    status: null,
    statusKind: "info",
    filePath: null,
    dirty: false,
    fitRequest: 0,

    past: [],
    future: [],
    pendingSnapshot: null,

    /* ---------------------------------------------------------------- *
     * Project lifecycle
     * ---------------------------------------------------------------- */

    newProject: (project) => {
      const next = project ?? createProject();
      playback.setDuration(next);
      playback.seek(0);
      set({
        project: next,
        selection: [],
        activeTrackId: next.tracks[0]?.id ?? null,
        past: [],
        future: [],
        pendingSnapshot: null,
        filePath: null,
        dirty: false,
        fitRequest: get().fitRequest + 1,
        status: "已新建工程",
        statusKind: "success",
      });
    },

    loadProject: (project, filePath = null, warnings = []) => {
      playback.setDuration(project);
      playback.seek(0);
      set({
        project,
        selection: [],
        activeTrackId: project.tracks[0]?.id ?? null,
        past: [],
        future: [],
        pendingSnapshot: null,
        filePath,
        dirty: false,
        fitRequest: get().fitRequest + 1,
        status:
          warnings.length > 0 ? warnings.join("；") : `已打开「${project.name}」`,
        statusKind: warnings.length > 0 ? "error" : "success",
      });
    },

    renameProject: (name) => {
      get().commit((p) => ({ ...p, name }));
    },

    updateSettings: (patch, opts) => {
      get().commit((p) => ({ ...p, settings: { ...p.settings, ...patch } }), opts);
    },

    markSaved: (filePath) => set({ filePath, dirty: false }),

    markDirty: () => {
      if (!get().dirty) set({ dirty: true });
    },

    /* ---------------------------------------------------------------- *
     * History
     * ---------------------------------------------------------------- */

    commit: (recipe, opts) => {
      const state = get();
      const next = recipe(state.project);
      if (next === state.project) return;
      install(next, opts?.history ?? true);
    },

    beginHistory: () => {
      if (get().pendingSnapshot) return;
      set({ pendingSnapshot: get().project });
    },

    endHistory: () => {
      const { pendingSnapshot, project, past } = get();
      if (!pendingSnapshot) return;
      if (pendingSnapshot === project) {
        set({ pendingSnapshot: null });
        return;
      }
      set({
        past: [...past, pendingSnapshot].slice(-HISTORY_LIMIT),
        future: [],
        pendingSnapshot: null,
      });
    },

    undo: () => {
      const { past, project, future, selection, activeTrackId } = get();
      if (past.length === 0) return;
      const previous = past[past.length - 1];
      playback.setDuration(previous);
      // Selection and active track may point at clips/tracks that no longer
      // exist in the restored project (e.g. after undoing a split, the right
      // half's id is stale). Mirror `install`'s cleanup so the inspector never
      // sees a dangling id.
      const alive = new Set<string>();
      for (const track of previous.tracks) for (const c of track.clips) alive.add(c.id);
      set({
        project: previous,
        past: past.slice(0, -1),
        future: [project, ...future].slice(0, HISTORY_LIMIT),
        selection: selection.filter((id) => alive.has(id)),
        activeTrackId:
          activeTrackId && previous.tracks.some((t) => t.id === activeTrackId)
            ? activeTrackId
            : (previous.tracks[0]?.id ?? null),
        dirty: true,
      });
    },

    redo: () => {
      const { future, project, past, selection, activeTrackId } = get();
      if (future.length === 0) return;
      const next = future[0];
      playback.setDuration(next);
      const alive = new Set<string>();
      for (const track of next.tracks) for (const c of track.clips) alive.add(c.id);
      set({
        project: next,
        past: [...past, project].slice(-HISTORY_LIMIT),
        future: future.slice(1),
        selection: selection.filter((id) => alive.has(id)),
        activeTrackId:
          activeTrackId && next.tracks.some((t) => t.id === activeTrackId)
            ? activeTrackId
            : (next.tracks[0]?.id ?? null),
        dirty: true,
      });
    },

    /* ---------------------------------------------------------------- *
     * Selection
     * ---------------------------------------------------------------- */

    select: (ids, mode = "replace") => {
      const current = get().selection;
      let next: string[];
      if (mode === "replace") next = ids;
      else if (mode === "add") next = Array.from(new Set([...current, ...ids]));
      else {
        const set0 = new Set(current);
        for (const id of ids) {
          if (set0.has(id)) set0.delete(id);
          else set0.add(id);
        }
        next = Array.from(set0);
      }
      set({ selection: next });
    },

    clearSelection: () => set({ selection: [] }),

    setActiveTrack: (trackId) => set({ activeTrackId: trackId }),

    selectAll: () => {
      const { project } = get();
      const ids: string[] = [];
      for (const track of project.tracks) {
        if (track.locked || track.hidden) continue;
        for (const clip of track.clips) ids.push(clip.id);
      }
      set({ selection: ids });
    },

    /* ---------------------------------------------------------------- *
     * Clipboard
     * ---------------------------------------------------------------- */

    copySelection: () => {
      const state = get();
      if (state.selection.length === 0) return;
      const wanted = new Set(state.selection);
      const entries: ClipboardEntry[] = [];
      for (const track of state.project.tracks) {
        for (const clip of track.clips) {
          if (!wanted.has(clip.id)) continue;
          // Deep clone so later edits to the original cannot mutate the clipboard.
          entries.push({
            clip: JSON.parse(JSON.stringify(clip)) as Clip,
            trackId: track.id,
            trackKind: track.kind,
          });
        }
      }
      if (entries.length === 0) return;
      set({
        clipboard: entries,
        status: `已复制 ${entries.length} 个片段`,
        statusKind: "success",
      });
    },

    cutSelection: () => {
      const state = get();
      if (state.selection.length === 0) return;
      state.copySelection();
      const wanted = new Set(state.selection);
      let cutCount = 0;
      get().commit((p) => {
        let touched = false;
        const tracks = p.tracks.map((t) => {
          if (t.locked) return t;
          const matching = t.clips.filter((c) => wanted.has(c.id));
          if (matching.length === 0) return t;
          touched = true;
          cutCount += matching.length;
          return { ...t, clips: t.clips.filter((c) => !wanted.has(c.id)) };
        });
        return touched ? { ...p, tracks } : p;
      });
      if (cutCount > 0) {
        set({ selection: [], status: `已剪切 ${cutCount} 个片段`, statusKind: "success" });
      } else {
        set({ status: "选中片段均在锁定轨道，未剪切", statusKind: "error" });
      }
    },

    pasteClipboard: (atTime) => {
      const state = get();
      const clipboard = state.clipboard;
      if (!clipboard || clipboard.length === 0) return;

      const base = Math.min(...clipboard.map((e) => e.clip.start));
      const target = atTime ?? playback.time;
      const offset = target - base;
      const created: string[] = [];

      get().commit((p) => {
        let tracks: Track[] = p.tracks.map((t) => ({ ...t, clips: [...t.clips] }));

        for (const entry of clipboard) {
          // Prefer the original track; otherwise the first compatible unlocked
          // track; otherwise make one, so a paste can never silently drop clips.
          let destination =
            tracks.find((t) => t.id === entry.trackId && !t.locked) ??
            tracks.find((t) => t.kind === entry.trackKind && !t.locked);

          if (!destination) {
            const fresh = createTrack(entry.trackKind);
            tracks = insertTrack(tracks, fresh);
            destination = fresh;
          }

          const copy: Clip = {
            ...(JSON.parse(JSON.stringify(entry.clip)) as Clip),
            id: newId("clip"),
            start: Math.max(0, entry.clip.start + offset),
          };
          created.push(copy.id);
          const destinationId = destination.id;
          tracks = tracks.map((t) =>
            t.id === destinationId ? { ...t, clips: [...t.clips, copy] } : t,
          );
        }

        return { ...p, tracks };
      });

      if (created.length > 0) {
        set({ selection: created, status: `已粘贴 ${created.length} 个片段`, statusKind: "success" });
      }
    },

    setDragAsset: (asset) => set({ dragAsset: asset, dropHint: asset ? get().dropHint : null }),
    setDropHint: (hint) => set({ dropHint: hint }),

    /* ---------------------------------------------------------------- *
     * Assets
     * ---------------------------------------------------------------- */

    addAssets: (assets) => {
      if (assets.length === 0) return;
      get().commit((p) => ({ ...p, assets: [...p.assets, ...assets] }));
      set({ status: `已导入 ${assets.length} 个素材`, statusKind: "success" });
    },

    removeAsset: (assetId) => {
      get().commit((p) => ({ ...p, assets: p.assets.filter((a) => a.id !== assetId) }));
    },

    renameAsset: (assetId, name) => {
      get().commit((p) => ({
        ...p,
        assets: p.assets.map((a) => (a.id === assetId ? { ...a, name } : a)),
      }));
    },

    relinkAsset: (assetId, patch) => {
      const target = get().project.assets.find((a) => a.id === assetId);
      get().commit((p) => ({
        ...p,
        assets: p.assets.map((a) => (a.id === assetId ? { ...a, ...patch } : a)),
      }));
      set({
        status: `已重新链接「${target?.name ?? assetId}」`,
        statusKind: "success",
      });
    },

    /* ---------------------------------------------------------------- *
     * Clips
     * ---------------------------------------------------------------- */

    addClip: (trackId, clip) => {
      const project = get().project;
      const track = findTrack(project, trackId);
      if (!track || track.locked) return;
      get().commit((p) => ({
        ...p,
        tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip] } : t)),
      }));
      set({ selection: [clip.id], activeTrackId: track.id });
    },

    addClips: (entries, assets = []) => {
      if (entries.length === 0 && assets.length === 0) return;
      const added: { id: string; trackId: string }[] = [];
      get().commit((p) => {
        const byTrack = new Map<string, Clip[]>();
        for (const entry of entries) {
          const track = p.tracks.find((t) => t.id === entry.trackId);
          if (!track || track.locked) continue;
          const list = byTrack.get(entry.trackId) ?? [];
          list.push(entry.clip);
          byTrack.set(entry.trackId, list);
          added.push({ id: entry.clip.id, trackId: entry.trackId });
        }
        const known = new Set(p.assets.map((a) => a.id));
        const fresh = assets.filter((a) => !known.has(a.id));
        if (byTrack.size === 0 && fresh.length === 0) return p;
        return {
          ...p,
          assets: fresh.length > 0 ? [...p.assets, ...fresh] : p.assets,
          tracks: p.tracks.map((t) => {
            const extra = byTrack.get(t.id);
            return extra ? { ...t, clips: [...t.clips, ...extra] } : t;
          }),
        };
      });
      if (added.length > 0) set({ selection: added.map((a) => a.id), activeTrackId: added[0].trackId });
    },

    copyClipsAt: (placements, opts) => {
      const created: string[] = [];
      get().commit((p) => {
        const additions = new Map<string, Clip[]>();
        for (const place of placements) {
          const source = findClip(p, place.clipId);
          const track = findTrack(p, place.trackId);
          if (!source || !track || track.locked) continue;
          const copy: Clip = {
            ...source,
            id: newId("clip"),
            start: Math.max(0, place.start),
            // 动画必须深拷贝：共享同一个数组的话，之后调副本的曲线会连原件一起改。
            animation: JSON.parse(JSON.stringify(source.animation)) as AnimationMap,
          };
          created.push(copy.id);
          const list = additions.get(track.id) ?? [];
          list.push(copy);
          additions.set(track.id, list);
        }
        if (additions.size === 0) return p;
        return {
          ...p,
          tracks: p.tracks.map((t) => {
            const extra = additions.get(t.id);
            return extra ? { ...t, clips: [...t.clips, ...extra] } : t;
          }),
        };
      }, opts);
      return created;
    },

    updateClip: (id, patch, opts) => {
      get().commit(
        (p) =>
          mapClips(p, new Set([id]), (c) =>
            typeof patch === "function" ? patch(c) : applyPatch(c, patch),
          ),
        opts,
      );
    },

    updateClips: (ids, patch, opts) => {
      const idSet = new Set(ids);
      get().commit(
        (p) =>
          mapClips(p, idSet, (c) =>
            typeof patch === "function" ? patch(c) : applyPatch(c, patch),
          ),
        opts,
      );
    },

    deleteClips: (ids) => {
      const idSet = new Set(ids);
      get().commit((p) => {
        let touched = false;
        const tracks = p.tracks.map((t) => {
          if (t.locked || !t.clips.some((c) => idSet.has(c.id))) return t;
          touched = true;
          return { ...t, clips: t.clips.filter((c) => !idSet.has(c.id)) };
        });
        return touched ? { ...p, tracks } : p;
      });
      set({ selection: get().selection.filter((id) => !idSet.has(id)) });
    },

    rippleDelete: (ids) => {
      const idSet = new Set(ids);
      get().commit((p) => {
        let touched = false;
        const tracks = p.tracks.map((track) => {
          if (track.locked) return track;
          const removed = track.clips.filter((c) => idSet.has(c.id));
          if (removed.length === 0) return track;
          touched = true;
          const intervals = mergeIntervals(
            removed.map((c) => [c.start, c.start + c.duration] as [number, number]),
          );
          const kept = track.clips
            .filter((c) => !idSet.has(c.id))
            .map((clip) => {
              // Only time before this clip's start matters, so clips that merely
              // overlap a removed range are not dragged around.
              let shift = 0;
              for (const [from, to] of intervals) {
                if (to <= clip.start + 1e-6) shift += to - from;
              }
              return shift === 0 ? clip : { ...clip, start: Math.max(0, clip.start - shift) };
            });
          return { ...track, clips: kept };
        });
        return touched ? { ...p, tracks } : p;
      });
      set({ selection: get().selection.filter((id) => !idSet.has(id)) });
    },

    closeGaps: (trackId) => {
      get().commit((p) => {
        const track = p.tracks.find((t) => t.id === trackId);
        // A locked track must not be reshuffled, and a missing track is a no-op
        // so the undo stack stays clean.
        if (!track || track.locked) return p;
        let cursor = 0;
        const packed = [...track.clips]
          .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
          .map((clip) => {
            const next = { ...clip, start: cursor };
            cursor += clip.duration;
            return next;
          });
        return {
          ...p,
          tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, clips: packed } : t)),
        };
      });
    },

    renameTrack: (trackId, name) => {
      get().commit((p) => ({
        ...p,
        tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, name } : t)),
      }));
    },

    duplicateClips: (ids) => {
      const idSet = new Set(ids);
      const created: string[] = [];
      get().commit((p) => {
        let touched = false;
        const tracks = p.tracks.map((track) => {
          if (track.locked) return track;
          const copies: Clip[] = [];
          for (const clip of track.clips) {
            if (!idSet.has(clip.id)) continue;
            const copy: Clip = {
              ...clip,
              id: newId("clip"),
              name: `${clip.name} 副本`,
              // Land the copy immediately after the original.
              start: clipEnd(clip),
              animation: JSON.parse(JSON.stringify(clip.animation)) as AnimationMap,
            };
            created.push(copy.id);
            copies.push(copy);
          }
          if (copies.length === 0) return track;
          touched = true;
          return { ...track, clips: [...track.clips, ...copies] };
        });
        return touched ? { ...p, tracks } : p;
      });
      if (created.length > 0) set({ selection: created });
    },

    detachAudio: (clipId) => {
      const project = get().project;
      const clip = findClip(project, clipId);
      const ref = findClipRef(project, clipId);
      if (!clip || !ref || clip.kind !== "video") return;
      const trackId = ref.trackId;

      const assetId = clip.props.assetId;
      if (!assetId) {
        set({ status: `「${clip.name}」没有关联素材，无法分离音频`, statusKind: "error" });
        return;
      }
      const asset = project.assets.find((a) => a.id === assetId);
      if (asset?.hasAudio === false) {
        set({ status: `「${clip.name}」的源文件没有音轨，无需分离`, statusKind: "error" });
        return;
      }

      const audio = createAudioClip({
        assetId,
        name: `${clip.name} · 音频`,
        start: clip.start,
        duration: clip.duration,
        props: { volume: clip.props.volume, muted: false, fit: "none" },
      });
      // `ClipInit` has no trim/speed, and the detached sound must line up with
      // the picture it came from.
      audio.trimIn = clip.trimIn;
      audio.speed = clip.speed;

      // A fade belongs to the sound, so the keyframes travel with it.
      const volumeFrames = clip.animation["props.volume"];
      if (volumeFrames && volumeFrames.length > 0) {
        audio.animation = { "props.volume": volumeFrames.map((frame) => ({ ...frame })) };
      }

      let newTrackId: string | null = null;
      get().commit((p) => {
        // Muted in place: the union widens under a plain spread, so the result is
        // pinned back to `Clip` explicitly.
        const muteClip = (c: Clip): Clip =>
          c.id === clipId ? ({ ...c, props: { ...c.props, muted: true } } as Clip) : c;
        const muted: Track[] = p.tracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map(muteClip) } : t,
        );

        const audioTrack = muted.find((t) => t.kind === "audio" && !t.locked);
        if (audioTrack) {
          return {
            ...p,
            tracks: muted.map((t) =>
              t.id === audioTrack.id ? { ...t, clips: [...t.clips, audio] } : t,
            ),
          };
        }
        // No audio track yet (a template project may have none).
        const fresh = createTrack("audio", "音频");
        fresh.clips = [audio];
        newTrackId = fresh.id;
        return { ...p, tracks: insertTrack(muted, fresh) };
      });

      const after = get().project.tracks.find((t) => t.clips.some((c) => c.id === audio.id));
      set({
        selection: [audio.id],
        activeTrackId: newTrackId ?? after?.id ?? get().activeTrackId,
        status: `已分离「${clip.name}」的音频，画面已静音；声音现在是独立片段，可单独移动或删除`,
        statusKind: "success",
      });
    },

    splitAt: (time) => {
      const state = get();
      const idSet = new Set(state.selection);
      const created: string[] = [];
      let didSplit = false;

      get().commit((p) => {
        const tracks = p.tracks.map((track) => {
          if (track.locked) return track;
          let trackSplit = false;
          const next: Clip[] = [];
          for (const clip of track.clips) {
            const eligible =
              time > clip.start + 1e-4 &&
              time < clipEnd(clip) - 1e-4 &&
              (idSet.size === 0 || idSet.has(clip.id));
            if (!eligible) {
              next.push(clip);
              continue;
            }
            trackSplit = true;
            didSplit = true;
            const leftDuration = time - clip.start;
            const rightDuration = clip.duration - leftDuration;

            const left: Clip = {
              ...clip,
              duration: leftDuration,
              transitionOut: undefined,
            };
            // Keyframes are clip-local, so the right half's curve is rebased.
            const rebased: AnimationMap = {};
            for (const [path, frames] of Object.entries(clip.animation)) {
              rebased[path] = frames.map((f) => ({ ...f, time: f.time - leftDuration }));
            }
            const right: Clip = {
              ...clip,
              id: newId("clip"),
              name: clip.name,
              start: time,
              duration: rightDuration,
              trimIn: clip.trimIn + leftDuration * clip.speed,
              transitionIn: undefined,
              animation: rebased,
            };
            created.push(right.id);
            next.push(left, right);
          }
          return trackSplit ? { ...track, clips: next } : track;
        });
        // No clip was split: return the original project so `commit` no-ops
        // instead of pushing an empty entry onto the undo stack.
        return didSplit ? { ...p, tracks } : p;
      });

      if (didSplit) {
        set({ status: `已在 ${time.toFixed(2)}s 处分割`, statusKind: "success" });
        if (created.length > 0) get().select(created, "add");
      } else {
        set({ status: "播放头位置没有可分割的片段", statusKind: "error" });
      }
    },

    moveClips: (ids, deltaTime, targetTrackId) => {
      const idSet = new Set(ids);
      get().commit(
        (p) => {
          // Pull the clips out first when they are changing track.
          if (targetTrackId) {
            const dest = p.tracks.find((t) => t.id === targetTrackId);
            // A locked destination refuses the drop, and locked source clips
            // stay put — otherwise dragging could smuggle clips out of a track
            // the user just froze.
            if (!dest || dest.locked) return p;
            const moving: Clip[] = [];
            for (const track of p.tracks) {
              if (track.locked) continue;
              for (const clip of track.clips) if (idSet.has(clip.id)) moving.push(clip);
            }
            if (moving.length === 0) return p;
            const stripped = p.tracks.map((t) => ({
              ...t,
              clips: t.clips.filter((c) => !idSet.has(c.id)),
            }));
            return {
              ...p,
              tracks: stripped.map((t) =>
                t.id === targetTrackId
                  ? {
                      ...t,
                      clips: [
                        ...t.clips,
                        ...moving.map((c) => ({
                          ...c,
                          start: Math.max(0, c.start + deltaTime),
                        })),
                      ],
                    }
                  : t,
              ),
            };
          }
          let touched = false;
          const tracks = p.tracks.map((t) => {
            if (t.locked || !t.clips.some((c) => idSet.has(c.id))) return t;
            touched = true;
            return {
              ...t,
              clips: t.clips.map((c) =>
                idSet.has(c.id) ? { ...c, start: Math.max(0, c.start + deltaTime) } : c,
              ),
            };
          });
          return touched ? { ...p, tracks } : p;
        },
        { history: false },
      );
    },

    placeClips: (placements, opts) => {
      if (placements.length === 0) return;
      get().commit(
        (p) => {
          // A locked track is frozen in both directions: its clips cannot be
          // dragged out, and nothing can be dropped in. Placements that touch
          // a locked track at either end are skipped, leaving those clips put.
          const valid = placements.filter((pl) => {
            const dest = p.tracks.find((t) => t.id === pl.trackId);
            if (!dest || dest.locked) return false;
            const src = p.tracks.find((t) => t.clips.some((c) => c.id === pl.clipId));
            return src != null && !src.locked;
          });
          if (valid.length === 0) return p;
          const validIds = new Set(valid.map((pl) => pl.clipId));
          const detached = new Map<string, Clip>();
          for (const track of p.tracks) {
            for (const clip of track.clips) {
              if (validIds.has(clip.id)) detached.set(clip.id, clip);
            }
          }
          const tracks = p.tracks.map((track) => ({
            ...track,
            clips: track.clips.filter((c) => !validIds.has(c.id)),
          }));
          for (const placement of valid) {
            const clip = detached.get(placement.clipId);
            if (!clip) continue;
            const track = tracks.find((t) => t.id === placement.trackId);
            if (!track) continue;
            track.clips.push({ ...clip, start: Math.max(0, placement.start) });
          }
          return { ...p, tracks };
        },
        opts,
      );
    },

    setClipSpeed: (id, speed) => {
      const safe = Math.max(0.05, Math.min(8, speed));
      get().commit((p) =>
        mapClips(p, new Set([id]), (c) => {
          // Keep the same source range visible: duration scales inversely.
          const sourceSpan = c.duration * c.speed;
          return { ...c, speed: safe, duration: Math.max(1 / 120, sourceSpan / safe) };
        }),
      );
    },

    /* ---------------------------------------------------------------- *
     * Keyframes
     * ---------------------------------------------------------------- */

    setKeyframes: (clipId, path, frames, opts) => {
      get().commit(
        (p) =>
          mapClips(p, new Set([clipId]), (c) => {
            const sorted = [...frames].sort((a, b) => a.time - b.time);
            const animation = { ...c.animation };
            if (sorted.length === 0) delete animation[path];
            else animation[path] = sorted;
            return { ...c, animation };
          }),
        opts,
      );
    },

    moveKeyframesAt: (clipId, fromTime, toTime, opts) => {
      // A touched keyframe keeps its exact stored time, so a tight tolerance is
      // enough and avoids dragging an unrelated neighbour along.
      const tolerance = 1e-4;
      get().commit(
        (p) =>
          mapClips(p, new Set([clipId]), (c) => {
            const animation: AnimationMap = {};
            let moved = false;
            for (const [path, frames] of Object.entries(c.animation)) {
              const next = frames.map((frame) => {
                if (Math.abs(frame.time - fromTime) > tolerance) return frame;
                moved = true;
                return { ...frame, time: toTime };
              });
              // Sampling walks the list in time order, so it must stay sorted.
              animation[path] = next.sort((a, b) => a.time - b.time);
            }
            return moved ? { ...c, animation } : c;
          }),
        opts,
      );
    },

    toggleKeyframe: (clipId, path, localTime, value) => {
      get().commit((p) =>
        mapClips(p, new Set([clipId]), (c) => {
          const existing = c.animation[path] ?? [];
          const tol = 1 / 30;
          const hitIndex = existing.findIndex((f) => Math.abs(f.time - localTime) <= tol);
          const animation = { ...c.animation };
          if (hitIndex >= 0) {
            const next = existing.filter((_, i) => i !== hitIndex);
            if (next.length === 0) delete animation[path];
            else animation[path] = next;
          } else {
            const frame: Keyframe = { time: localTime, value, easing: "easeInOutCubic" };
            animation[path] = [...existing, frame].sort((a, b) => a.time - b.time);
          }
          return { ...c, animation };
        }),
      );
    },

    clearAnimation: (clipId, path) => {
      get().commit((p) =>
        mapClips(p, new Set([clipId]), (c) => {
          if (!path) return { ...c, animation: {} };
          const animation = { ...c.animation };
          delete animation[path];
          return { ...c, animation };
        }),
      );
    },

    /* ---------------------------------------------------------------- *
     * Tracks
     * ---------------------------------------------------------------- */

    addTrack: (kind) => {
      const track = createTrack(kind);
      get().commit((p) => ({ ...p, tracks: insertTrack(p.tracks, track) }));
      set({ activeTrackId: track.id });
    },

    removeTrack: (trackId) => {
      get().commit((p) => {
        // Keep at least one track so the timeline never collapses to nothing —
        // an empty project has nowhere to drop clips and no track to activate.
        if (p.tracks.length <= 1) return p;
        return { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) };
      });
    },

    updateTrack: (trackId, patch) => {
      get().commit((p) => ({
        ...p,
        tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)),
      }));
      // 锁定或隐藏轨道时清理该轨道选区：锁定后编辑会被 store 拒绝、隐藏后预览看不到，
      // 两种情况下 Inspector 拥留选中都会让用户困惑。
      if (patch.locked || patch.hidden) {
        const clipIds = new Set(
          get().project.tracks.find((t) => t.id === trackId)?.clips.map((c) => c.id) ?? [],
        );
        if (clipIds.size > 0) {
          set({ selection: get().selection.filter((id) => !clipIds.has(id)) });
        }
      }
    },

    moveTrack: (trackId, direction) => {
      get().commit((p) => {
        const index = p.tracks.findIndex((t) => t.id === trackId);
        if (index < 0) return p;
        const kind = p.tracks[index].kind;

        // Reorder within the track's own kind by swapping the two tracks' slots.
        // Comparing positions in the *filtered* list (rather than walking global
        // indices) keeps this correct even when the sections are interleaved.
        const slots = p.tracks
          .map((track, i) => (track.kind === kind ? i : -1))
          .filter((i) => i >= 0);
        const position = slots.indexOf(index);
        const targetPosition = direction === "up" ? position + 1 : position - 1;
        if (targetPosition < 0 || targetPosition >= slots.length) return p;

        const targetIndex = slots[targetPosition];
        const tracks = [...p.tracks];
        tracks[index] = p.tracks[targetIndex];
        tracks[targetIndex] = p.tracks[index];
        return { ...p, tracks };
      });
    },

    duplicateTrack: (trackId) => {
      const created: string[] = [];
      get().commit((p) => {
        const index = p.tracks.findIndex((t) => t.id === trackId);
        if (index < 0) return p;
        const source = p.tracks[index];
        const copy: Track = {
          ...source,
          id: newId("track"),
          name: `${source.name} 副本`,
          clips: source.clips.map((clip) => {
            const clone: Clip = {
              ...(JSON.parse(JSON.stringify(clip)) as Clip),
              id: newId("clip"),
            };
            created.push(clone.id);
            return clone;
          }),
        };
        const tracks = [...p.tracks];
        tracks.splice(index + 1, 0, copy);
        return { ...p, tracks };
      });
      if (created.length > 0) set({ selection: created });
    },

    clearTrack: (trackId) => {
      const track = get().project.tracks.find((t) => t.id === trackId);
      if (!track || track.locked || track.clips.length === 0) return;
      const removed = track.clips.length;
      get().commit((p) => ({
        ...p,
        tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, clips: [] } : t)),
      }));
      set({ selection: [], status: `已清空轨道上的 ${removed} 个片段`, statusKind: "success" });
    },

    /* ---------------------------------------------------------------- *
     * Templates
     * ---------------------------------------------------------------- */

    applyTemplateProject: (project, templateId, values) => {
      const state = get();
      const merged: Project = {
        ...project,
        // Keep whatever media the user already imported so slots can bind to it.
        assets: project.assets.length > 0 ? project.assets : state.project.assets,
        templateId,
        slots: values,
      };
      playback.setDuration(merged);
      playback.seek(0);
      set({
        project: normalizeProject(withTimestamp(merged)),
        selection: [],
        activeTrackId: merged.tracks[0]?.id ?? null,
        past: [...state.past, state.project].slice(-HISTORY_LIMIT),
        future: [],
        dirty: true,
        // A freshly applied template can be much longer or shorter than the last
        // one, so re-fit the timeline rather than leaving the user at a stale zoom.
        fitRequest: state.fitRequest + 1,
        status: `已套用模板 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
        statusKind: "success",
      });
    },

    setSlot: (slotId, value, rebuild, opts) => {
      const state = get();
      const project = state.project;
      const values = { ...project.slots, [slotId]: value };
      const next = rebuild({ ...project, slots: values });
      install({ ...next, slots: values }, opts?.history ?? true);
    },

    /* ---------------------------------------------------------------- *
     * UI
     * ---------------------------------------------------------------- */

    setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
    requestFit: () => set({ fitRequest: get().fitRequest + 1 }),
    setLeftTab: (leftTab) => set({ leftTab }),
    setInspectorTab: (inspectorTab) => set({ inspectorTab }),
    setStatus: (message, kind = "info") => set({ status: message, statusKind: kind }),
  };
});

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export function selectedClips(state: EditorState): Clip[] {
  return state.selection
    .map((id) => findClip(state.project, id))
    .filter((c): c is Clip => !!c);
}

export function primarySelectedClip(state: EditorState): Clip | null {
  const first = state.selection[0];
  return first ? (findClip(state.project, first) ?? null) : null;
}

export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}
