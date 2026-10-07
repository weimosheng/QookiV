/**
 * Timeline zoom bounds, in pixels per second.
 *
 * Lives in `core` so the store and the viewport agree on a single range. They
 * previously clamped independently — the viewport allowed 4 px/s and the store
 * silently pushed it back up to 6 — so `clampZoom` could hand back a value the
 * store would then change.
 */

export const MIN_ZOOM = 4;
export const MAX_ZOOM = 600;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return MIN_ZOOM;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}
