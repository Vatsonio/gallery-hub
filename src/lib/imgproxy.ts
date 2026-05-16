/**
 * imgproxy URL builder.
 *
 * Gallery-hub serves photo derivatives on-demand through imgproxy
 * (https://imgproxy.net). Every public + admin tile, lightbox image, and
 * cover hero resolves to a signed imgproxy URL that lazily resizes the
 * original from MinIO, picks the best supported format from the browser
 * Accept header (AVIF → WEBP → JPEG fallback), and caches the result for
 * a year (IMGPROXY_TTL).
 *
 * Why on-demand instead of pre-baked WEBP/AVIF variants:
 *   - Upload pipeline collapses from ~5–15s per photo (sharp encoding 5
 *     variants + AVIF re-encode) to ~100ms (EXIF + thumbhash + metadata
 *     only). Photo flips status='ready' on the worker hot path; no
 *     background "phase 2".
 *   - Storage cost on MinIO drops by ~5× (originals only, not 5 derivative
 *     blobs per photo).
 *   - Format support follows the browser. Old albums that never got AVIF
 *     pre-encoded now serve AVIF to AVIF-capable clients automatically.
 *
 * Signing format (per imgproxy docs / signing_url):
 *
 *   /{signature}/{processing_options}/{encoded_source}.{extension}
 *
 *   - signature: base64url(HMAC-SHA256(salt || path, key))  (no padding)
 *     where path = "/{processing_options}/{encoded_source}.{extension}".
 *   - processing_options: "/"-joined "key:val:val..." pairs.
 *   - encoded_source: base64url of the raw source URI
 *     ("s3://bucket/key" for our deployment).
 *
 * Env contract:
 *   IMGPROXY_URL          internal base URL (server reads, never browser)
 *   PUBLIC_IMGPROXY_URL   public base URL (what we hand to the browser)
 *   IMGPROXY_KEY          hex-encoded signing key
 *   IMGPROXY_SALT         hex-encoded signing salt
 *   IMGPROXY_BUCKET       S3 bucket name (defaults to MINIO_BUCKET)
 *
 * When PUBLIC_IMGPROXY_URL is unset, helpers FALL BACK to returning the
 * caller-supplied original URL. This lets the test suite and local dev
 * without imgproxy continue to function; in prod the URL is required.
 */
import { createHmac } from "node:crypto";

export interface ImgproxyOptions {
  /** Max width in pixels. Combined with `height` defines the resize bounding box. */
  width?: number;
  /** Max height in pixels. */
  height?: number;
  /**
   * Resize behaviour:
   *   - "fit"  (default): keep aspect, fit inside w×h, never upscale.
   *   - "fill": keep aspect, fill w×h, crop overflow per `gravity`.
   *   - "crop": crop without resizing (gravity controls anchor).
   */
  resize?: "fit" | "fill" | "crop";
  /** Output quality 0-100. imgproxy defaults to IMGPROXY_QUALITY (82) when omitted. */
  quality?: number;
  /**
   * Output format. "auto" (the default) lets imgproxy negotiate the format
   * from the browser Accept header — AVIF/WEBP/JPEG in preference order
   * with the appropriate `IMGPROXY_ENFORCE_*` env vars set. Pass an explicit
   * value when the consumer cannot negotiate (e.g. <link rel="preload">).
   */
  format?: "webp" | "avif" | "jpg" | "png" | "auto";
  /**
   * Anchor for crop/fill operations. Default "sm" (smart — imgproxy
   * picks the most-detailed region). "ce" centres; "no/so/ea/we" pin to
   * an edge.
   */
  gravity?: "sm" | "ce" | "no" | "so" | "ea" | "we";
  /**
   * Optional cache-buster (typically `photos.updated_at` unix ts). Appended
   * to the source URL as `?v=N` so re-edits invalidate downstream caches.
   * Imgproxy bakes the source URL into its cache key, so a different `v`
   * forces a fresh fetch from MinIO without a manual PURGE.
   */
  version?: number | string;
  /**
   * When set, composites a watermark over the output. The MinIO key for
   * the watermark PNG (e.g. "watermarks/{albumId}.png") is converted to
   * an s3://bucket/key reference and passed to imgproxy's wm_url + the
   * accompanying watermark processing option.
   */
  watermark?: { key: string } | null;
}

