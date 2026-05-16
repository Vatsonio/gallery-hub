/**
 * Filename sanitization for user-supplied upload filenames.
 *
 * F7 pentest finding (2026-05-16): `/api/upload/finalize` accepted filenames
 * with `../`, control chars, NUL bytes, and absolute path prefixes. The
 * value never reaches the server filesystem (object keys are id-derived in
 * `src/lib/keys.ts`), but it IS interpolated into ZIP entry names by the
 * export route — naive extractors that don't sanitize entry paths will then
 * write outside the extraction directory (ZIP-slip class).
 *
 * `sanitizeFilename` normalizes the value to NFC, strips path separators,
 * control chars, NUL bytes, and leading dots, collapses internal whitespace,
 * caps the length at `MAX_FILENAME_LENGTH`, and falls back to a safe default
 * when the input collapses to empty. The result is always:
 *   - non-empty
 *   - free of `/`, `\`, `..` segments, NUL, control chars (<0x20, 0x7f)
 *   - free of leading `.` (no hidden files)
 *   - ≤ MAX_FILENAME_LENGTH characters
 *   - Unicode-normalized (NFC)
 */

export const MAX_FILENAME_LENGTH = 200;
export const FALLBACK_FILENAME = "file";

/** Characters we never allow anywhere in a filename. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const PATH_SEPARATORS = /[/\\]/g;
const LEADING_DOTS = /^\.+/;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/;
const COLLAPSED_WHITESPACE = /\s+/g;

export function sanitizeFilename(input: unknown): string {
  if (typeof input !== "string") return FALLBACK_FILENAME;

  // Unicode normalization first — keeps composed-char and decomposed-char
  // inputs interchangeable, and prevents `..` hidden behind combining marks.
  let name = input.normalize("NFC");

  // Strip NUL + control chars (must run before path-separator strip so we
  // don't accidentally leave dangling segments).
  name = name.replace(CONTROL_CHARS, "");

  // Take only the final path segment — `path.basename` is platform-aware
  // but we want a deterministic strip regardless of host OS, so handle both
  // separators ourselves.
  const lastSep = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  if (lastSep >= 0) name = name.slice(lastSep + 1);

  // Now any remaining separators are inside a single segment — replace them.
  name = name.replace(PATH_SEPARATORS, "_");

  // Strip Windows drive prefix `C:` etc. that survived the split-on-sep.
  name = name.replace(/^[A-Za-z]:/, "");

  // Collapse internal whitespace runs (newlines, tabs, multi-spaces) to one
  // space — pure cosmetic, but it also defends against \r\n in entry names.
  name = name.replace(COLLAPSED_WHITESPACE, " ");

  // Remove `..` segments outright — if the entire name was `..` or `....`
  // we want it gone, not preserved.
  if (/^\.+$/.test(name.trim())) name = "";

  // Strip leading dots (no hidden files) and trailing dots/spaces (Windows
  // strips trailing dots silently, which can cause `foo.exe.` → `foo.exe`).
  name = name.replace(LEADING_DOTS, "");
  name = name.replace(TRAILING_DOTS_OR_SPACES, "");

  // Trim whitespace once more — leading dots may have left a leading space.
  name = name.trim();

  if (name.length === 0) return FALLBACK_FILENAME;

  // Cap length — preserve the extension when truncating so the file still
  // round-trips through tools that infer type from extension.
  if (name.length > MAX_FILENAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    if (dot > 0 && name.length - dot <= 16) {
      const ext = name.slice(dot);
      const head = name.slice(0, MAX_FILENAME_LENGTH - ext.length);
      name = head + ext;
    } else {
      name = name.slice(0, MAX_FILENAME_LENGTH);
    }
  }

  // One last check — truncation may have re-introduced a trailing dot/space.
  name = name.replace(TRAILING_DOTS_OR_SPACES, "");
  if (name.length === 0) return FALLBACK_FILENAME;

  return name;
}
