import type { AspectPreset, Asset, Project, SlotValue, ThemeTokens } from "../core/types";

/**
 * Template contracts.
 *
 * A template is a pure builder: it turns slot values into a complete `Project`.
 * Nothing about a template is stored in the project beyond the slot values,
 * which is what makes "change the title" re-render the whole cut instantly.
 */

export type SlotType =
  | "text"
  | "textarea"
  | "color"
  | "number"
  | "boolean"
  | "asset"
  | "select"
  /** 可增删的条目列表；每个条目的字段由 `TemplateSlot.item` 描述。 */
  | "list";

export interface SlotOption {
  value: string;
  label: string;
}

/**
 * 列表条目里的一格值。
 *
 * 用**固定字段**的普通对象而不是任意 JSON：条目要能被表单逐格编辑、被模板逐格读取、
 * 又能原样序列化进 `project.slots` 存档，所以它必须是"值"——字符串、数字、布尔，
 * 或它们的数组（用于嵌套的二级列表）。
 */
export type TemplateItemValue = string | number | boolean | TemplateItemValue[];
export type TemplateItem = Record<string, TemplateItemValue>;

export interface TemplateSlot {
  id: string;
  label: string;
  type: SlotType;
  default: SlotValue;
  options?: SlotOption[];
  min?: number;
  max?: number;
  step?: number;
  /** Groups slots into sections in the template inspector. */
  group?: string;
  help?: string;
  /** For `asset` slots, restricts which media kinds can be bound. */
  assetKind?: "image" | "video" | "audio";
  /**
   * For `list` slots: the shape of one entry.
   *
   * Described with the same `TemplateSlot` machinery as top-level fields, so a list
   * entry can hold a text, an image picker, a number… and even another list (the
   * item's own `type: "list"` + `item`). The form UI is therefore written once and
   * works for any depth of nesting.
   */
  item?: TemplateItemSchema;
}

export interface TemplateItemSchema {
  /** One entry's fields, keyed by field id. */
  fields: TemplateSlot[];
  /** Label on the "add" button, e.g. "添加面板". */
  addLabel?: string;
  /** How many entries the user may add. */
  max?: number;
}

export type SlotValues = Record<string, SlotValue>;

export type TemplateCategory = "brand" | "product" | "feature" | "launch" | "data" | "social";

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  brand: "品牌演绎",
  product: "产品宣传",
  feature: "功能速览",
  launch: "版本发布",
  data: "数据亮点",
  social: "社媒竖屏",
};

export interface BuildContext {
  assets: Asset[];
  theme: ThemeTokens;
  imageAssets: Asset[];
  videoAssets: Asset[];
  audioAssets: Asset[];
  /** First image/video if any, so templates look right before the user imports. */
  firstImage?: Asset;
  firstVideo?: Asset;
  firstAudio?: Asset;
}

export interface PromoTemplate {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  aspect: AspectPreset;
  /** Nominal length in seconds; the built project may differ slightly. */
  duration: number;
  themeKey: string;
  slots: TemplateSlot[];
  build(values: SlotValues, ctx: BuildContext): Project;
}

/** Builds the `BuildContext` for a given theme and asset list. */
export function makeBuildContext(assets: Asset[], theme: ThemeTokens): BuildContext {
  const imageAssets = assets.filter((a) => a.kind === "image");
  const videoAssets = assets.filter((a) => a.kind === "video");
  const audioAssets = assets.filter((a) => a.kind === "audio");
  return {
    assets,
    theme,
    imageAssets,
    videoAssets,
    audioAssets,
    firstImage: imageAssets[0],
    firstVideo: videoAssets[0],
    firstAudio: audioAssets[0],
  };
}

/** Default slot values for a template. */
export function defaultSlotValues(template: PromoTemplate): SlotValues {
  const out: SlotValues = {};
  for (const slot of template.slots) out[slot.id] = slot.default;
  return out;
}