interface SigningContext {
  key: Buffer;
  salt: Buffer;
  baseUrl: string;
  bucket: string;
}

let cachedCtx: SigningContext | null = null;

/** Decode a hex string into a Buffer, throwing on invalid input. */
function hexDecode(name: string, value: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${name} must be a hex string (got ${value.length} chars of mixed input)`);
  }
  if (value.length % 2 !== 0) {
    throw new Error(`${name} must have an even number of hex chars`);
  }
  return Buffer.from(value, "hex");
}

/**
 * Resolve and cache the signing context. The key + salt are read once per
 * process; rotating either requires a restart.
 *
 * Returns null when PUBLIC_IMGPROXY_URL is missing — callers use that as a
 * cue to fall back to a different URL strategy (presigned MinIO, raw key,
 * etc.) so the test suite and pre-imgproxy dev boxes keep working.
 */
export function getSigningContext(): SigningContext | null {
  if (cachedCtx) return cachedCtx;
  const baseUrl = process.env.PUBLIC_IMGPROXY_URL ?? process.env.IMGPROXY_URL ?? "";
  if (!baseUrl) return null;
  const keyHex = process.env.IMGPROXY_KEY ?? "";
  const saltHex = process.env.IMGPROXY_SALT ?? "";
  if (!keyHex || !saltHex) return null;
  const key = hexDecode("IMGPROXY_KEY", keyHex);
  const salt = hexDecode("IMGPROXY_SALT", saltHex);
  const bucket = process.env.IMGPROXY_BUCKET ?? process.env.MINIO_BUCKET ?? "gallery";
  cachedCtx = {
    key,
    salt,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    bucket,
  };
  return cachedCtx;
}

/** Test helper — drops the cached context so reseeded env vars take effect. */
export function __resetImgproxyContextForTests(): void {
  cachedCtx = null;
}

/** base64url without padding — imgproxy's URL alphabet. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url of a UTF-8 string. */
function base64urlString(s: string): string {
  return base64url(Buffer.from(s, "utf8"));
}

function buildProcessingOptions(opts: ImgproxyOptions): string {
  const parts: string[] = [];
  if (typeof opts.width === "number" || typeof opts.height === "number" || opts.resize) {
    const mode = opts.resize ?? "fit";
    const w = Math.max(0, Math.round(opts.width ?? 0));
    const h = Math.max(0, Math.round(opts.height ?? 0));
    // resize:{type}:{width}:{height}:{enlarge}:{extend}. We pass enlarge=0
    // because we never want to upscale beyond the original.
    parts.push(`resize:${mode}:${w}:${h}:0`);
  }
  if (typeof opts.quality === "number") {
    const q = Math.max(1, Math.min(100, Math.round(opts.quality)));
    parts.push(`quality:${q}`);
  }
  if (opts.gravity) parts.push(`gravity:${opts.gravity}`);
  if (opts.watermark) {
    // Subtle bottom-right stamp with 6% opacity, 20px inset, 25% scale —
    // matches the in-process sharp overlay this replaces.
    const wmKey = `s3://${getSigningContextOrFail().bucket}/${opts.watermark.key}`;
    parts.push(`watermark:0.6:soea:20:0.25`);
    parts.push(`wm_url:${base64urlString(wmKey)}`);
  }
  return parts.join("/");
}

function getSigningContextOrFail(): SigningContext {
  const ctx = getSigningContext();
  if (!ctx) {
    throw new Error(
      "imgproxy signing context unavailable — set PUBLIC_IMGPROXY_URL, IMGPROXY_KEY, IMGPROXY_SALT",
    );
  }
  return ctx;
}

/** Resolve the output extension. "auto" maps to undefined (no extension
 * → imgproxy picks per Accept header). */
