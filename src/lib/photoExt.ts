/**
 * Derive the on-disk extension of the original photo's MinIO object from
 * the row's filename. The originalKey() helper takes an `ext` argument so
 * the gallery can recover the storage key from a PhotoRow without an
 * S3 HEAD round-trip on every render.
 *
 * Strategy: trust the upload filename's extension. The upload route
 * already normalises this (image/jpeg → .jpg, image/png → .png, etc.)
 * and the worker writes the original to `original.{ext}` using the same
 * derivation. When the filename is missing or unknown we fall back to
 * "jpg" — the dominant photo format — so the imgproxy URL still resolves
 * for legacy rows.
 */
const KNOWN_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);

export function deriveOriginalExt(filename: string | null | undefined): string {
  if (!filename) return "jpg";
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "jpg";
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  return KNOWN_EXTS.has(ext) ? ext : "jpg";
}

/**
 * Alias the renderer-facing call sites use. Same semantics — kept under
 * the historical name so future refactors don't have to chase a rename.
 */
export const resolveOriginalExt = deriveOriginalExt;
