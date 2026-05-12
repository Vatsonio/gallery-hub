import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3SignerClient, BUCKET } from "@/lib/minio";

export interface PresignGetOptions {
  /**
   * Optional response Content-Disposition override. When set, MinIO will
   * include this header in the response — used to force a download
   * with a stable filename instead of inline rendering. Example:
   *   responseContentDisposition: 'attachment; filename="cabo-sunset.jpg"'
   */
  responseContentDisposition?: string;
  /** Optional response Content-Type override. */
  responseContentType?: string;
  /**
   * Optional response Cache-Control override. Photo variants are
   * content-addressed by key (an albumId/photoId/variant tuple maps to a
   * stable byte blob), so callers can safely pass
   * `public, max-age=31536000, immutable` to let the browser keep them
   * forever. Avoid setting this on URLs whose contents change (e.g. ZIP
   * exports that are re-rendered per request).
   */
  responseCacheControl?: string;
}

// Presigned URLs are handed to the browser, so they must use the PUBLIC
// MinIO endpoint (MINIO_PUBLIC_ENDPOINT) rather than the internal Docker
// hostname (gallery-minio:9000) which the browser can't reach.
export async function presignPut(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3SignerClient, cmd, { expiresIn: expiresInSeconds });
}

// ----- LRU cache ----------------------------------------------------------
//
// Signing a URL is cheap but not free (HMAC over canonical request,
// roughly 50–200µs each). For a gallery page that calls presignGet
// hundreds of times per render, the work adds up — and since the
// resulting URL is deterministic for a fixed (key, opts, expiry-bucket)
// tuple, we can memoize.
//
// TTL bucketing: callers ask for a TTL in seconds. We round the current
// time down to the nearest 80% of that TTL so a cached URL is reused
// until at most 80% of its lifetime has elapsed — leaving the client
// ample slack to download before the signature expires. Each bucket
// produces a stable cache key; once a new bucket starts we compute and
// store a fresh URL.

const PRESIGN_CACHE_MAX = 5000;
type CacheEntry = { url: string };
const presignCache: Map<string, CacheEntry> = new Map();

function cacheKey(key: string, ttl: number, bucket: number, opts: PresignGetOptions): string {
  return [
    key,
    ttl,
    bucket,
    opts.responseContentDisposition ?? "",
    opts.responseContentType ?? "",
    opts.responseCacheControl ?? "",
  ].join("|");
}

function ttlBucket(ttlSeconds: number, now: number = Date.now()): number {
  const stride = Math.max(1, Math.floor(ttlSeconds * 0.8));
  return Math.floor(now / 1000 / stride);
}

/** Test helper — clears the LRU. Not exported in production paths. */
export function __resetPresignCache(): void {
  presignCache.clear();
}

/** Test helper — exposes the cache size for assertions. */
export function __presignCacheSize(): number {
  return presignCache.size;
}

export async function presignGet(
  key: string,
  expiresInSeconds = 3600,
  opts: PresignGetOptions = {},
): Promise<string> {
  const bucket = ttlBucket(expiresInSeconds);
  const ck = cacheKey(key, expiresInSeconds, bucket, opts);

  const hit = presignCache.get(ck);
  if (hit) {
    // Refresh LRU recency.
    presignCache.delete(ck);
    presignCache.set(ck, hit);
    return hit.url;
  }

  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: opts.responseContentDisposition,
    ResponseContentType: opts.responseContentType,
    ResponseCacheControl: opts.responseCacheControl,
  });
  const url = await getSignedUrl(s3SignerClient, cmd, { expiresIn: expiresInSeconds });

  presignCache.set(ck, { url });
  if (presignCache.size > PRESIGN_CACHE_MAX) {
    // Evict oldest (insertion order in Map).
    const oldest = presignCache.keys().next().value;
    if (oldest !== undefined) presignCache.delete(oldest);
  }
  return url;
}

/**
 * Quote a filename for use in a Content-Disposition header value.
 * Strips control chars and double-quotes to keep header parsing happy.
 */
export function contentDispositionAttachment(filename: string): string {
  const safe = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[^\x20-\x7E]/g, "_") // ASCII-safe fallback
    .slice(0, 200) || "download";
  // RFC 5987 filename* lets us encode the original UTF-8 filename too.
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

/** Default Cache-Control for immutable variant URLs. */
export const IMMUTABLE_VARIANT_CACHE_CONTROL = "public, max-age=31536000, immutable";
