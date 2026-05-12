import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
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
import { resolveShareLinkStatus, unlockCookieName } from "@/lib/share";
import { VIEWER_COOKIE } from "@/lib/viewer";
import { createRateLimiter } from "@/lib/rateLimiter";
import { safeCapture } from "@/lib/analytics";

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
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "all") as ExportScope;
  const variant = (url.searchParams.get("variant") ?? "web") as ExportVariant;

  if (!["favorites", "all"].includes(scope) || !["original", "web"].includes(variant)) {
    return new NextResponse("bad params", { status: 400 });
  }

  const jar = await cookies();

  // Validate share link via the shared status resolver (handles expired/locked).
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind === "not_found") return new NextResponse("not found", { status: 404 });
  if (status.kind === "expired") return new NextResponse("expired", { status: 410 });
  if (status.kind === "locked") return new NextResponse("locked", { status: 401 });
  if (!status.link.allow_download) {
    return new NextResponse("download disabled", { status: 403 });
  }

  // Viewer id (set if missing — page would normally have done this).
  let viewerId = jar.get(VIEWER_COOKIE)?.value ?? "";
  if (!viewerId) {
    viewerId = randomUUID();
    jar.set(VIEWER_COOKIE, viewerId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: `/a/${token}`,
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  if (!exportLimiter.allow(`${token}|${viewerId}`)) {
    return new NextResponse("rate limited", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }

  // export_started fires regardless of cache hit/miss so funnels measure
  // intent, not zip-build time. The matching export_completed (with bytes)
  // lands either in the cache-hit branch or after the size lookup below.
  safeCapture({
    distinctId: viewerId,
    event: "export_started",
    properties: { share_token: token, scope, variant },
  });

  // Resolve the photo set.
  let photos: PhotoRow[];
  if (scope === "favorites") {
    photos = await sql<PhotoRow[]>`
      SELECT p.id, p.filename, p.sort_order
        FROM favorites f
        JOIN photos p ON p.id = f.photo_id
       WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
       ORDER BY p.sort_order ASC, p.created_at ASC
    `;
  } else {
    photos = await sql<PhotoRow[]>`
      SELECT id, filename, sort_order FROM photos
       WHERE album_id = ${status.link.album_id} AND status = 'ready'
       ORDER BY sort_order ASC, created_at ASC
    `;
  }
  if (photos.length === 0) {
    return new NextResponse("nothing to export", { status: 404 });
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
      return NextResponse.redirect(presigned, 302);
    }
  } catch {
    // miss — fall through to fresh build
  }

  // Build a fresh ZIP and fan out to both the HTTP response and MinIO.
  const albumId = status.link.album_id;
  async function* gen(): AsyncGenerator<ZipEntry> {
    for (const p of photos) {
      const key = variant === "original"
        ? originalKeyForPhoto(albumId, p.id, p.filename)
        : variantKey(albumId, p.id, "large");
      const body = await getObjectStream(key);
      yield {
        name: `${String(p.sort_order + 1).padStart(3, "0")}-${p.filename}`,
        body,
      };
    }
  }

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

  // Approximate byte total from the per-variant size columns. Falls back to
  // 0 for legacy photos that haven't been backfilled yet.
  const sizeCol = variant === "original" ? "orig_bytes" : "large_bytes";
  const sizeRow = await sql<{ total: string | null }[]>`
    SELECT COALESCE(SUM(${sql.unsafe(sizeCol)}), 0)::text AS total
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
