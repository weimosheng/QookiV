import { newId } from "../core/ids";
import { normalizeProject } from "../core/project";
import { QOOKIX_PRESENTATION, BUILT_IN_THEMES } from "../core/theme";
import type { Asset, Clip, Project, SlotValue } from "../core/types";
import { withBrandAssets } from "./builtinAssets";
import { defaultSlotValues, makeBuildContext } from "./types";
import type { BuildContext, PromoTemplate, SlotValues } from "./types";

/**
 * Turning a template plus slot values into a real project.
 *
 * Kept separate from the React layer so templates can be instantiated by the
 * gallery, the slot inspector and any future batch/CLI path alike.
 */

/** Ids of every asset a built project actually references. */
export function referencedAssetIds(project: Project): string[] {
  const ids = new Set<string>();
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      ids.add(assetIdOf(clip));
    }
  }
  ids.delete("");
  return Array.from(ids);
}

function assetIdOf(clip: Clip): string {
  switch (clip.kind) {
    case "image":
    case "video":
    case "audio":
      return clip.props.assetId ?? "";
    case "device":
      return clip.props.assetId ?? "";
    default:
      return "";
  }
}

/** Slot values a template needs, keeping any the user already chose. */
export function mergeSlotValues(
  template: PromoTemplate,
  existing: Record<string, SlotValue> | undefined,
): SlotValues {
  const defaults = defaultSlotValues(template);
  if (!existing) return defaults;
  const out: SlotValues = { ...defaults };
  for (const slot of template.slots) {
    const value = existing[slot.id];
    if (value !== undefined) out[slot.id] = value;
  }
  return out;
}

/** Builds the `BuildContext` a template needs for the current asset library. */
export function contextFor(template: PromoTemplate, assets: Asset[]): BuildContext {
  const theme = BUILT_IN_THEMES[template.themeKey] ?? QOOKIX_PRESENTATION;
  return makeBuildContext(assets, theme);
}

/**
 * Instantiates `template` with `values`.
 *
 * Any built-in brand asset the result refers to is merged into the project's
 * media pool, so a preset renders correctly before the user imports anything.
 */
export function buildFromTemplate(
  template: PromoTemplate,
  values: SlotValues,
  assets: Asset[],
): Project {
  const merged = mergeSlotValues(template, values);
  const ctx = contextFor(template, assets);
  const project = template.build(merged, ctx);

  const built: Project = {
    ...project,
    id: project.id || newId("proj"),
    slots: merged,
    templateId: template.id,
  };
  const referenced = referencedAssetIds(built);
  const withBrand = withBrandAssets(built.assets.length > 0 ? built.assets : assets, referenced);
  // Normalising here means every caller gets a valid project, whether the
  // template was authored by hand or generated: keyframes are trimmed to their
  // clips, values clamped, and clips sorted.
  return normalizeProject({ ...built, assets: withBrand });
}

/**
 * Re-applies the current template after a slot changed.
 *
 * Used by the slot inspector: `rebuild` receives the project and returns a fresh
 * one, keeping the caller free of template knowledge.
 */
export function rebuildWithSlot(
  template: PromoTemplate,
  values: SlotValues,
  assets: Asset[],
): Project {
  return buildFromTemplate(template, values, assets);
}
