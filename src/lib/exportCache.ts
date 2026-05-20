import { createHash } from "node:crypto";

export type ExportScope = "favorites" | "all";
export type ExportVariant = "original" | "web";

/**
 * Human-friendly archive filename used in Content-Disposition. Slug is
 * already ASCII-safe (see `slugify` in albums.ts) so we can splice it
 * straight in. Date stamp keeps repeat downloads of the same album
 * distinguishable on the user's disk.
 */
export function buildArchiveFilename(
  albumSlug: string | null | undefined,
  scope: ExportScope,
  now: Date = new Date(),
): string {
  const ymd = now.toISOString().slice(0, 10);
  const stem = (albumSlug && albumSlug.trim().length > 0) ? albumSlug : "album";
  const scopeLabel = scope === "favorites" ? "favorites" : "all";
  return `${stem}-${ymd}-${scopeLabel}.zip`;
}

/**
 * MinIO key for a cached export ZIP. Date stamp scopes the cache to a
 * single day so the reaper can prune yesterday's blobs without having to
 * read object metadata for every entry.
 */
export function buildCacheKey(
  token: string,
  scope: ExportScope,
  variant: ExportVariant,
  now: Date = new Date(),
): string {
  const ymd = now.toISOString().slice(0, 10);
  return `exports/${token}/${scope}-${variant}-${ymd}.zip`;
}

/**
 * Order-independent fingerprint of a favorites set. Stored as MinIO
 * object metadata so a same-day repeat request whose favorites set
 * changed (added/removed photos) misses the cache and regenerates.
 */
export function favoritesSignature(photoIds: string[]): string {
  if (photoIds.length === 0) return "empty";
  const sorted = [...photoIds].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}
