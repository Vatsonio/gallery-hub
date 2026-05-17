import { NextResponse, type NextRequest } from "next/server";
import { cookies, headers } from "next/headers";
import { sql } from "@/lib/db";
import {
  resolveShareLinkStatus,
  unlockCookieName,
} from "@/lib/share";
import { getAlbumById } from "@/lib/albums";
import {
  ADMIN_PREVIEW_VIEWER_ID,
  VIEWER_COOKIE,
} from "@/lib/viewer";
import { requireAdminSessionFromCookies } from "@/lib/session";
import { listFavoritePhotoIds } from "@/lib/favorites";
import { computeExportSizes, type ExportSizes } from "@/lib/exportSizes";
import { safeCapture } from "@/lib/analytics";
import { notifyFirstShareView, recordIpTokenHit } from "@/lib/notifications";
import { createRateLimiter } from "@/lib/rateLimiter";
import { resolveIpFromHeaders } from "@/lib/client-ip";

/**
 * Per-IP-per-token throttle on the viewer-context endpoint. Mirrors the
 * limiter that used to gate the share page render before the static
 * prerender + client-fetch split landed.
 */
const viewerContextLimiter = createRateLimiter({ max: 60, windowMs: 60_000 });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ViewerContextPayload {
  favoriteIds: string[];
  favoritesCount: number;
  isAdminPreview: boolean;
  exportSizes: ExportSizes;
}

/**
 * Returns the per-viewer state the static share-page shell can't compute
 * (cookies + favorites + export bytes + admin-preview banner). Side
 * effects (view_events insert, first-view notification, suspicious-IP
 * tally) live here too so the static HTML never bakes per-request data.
 *
 * Caller: ViewerLayer (client component) calls this exactly once on mount.
 * The static HTML cached by Next/CF stays viewer-agnostic.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  void req;

  const h = await headers();
  const ip = resolveIpFromHeaders(h);
  if (!viewerContextLimiter.allow(`viewer-ctx:${token}:${ip}`)) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);
  if (status.kind === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (status.kind === "expired") {
    return NextResponse.json({ error: "expired" }, { status: 410 });
  }
  if (status.kind === "locked") {
    return NextResponse.json({ error: "locked" }, { status: 401 });
  }

  const album = await getAlbumById(status.link.album_id);
  if (!album) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const adminSession = await requireAdminSessionFromCookies().catch(() => ({
    ok: false as const,
  }));
  const isAdminPreview = adminSession.ok;
  const viewerId = isAdminPreview
    ? ADMIN_PREVIEW_VIEWER_ID
    : (jar.get(VIEWER_COOKIE)?.value ?? ADMIN_PREVIEW_VIEWER_ID);

  const [favoriteIds, exportSizes] = await Promise.all([
    listFavoritePhotoIds(token, viewerId),
    computeExportSizes(token, viewerId, album.id),
  ]);

  if (viewerId !== ADMIN_PREVIEW_VIEWER_ID) {
    // View dedup: 30-min window per (token, viewer). Notifications fire only
    // on the *first ever* page_view for a token — we count before insert so
    // the dedup check doesn't race against itself.
    const priorViews = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n
        FROM view_events
       WHERE share_token = ${token}
         AND event_type = 'page_view'
    `.catch(() => [{ n: "1" }] as { n: string }[]);
    const isFirstView = Number(priorViews[0]?.n ?? "0") === 0;

    await sql`
      INSERT INTO view_events (share_token, viewer_id, event_type)
      SELECT ${token}, ${viewerId}, 'page_view'
       WHERE NOT EXISTS (
         SELECT 1 FROM view_events
          WHERE share_token = ${token}
            AND viewer_id = ${viewerId}
            AND event_type = 'page_view'
            AND created_at > NOW() - INTERVAL '30 minutes'
       )
    `.catch(() => undefined);

    safeCapture({
      distinctId: viewerId,
      event: "gallery_view",
      properties: {
        share_token: token,
        album_id: album.id,
        album_title: album.title,
      },
    });

    if (isFirstView) {
      void notifyFirstShareView({
        album_title: album.title,
        share_token: token,
        viewer_id: viewerId,
      });
    }

    const sourceIp =
      h.get("cf-connecting-ip") ??
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "";
    if (sourceIp) {
      void recordIpTokenHit(sourceIp, token);
    }
  }

  const body: ViewerContextPayload = {
    favoriteIds,
    favoritesCount: favoriteIds.length,
    isAdminPreview,
    exportSizes,
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