function extensionFor(format: ImgproxyOptions["format"] | undefined): string | null {
  if (!format || format === "auto") return null;
  // imgproxy accepts these literally.
  return format;
}

/**
 * Build a signed imgproxy URL for a MinIO object key. Falls back to a
 * pass-through "/${key}" placeholder when no signing context is available
 * (tests, dev without imgproxy) — callers that care should branch on
 * `isImgproxyEnabled()`.
 */
export function buildImgproxyUrl(s3Key: string, opts: ImgproxyOptions = {}): string {
  const ctx = getSigningContext();
  if (!ctx) {
    // Pre-imgproxy fallback. Returning the raw key would break <img src>;
    // returning an opaque placeholder is the least-surprising compromise.
    return `imgproxy://${s3Key}`;
  }

  let sourceUri = `s3://${ctx.bucket}/${s3Key}`;
  if (opts.version !== undefined && opts.version !== null && `${opts.version}` !== "") {
    sourceUri += `?v=${encodeURIComponent(String(opts.version))}`;
  }
  const encodedSource = base64urlString(sourceUri);
  const processing = buildProcessingOptions(opts);
  const ext = extensionFor(opts.format);
  const pathBody = ext
    ? `/${processing}/${encodedSource}.${ext}`
    : `/${processing}/${encodedSource}`;
  // imgproxy concatenates salt + path under HMAC-SHA256.
  const mac = createHmac("sha256", ctx.key).update(ctx.salt).update(pathBody).digest();
  const sig = base64url(mac);
  return `${ctx.baseUrl}/${sig}${pathBody}`;
}

/** True when env vars are wired up such that buildImgproxyUrl produces a real URL. */
export function isImgproxyEnabled(): boolean {
  return getSigningContext() !== null;
}

/**
 * Turn a photo row's `updated_at` (or any ISO/Date/number) into a stable
 * integer the URL builder can stamp into ?v= for cache-busting. We deliberately
 * use seconds (not ms) so a re-render of the same photo collapses onto the
 * same URL even when the SQL layer hands us a slightly different precision.
 */
export function photoVersionSeed(updated: string | number | Date | null | undefined): number {
  if (updated == null) return 0;
  if (typeof updated === "number") return Math.floor(updated / 1000);
  const t = updated instanceof Date ? updated.getTime() : Date.parse(updated);
  if (!Number.isFinite(t)) return 0;
  return Math.floor(t / 1000);
}

// ---------------------------------------------------------------------------
// Common-size helpers. The size buckets mirror the historical WEBP variants
// the gallery generated (thumb/web/large) so a port from variantKey() → these
// helpers is a one-line swap at every call site.
// ---------------------------------------------------------------------------

/**
 * Small grid thumbnail. 400×400 fit, q75. Hot path on the public landing —
 * the browser asks for one per tile in the justified-rows layout.
 */
export function imgproxyThumb(s3Key: string, opts: Partial<ImgproxyOptions> = {}): string {
  return buildImgproxyUrl(s3Key, {
    width: 400,
    height: 400,
    resize: "fit",
    quality: 75,
    format: "auto",
    ...opts,
  });
}

/**
 * Web-sized variant for lightbox / desktop tiles. 1600×1600 fit, q82 — the
 * historical sweet spot for WEBP delivery; AVIF lands ~half the bytes at
 * the same perceived quality.
 */
export function imgproxyWeb(s3Key: string, opts: Partial<ImgproxyOptions> = {}): string {
  return buildImgproxyUrl(s3Key, {
    width: 1600,
    height: 1600,
    resize: "fit",
    quality: 82,
    format: "auto",
    ...opts,
  });
}

/**
 * Large variant for the cover hero + retina-density lightbox. 2400×2400 fit,
 * q86 — preserves grain on landscape shots without doubling byte size vs
 * imgproxyWeb.
 */
export function imgproxyLarge(s3Key: string, opts: Partial<ImgproxyOptions> = {}): string {
  return buildImgproxyUrl(s3Key, {
    width: 2400,
    height: 2400,
    resize: "fit",
    quality: 86,
    format: "auto",
    ...opts,
  });
}
