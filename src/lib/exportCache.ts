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
 * MinIO key for a cached export ZIP. The content signature is folded into
 * the key so the cache is content-addressed:
 *   - F20: an `all`-scope export invalidates automatically when album
 *     content changes (a different set/edit → a different sig → a
 *     different key), instead of serving a stale same-day blob.
 *   - F50: different viewers' favorites sets get distinct keys instead of
 *     overwriting one shared per-token object (which made the cache thrash
 *     and rarely hit for multi-viewer albums).
 * The date stamp is retained so the reaper can prune by day.
 */
export function buildCacheKey(
  token: string,
  scope: ExportScope,
  variant: ExportVariant,
  signature: string,
  now: Date = new Date(),
): string {
  const ymd = now.toISOString().slice(0, 10);
  const shortSig = signature.slice(0, 16);
  return `exports/${token}/${scope}-${variant}-${shortSig}-${ymd}.zip`;
}

/**
 * Order-independent fingerprint of a favorites set (legacy helper kept for
 * tests / callers that only have ids). Prefer `contentSignature` for the
 * export cache so photo edits invalidate it.
 */
export function favoritesSignature(photoIds: string[]): string {
  if (photoIds.length === 0) return "empty";
  const sorted = [...photoIds].sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex");
}

/**
 * Order-independent, edit-sensitive fingerprint of an export's photo set.
 * Includes `updated_at` (and sort_order) so adding/removing/editing/
 * reordering photos changes the signature — which (folded into the cache
 * key) makes the cached ZIP invalidate instead of serving stale content
 * after a deletion or edit (F20).
 */
export function contentSignature(
  items: { id: string; updated_at?: string | null; sort_order?: number | null }[],
): string {
  if (items.length === 0) return "empty";
  const parts = items
    .map((p) => `${p.id}:${p.updated_at ?? ""}:${p.sort_order ?? ""}`)
    .sort();
  return createHash("sha256").update(parts.join("|")).digest("hex");
}
