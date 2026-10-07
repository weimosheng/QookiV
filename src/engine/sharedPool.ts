import { MediaPool } from "./MediaPool";

/**
 * The app-wide media pool.
 *
 * Shared deliberately: the preview and the exporter must read the *same* decoded
 * video elements, otherwise an export would re-decode everything and could
 * disagree with what the user just watched.
 *
 * (Named `sharedPool` rather than `mediaPool` because Windows paths are
 * case-insensitive and it would collide with `MediaPool.ts`.)
 */
export const mediaPool = new MediaPool();

/** A separate pool for gallery thumbnails, so previews never evict real media. */
export const thumbnailPool = new MediaPool();
