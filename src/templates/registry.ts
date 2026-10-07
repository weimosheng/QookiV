import { featureTourTemplate } from "./builtin/featureTour";
import { logoStingTemplate } from "./builtin/logoSting";
import { minimalPromoTemplate } from "./builtin/minimalPromo";
import { qookixPromoTemplate } from "./builtin/qookixPromo";
import { socialVerticalTemplate } from "./builtin/socialVertical";
import { statsHighlightTemplate } from "./builtin/statsHighlight";
import { versionLaunchTemplate } from "./builtin/versionLaunch";
import type { PromoTemplate, TemplateCategory } from "./types";
import { CATEGORY_LABELS } from "./types";

/**
 * The built-in template library.
 *
 * Order matters: it is the order shown in the gallery, so the flagship cuts come
 * first.
 */
export const TEMPLATES: PromoTemplate[] = [
  minimalPromoTemplate,
  qookixPromoTemplate,
  featureTourTemplate,
  versionLaunchTemplate,
  statsHighlightTemplate,
  socialVerticalTemplate,
  logoStingTemplate,
];

export function getTemplate(id: string): PromoTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export interface TemplateGroup {
  category: TemplateCategory;
  label: string;
  templates: PromoTemplate[];
}

/** Groups templates for the gallery, preserving `TEMPLATES` order within a group. */
export function groupTemplates(list: PromoTemplate[] = TEMPLATES): TemplateGroup[] {
  const order: TemplateCategory[] = ["product", "feature", "launch", "brand", "data", "social"];
  const groups = new Map<TemplateCategory, PromoTemplate[]>();
  for (const template of list) {
    const bucket = groups.get(template.category);
    if (bucket) bucket.push(template);
    else groups.set(template.category, [template]);
  }
  return order
    .filter((category) => groups.has(category))
    .map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      templates: groups.get(category) ?? [],
    }));
}

/** Free-text search across name, description and tags. */
export function searchTemplates(query: string): PromoTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return TEMPLATES;
  return TEMPLATES.filter((t) =>
    [t.name, t.description, ...t.tags, CATEGORY_LABELS[t.category]]
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

export { CATEGORY_LABELS };
export type { PromoTemplate, TemplateCategory };
