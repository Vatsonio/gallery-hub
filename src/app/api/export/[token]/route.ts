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
  buildCacheKey,
  favoritesSignature,
  type ExportScope,
  type ExportVariant,
} from "@/lib/exportCache";
import { createFanOutZip, type ZipEntry } from "@/lib/zipStream";
import { variantKey } from "@/lib/keys";
import { imgproxyWeb, photoVersionSeed } from "@/lib/imgproxy";
import { resolveShareLinkStatus, unlockCookieName } from "@/lib/share";
import { ADMIN_PREVIEW_VIEWER_ID, VIEWER_COOKIE } from "@/lib/viewer";
import { createRateLimiter } from "@/lib/rateLimiter";
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
  | "no_favorites"
  | "empty_album"
  | "admin_preview_no_favorites";

function errorBody(reason: ExportErrorReason, message: string): string {
  return JSON.stringify({ reason, message });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-viewer leaky bucket. Module-level so it survives across requests in a
// single Node worker. 6 starts in 60s is generous for the UI but blocks
// pathological clients (e.g. infinite-redirect bots).
const exportLimiter = createRateLimiter({ max: 6, windowMs: 60_000 });

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
  if (status.kind === "not_found") {
    return new NextResponse(errorBody("not_found", "This share link no longer exists."), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (status.kind === "expired") {
    return new NextResponse(errorBody("expired", "This share link has expired."), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (status.kind === "locked") {
    return new NextResponse(errorBody("locked", "Unlock the gallery to export photos."), {
      status: 401,
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
  if (!probe && !exportLimiter.allow(`${token}|${viewerId}`)) {
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

  const sig = scope === "favorites" ? favoritesSignature(photos.map((p) => p.id)) : "all";
  const cacheKey = buildCacheKey(token, scope, variant, new Date());

  // Cache lookup. Same-day signature match → presigned redirect.
  try {
    const head = await headObject(cacheKey);
    const cachedSig = head.Metadata?.["favorites_signature"];
    if (cachedSig === sig) {
      const presigned = await getPresignedUrl(cacheKey, 3600);
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
    }
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
        favorites_signature: sig,
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

  // Byte total — always orig_bytes now that imgproxy resizes everything
  // on demand. The legacy `large_bytes` column is preserved for rollback
  // visibility but no longer used by the export path.
  const sizeRow = await sql<{ total: string | null }[]>`
    SELECT COALESCE(SUM(orig_bytes), 0)::text AS total
      FROM photos
     WHERE id = ANY(${photos.map((p) => p.id)}::uuid[])
  `;
  const totalBytes = Number(sizeRow[0]?.total ?? 0);
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
      "Content-Disposition": `attachment; filename="${token}-${scope}-${variant}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

// Avoid unused-import lint warnings from the lib-storage type import above.
void PutObjectCommand;
