import type { Asset } from "../core/types";

/**
 * Assets that ship with the app.
 *
 * Templates reference them by a stable id so a QookiX preset looks complete
 * before the user imports anything. `withBrandAssets` merges them into the
 * project's media pool on demand.
 */

export const BRAND_COOKIE_ID = "brand_cookie_qookix";

export const BRAND_ASSETS: Asset[] = [
  {
    id: BRAND_COOKIE_ID,
    kind: "image",
    name: "QookiX 曲奇 Logo",
    src: "/brand/qookix-cookie.png",
    width: 512,
    height: 512,
    addedAt: 0,
  },
];

export function findBrandAsset(id: string): Asset | undefined {
  return BRAND_ASSETS.find((a) => a.id === id);
}

/**
 * Ensures every built-in asset in `ids` is present in `assets`, keeping the
 * caller's existing order and never duplicating an entry.
 */
export function withBrandAssets(assets: Asset[], ids: string[]): Asset[] {
  const present = new Set(assets.map((a) => a.id));
  const additions: Asset[] = [];
  for (const id of ids) {
    if (present.has(id)) continue;
    const asset = findBrandAsset(id);
    if (asset) {
      additions.push(asset);
      present.add(id);
    }
  }
  return additions.length > 0 ? [...assets, ...additions] : assets;
}
