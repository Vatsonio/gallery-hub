import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { sql } from "@/lib/db";
import {
  s3Client,
  BUCKET,
  headObject,
  getObjectStream,
  getPresignedUrl,
} from "@/lib/minio";
import {
  buildArchiveFilename,
  buildCacheKey,
  contentSignature,
  type ExportScope,
  type ExportVariant,
} from "@/lib/exportCache";
import { WEB_VARIANT_RATIO } from "@/lib/exportSizes";
import { createFanOutZip, type ZipEntry } from "@/lib/zipStream";
import { variantKey } from "@/lib/keys";
import { imgproxyWeb, photoVersionSeed } from "@/lib/imgproxy";
import { resolveShareLinkStatus, unlockCookieName } from "@/lib/share";
import { ADMIN_PREVIEW_VIEWER_ID, VIEWER_COOKIE } from "@/lib/viewer";
import { createRateLimiter } from "@/lib/rateLimiter";
import { resolveIpFromHeaders } from "@/lib/client-ip";
import { safeCapture } from "@/lib/analytics";
import { notifyExportStarted, notifyExportCompleted } from "@/lib/notifications";
import { getAlbumById } from "@/lib/albums";

/**
 * Machine-readable reason codes returned in the JSON body of any
 * non-2xx export response. The client uses these to surface
 * context-aware toast messages without parsing English.
 */
export type ExportErrorReason =
  | "bad_params"
  | "not_found"
  | "expired"
  | "locked"
  | "download_disabled"
  | "rate_limited"
  | "too_large"
  | "no_favorites"
  | "empty_album"
  | "admin_preview_no_favorites";

function errorBody(reason: ExportErrorReason, message: string): string {
  return JSON.stringify({ reason, message });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Leaky bucket, module-level so it survives across requests in a single
// Node worker. 6 starts in 60s is generous for the UI but blocks
// pathological clients. F21: keyed by a SERVER-trusted identity (token +
// client IP) — the old `token|viewerId` key folded in a client-controlled
// cookie that an attacker could drop/rotate to get a fresh bucket every
// request, bypassing the limit entirely.
const exportLimiter = createRateLimiter({ max: 6, windowMs: 60_000 });

// F5: hard ceilings on a single export so a download-enabled share link
// can't be turned into a resource-exhaustion lever (multi-GB ZIP, minutes
// of open MinIO upload, and — combined with F4 — heap pressure). Overridable
// via env for operators with genuinely huge albums.
const MAX_EXPORT_PHOTOS = Number(process.env.MAX_EXPORT_PHOTOS ?? "5000");
const MAX_EXPORT_BYTES = Number(process.env.MAX_EXPORT_BYTES ?? String(25 * 1_000_000_000));

function deriveExtFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "jpg";
  return filename.slice(dot + 1).toLowerCase();
}

function originalKeyForPhoto(albumId: string, photoId: string, filename: string): string {
  return `albums/${albumId}/${photoId}/original.${deriveExtFromFilename(filename)}`;
}

