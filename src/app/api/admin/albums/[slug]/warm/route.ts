/**
 * POST /api/admin/albums/[slug]/warm — re-warm imgproxy for every photo in
 * the album.
 *
 * Why this exists:
 *   - Old albums (uploaded pre-W1 / pre-imgproxy migration) never had their
 *     variants pre-warmed; the first viewer pays the cold-encode cost.
 *   - Photographers occasionally want a "make sure clients see instant
 *     photos before tomorrow's shoot" button without re-uploading.
 *
 * Behaviour:
 *   - Auth-gated (admin session).
 *   - Streams a JSON status with `{ warmed, total }` after the run.
 *   - Awaits the warm queue so the UI can show a progress count — unlike
 *     finalize where we fire-and-forget. A 150-photo warm at concurrency 6
 *     completes in ~10-15 s on a cold imgproxy and ~1 s on a warm one.
 *   - The warming itself reuses `warmImgproxyVariants` so the URL ladder
 *     stays in lockstep with on-demand renders.
 */
import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-check";
import { isSameOrigin } from "@/lib/same-origin";
import { getAlbumBySlug, listPhotoIdsForRegeneration } from "@/lib/albums";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { warmImgproxyVariants, isImgproxyEnabled } from "@/lib/imgproxy";

interface Params {
  params: Promise<{ slug: string }>;
}

export interface WarmAlbumResponse {
  warmed: number;
  total: number;
  skipped?: "imgproxy-disabled";
}

export async function POST(req: Request, ctx: Params): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  const { slug } = await ctx.params;
  const album = await getAlbumBySlug(slug);
  if (!album) return NextResponse.json({ error: "album not found" }, { status: 404 });

  if (!isImgproxyEnabled()) {
    const resp: WarmAlbumResponse = { warmed: 0, total: 0, skipped: "imgproxy-disabled" };
    return NextResponse.json(resp);
  }

  // We warm every photo that has *any* uploaded original — both `ready` and
  // `processing` rows. The latter is harmless: if the original blob exists,
  // imgproxy will happily resize it; if not, the warm fails silently.
  const photos = await listPhotoIdsForRegeneration(album.id);
  if (photos.length === 0) {
    return NextResponse.json({ warmed: 0, total: 0 } satisfies WarmAlbumResponse);
  }

  const items = photos.map((p) => ({
    s3Key: originalKey(album.id, p.id, resolveOriginalExt(p.filename)),
  }));

  // Concurrency 6 mirrors the finalize-time warm — high enough to overlap
  // network/CPU, low enough to leave headroom for legitimate viewers
  // hitting imgproxy in parallel.
  await warmImgproxyVariants(items, { concurrency: 6 });

  const resp: WarmAlbumResponse = { warmed: items.length, total: items.length };
  return NextResponse.json(resp);
}
