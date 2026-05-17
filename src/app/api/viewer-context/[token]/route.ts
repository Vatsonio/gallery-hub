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
import { requireAdminSessionFromCookies } from "@/lib/auth-check";
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
  // F9: viewer-layer only needs "I can render" vs "I can't". Collapse
  // not_found / expired / locked into one 404 with a generic body so an
  // attacker with a half-leaked token can't fingerprint its state pre-auth.
  if (status.kind !== "ok") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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
    // View dedup: 30-min window per (token, viewer). F7: the prior code
    // SELECT-then-INSERT raced — two simultaneous first viewers both saw
    // prior=0 and both fired notifyFirstShareView. Insert first, then
    // ask "am I the only row?" so the DB serialises the decision.
    const inserted = await sql<{ id: number }[]>`
      INSERT INTO view_events (share_token, viewer_id, event_type)
      SELECT ${token}, ${viewerId}, 'page_view'
       WHERE NOT EXISTS (
         SELECT 1 FROM view_events
          WHERE share_token = ${token}
            AND viewer_id = ${viewerId}
            AND event_type = 'page_view'
            AND created_at > NOW() - INTERVAL '30 minutes'
       )
      RETURNING id
    `.catch(() => [] as { id: number }[]);
    let isFirstView = false;
    if (inserted.length > 0) {
      const cntRows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
          FROM view_events
         WHERE share_token = ${token}
           AND event_type = 'page_view'
      `.catch(() => [{ n: "0" }] as { n: string }[]);
      isFirstView = Number(cntRows[0]?.n ?? "0") === 1;
    }

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

    // F3: use the gated resolver — raw XFF lets an attacker either
    // evade the suspicious-IP tally (rotating XFF) or frame a victim
    // (fixed XFF) when TRUST_PROXY_HEADERS isn't set.
    const sourceIp = resolveIpFromHeaders(h);
    if (sourceIp !== "unknown") {
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