async function logExport(
  token: string,
  viewerId: string,
  scope: ExportScope,
  variant: ExportVariant,
  bytes: number,
): Promise<void> {
  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type, photo_id, details)
    VALUES (${token}, ${viewerId}, 'download', NULL, ${sql.json({ scope, variant, bytes })})
  `.catch(() => undefined);
}

interface PhotoRow {
  id: string;
  filename: string;
  sort_order: number;
  /** Used to derive the imgproxy cachebuster for the web-variant export. */
  updated_at: string | null;
}

/**
 * Strip the source filename's extension and append ".jpg". Web-variant
 * exports always re-encode through imgproxy as JPEG q80 (1600px max), so
 * the file inside the ZIP should advertise the new extension — naming a
 * JPEG `.heic` would confuse downstream tools and the macOS Finder.
 */
function jpegFilename(original: string): string {
  const dot = original.lastIndexOf(".");
  const stem = dot < 0 ? original : original.slice(0, dot);
  return `${stem}.jpg`;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "all") as ExportScope;
  const variant = (url.searchParams.get("variant") ?? "web") as ExportVariant;
  // Probe mode: client-side pre-flight. The export modal calls
  // GET ...?probe=1 before triggering an actual download so a 4xx
  // surfaces as a toast instead of a navigate-to-error-page. Probe
  // requests share the same validation pipeline (cheap DB lookups
  // only) but skip every side effect: no analytics, no notifications,
  // no cache writes, no zip stream. On success they return 204.
  const probe = url.searchParams.get("probe") === "1";

  if (!["favorites", "all"].includes(scope) || !["original", "web"].includes(variant)) {
    return new NextResponse(errorBody("bad_params", "Unsupported export parameters."), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const jar = await cookies();

  // Validate share link via the shared status resolver (handles expired/locked).
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  // F30: collapse not_found / expired / locked into ONE generic 404 for the
  // pre-unlock path. The previous distinct codes (404 / 410 / 401) let an
  // unauthenticated caller fingerprint which tokens exist, which are expired,
  // and which are password-protected — before any password gate. This matches
  // the deliberately-collapsed viewer-context route.
  if (status.kind === "not_found" || status.kind === "expired" || status.kind === "locked") {
    return new NextResponse(errorBody("not_found", "This share link is not available."), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!status.link.allow_download) {
    return new NextResponse(
      errorBody("download_disabled", "Downloads are disabled for this album."),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // Viewer id. The page-render middleware mints this cookie at path "/"
  // before any /a/{token} traffic, so by the time the user clicks Download
  // the cookie is always present. We still fall back to a fresh UUID for
  // direct API hits (curl, share-link forwarded straight to /api/export)
  // but write the new cookie at path "/" — the previous code wrote at
  // /a/{token}, which orphaned the viewer's favorites because the browser
  // wouldn't send that cookie back to /api/export on the next call.
  let viewerId = jar.get(VIEWER_COOKIE)?.value ?? "";
  if (!viewerId) {
    viewerId = randomUUID();
    jar.set(VIEWER_COOKIE, viewerId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  // Rate-limit only real downloads. A probe ping is meant to be cheap
  // and quick (it runs every modal open), so subjecting it to the same
  // bucket would mean clicking the dock twice in 30s could shadow-ban
  // the legitimate download that follows.
  const clientIp = resolveIpFromHeaders(req.headers);
  if (!probe && !exportLimiter.allow(`${token}|${clientIp}`)) {
    return new NextResponse(
      errorBody("rate_limited", "Too many download attempts. Please wait a minute."),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      },
    );
  }

  // Resolve the photo set BEFORE side effects so a probe (and a real
  // download that turns out to be empty) doesn't fire export_started
  // events that never complete. The photo lookup is one cheap indexed
  // query so the reorder costs nothing on the happy path.
  let photos: PhotoRow[];
  if (scope === "favorites") {
    photos = await sql<PhotoRow[]>`
      SELECT p.id, p.filename, p.sort_order, p.updated_at::text AS updated_at
        FROM favorites f
        JOIN photos p ON p.id = f.photo_id
       WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
       ORDER BY p.sort_order ASC, p.created_at ASC
    `;
  } else {
    photos = await sql<PhotoRow[]>`
      SELECT id, filename, sort_order, updated_at::text AS updated_at FROM photos
       WHERE album_id = ${status.link.album_id} AND status = 'ready'
       ORDER BY sort_order ASC, created_at ASC
    `;
  }
  if (photos.length === 0) {
    // Context-aware reason: admin previews don't have a real viewer
    // cookie so their favorites set is always empty by construction.
    // Surface a different message so the admin testing the link knows
    // to switch to a private window instead of "go like some photos".
    const isAdminPreview = viewerId === ADMIN_PREVIEW_VIEWER_ID;
    if (scope === "favorites") {
      const reason: ExportErrorReason = isAdminPreview
        ? "admin_preview_no_favorites"
        : "no_favorites";
      const message = isAdminPreview
        ? "Admin previews can't favorite photos. Open the link in a private window to test as a visitor."
        : "Like some photos first to enable a favorites export.";
      return new NextResponse(errorBody(reason, message), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new NextResponse(errorBody("empty_album", "There are no photos in this album yet."), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // F5: enforce size/count ceilings before building (or OK-ing a probe).
  // The `all` scope was previously unbounded — a huge album produced a
  // tens-of-GB ZIP that held an open MinIO upload for minutes and (with F4)
  // pressured the heap. Any visitor of a download-enabled link could trigger
  // it repeatedly. We compute the byte total here (also reused for logging
  // below, replacing the old post-build query).
  if (photos.length > MAX_EXPORT_PHOTOS) {
    return new NextResponse(
      errorBody("too_large", `This export exceeds the ${MAX_EXPORT_PHOTOS}-photo limit.`),
      { status: 413, headers: { "Content-Type": "application/json" } },
    );
  }
  const sizeRow = await sql<{ total: string | null }[]>`
    SELECT COALESCE(SUM(orig_bytes), 0)::text AS total
      FROM photos
     WHERE id = ANY(${photos.map((p) => p.id)}::uuid[])
  `;
  const totalOrigBytes = Number(sizeRow[0]?.total ?? 0);
  if (totalOrigBytes > MAX_EXPORT_BYTES) {
    return new NextResponse(
      errorBody("too_large", "This export is too large to download in one archive."),
      { status: 413, headers: { "Content-Type": "application/json" } },
    );
  }

  // Probe mode: photo set is non-empty and all preconditions passed.
  // Short-circuit before any side effects — the client now knows the
  // real download will succeed and will trigger it via a normal
  // navigation/anchor click.
  if (probe) {
    return new NextResponse(null, { status: 204 });
  }

  // export_started fires regardless of cache hit/miss so funnels measure
  // intent, not zip-build time. The matching export_completed (with bytes)
  // lands either in the cache-hit branch or after the size lookup below.
  safeCapture({
    distinctId: viewerId,
    event: "export_started",
    properties: { share_token: token, scope, variant },
  });
  // Telegram notification (fire-and-forget; never blocks the export).
  // Resolved lazily so a slow album lookup doesn't delay the zip stream.
  const albumForNotify = await getAlbumById(status.link.album_id).catch(() => null);
  if (albumForNotify) {
    void notifyExportStarted({
      album_title: albumForNotify.title,
      share_token: token,
      viewer_id: viewerId,
      scope,
      variant,
    });
  }

  // Content-addressed signature for BOTH scopes (F20/F50): includes each
  // photo's updated_at so edits/deletions invalidate the cache, and it's
  // folded into the key so different favorites sets don't overwrite each
  // other's cached ZIP.
  const sig = contentSignature(photos);
  const cacheKey = buildCacheKey(token, scope, variant, sig, new Date());

  const archiveName = buildArchiveFilename(albumForNotify?.slug, scope);

  // Cache lookup. The key is content-addressed (it encodes `sig`), so an
  // object existing AT this key is guaranteed to be the right content —
  // no metadata comparison needed. A miss (HEAD throws) falls through.
  try {
    const head = await headObject(cacheKey);
    const presigned = await getPresignedUrl(cacheKey, 3600, undefined, {
      responseContentDisposition: `attachment; filename="${archiveName}"`,
    });
    const cachedBytes = head.ContentLength ?? 0;
    await logExport(token, viewerId, scope, variant, cachedBytes);
    safeCapture({
      distinctId: viewerId,
      event: "export_completed",
      properties: {
        share_token: token,
        scope,
        variant,
        total_bytes: cachedBytes,
        cache_hit: true,
      },
    });
    if (albumForNotify) {
      void notifyExportCompleted({
        album_title: albumForNotify.title,
        share_token: token,
        viewer_id: viewerId,
        scope,
        variant,
        total_bytes: cachedBytes,
        cache_hit: true,
      });
    }
    return NextResponse.redirect(presigned, 302);
  } catch {
    // miss — fall through to fresh build
  }

  // Build a fresh ZIP and fan out to both the HTTP response and MinIO.
  //
  // imgproxy era:
  //   - variant="original": stream the raw MinIO bytes (no re-encode).
  //   - variant="web":      pipe each photo through imgproxy's signed URL
  //                         (1600 max, JPEG q80). The cachebuster matches
  //                         what the public gallery page uses so a fresh
  //                         export rides the existing imgproxy cache —
  //                         second-time exports hit warm bytes per photo.
  // We use the server-side IMGPROXY_URL (falls back to PUBLIC_IMGPROXY_URL
  // inside buildImgproxyUrl) so the export traffic stays on the internal
  // network instead of bouncing out through Cloudflare.
  const albumId = status.link.album_id;
  async function* gen(): AsyncGenerator<ZipEntry> {
    for (const p of photos) {
      const key = originalKeyForPhoto(albumId, p.id, p.filename);
      const prefix = String(p.sort_order + 1).padStart(3, "0");
      if (variant === "web") {
        const url = imgproxyWeb(key, { version: photoVersionSeed(p.updated_at) });
        const res = await fetch(url, {
          headers: {
            // Force JPEG response: prod imgproxy has IMGPROXY_ENFORCE_WEBP=true
            // which auto-upgrades to WebP whenever the Accept header lists it.
            // The URL extension .jpg already pins format=jpg, but a JPEG-only
            // Accept removes any ambiguity (and matches what the user expects
            // when they pick the "web size" export).
            accept: "image/jpeg",
            "user-agent": "gallery-hub-export/1",
          },
          // F53: bound each render. Without a timeout a single wedged
          // imgproxy fetch never resolves and stalls the archiver, the HTTP
          // response AND the background MinIO upload indefinitely. Mirrors
          // the 30s timeout warmImgproxyVariants already uses.
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok || !res.body) {
          throw new Error(
            `[export-web] imgproxy returned HTTP ${res.status} for photo ${p.id}`,
          );
        }
        yield {
          name: `${prefix}-${jpegFilename(p.filename)}`,
          body: Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
        };
      } else {
        const body = await getObjectStream(key);
        yield {
          name: `${prefix}-${p.filename}`,
          body,
        };
      }
    }
  }
  // variantKey is no longer reached for export streaming; reference it
  // through a void to keep the import bookkeeping deterministic.
  void variantKey;

  const { toHttp, toMinio, done } = createFanOutZip(gen());

  // Kick off the cache upload in the background. We don't await it on the
  // hot path — the HTTP response streams independently.
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: BUCKET,
      Key: cacheKey,
      Body: toMinio,
      ContentType: "application/zip",
      Metadata: {
        content_signature: sig,
        scope,
        variant,
      },
    },
  });
  upload.done().catch((err: unknown) => {
    console.error("[export] cache upload failed", err);
  });
  done.catch((err: unknown) => {
    console.error("[export] archive build failed", err);
  });

  // Byte total for logging/analytics/notifications. Reuse the sum computed
  // for the F5 cap above instead of re-querying. F51: the `web` variant
  // streams imgproxy-re-encoded JPEGs (~22% of originals), so reporting the
  // raw orig_bytes overstated it ~4-5x; apply the same ratio the modal
  // preview uses so miss-path reporting roughly matches the cache-hit path
  // (which logs the real ContentLength).
  const totalBytes = variant === "web"
    ? Math.round(totalOrigBytes * WEB_VARIANT_RATIO)
    : totalOrigBytes;
  await logExport(token, viewerId, scope, variant, totalBytes);
  safeCapture({
    distinctId: viewerId,
    event: "export_completed",
    properties: {
      share_token: token,
      scope,
      variant,
      total_bytes: totalBytes,
      cache_hit: false,
    },
  });
  if (albumForNotify) {
    void notifyExportCompleted({
      album_title: albumForNotify.title,
      share_token: token,
      viewer_id: viewerId,
      scope,
      variant,
      total_bytes: totalBytes,
      cache_hit: false,
    });
  }

  // Cast PassThrough → web ReadableStream. Node's `Readable.toWeb` would be
  // ideal but Next 15 happily accepts a Node Readable here.
  return new Response(toHttp as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${archiveName}"`,
      "Cache-Control": "no-store",
    },
  });
}

// Avoid unused-import lint warnings from the lib-storage type import above.
void PutObjectCommand;
