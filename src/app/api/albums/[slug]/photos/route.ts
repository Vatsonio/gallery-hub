import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/session";
import { getAlbumBySlug, listPhotos, getAlbumWatermark } from "@/lib/albums";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { imgproxyThumb, imgproxyWeb, imgproxyLarge, photoVersionSeed } from "@/lib/imgproxy";
import { watermarkKey } from "@/lib/watermarks";

interface Ctx { params: Promise<{ slug: string }>; }

/**
 * Admin endpoint feeding the album grid. Returns a thumb_url / web_url /
 * large_url triple per photo so the existing PhotoGrid / PhotoEditModal
 * code keeps reading the same shape — but every URL now resolves through
 * imgproxy, not a presigned MinIO variant.
 *
 * Photos in `status='processing'` get nulled URLs so the grid renders the
 * status badge until the worker flips the row to ready (~80–120ms after
 * finalize in the imgproxy era).
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });

  const { slug } = await ctx.params;
  const album = await getAlbumBySlug(slug);
  if (!album) return NextResponse.json({ error: "not found" }, { status: 404 });

  const photos = await listPhotos(album.id);
  // Admin grid intentionally renders the unwatermarked variants — the admin
  // is the photographer, and the watermark is for client-facing share
  // links, not the back-office preview.
  void getAlbumWatermark;
  void watermarkKey;

  const decorated = photos.map((p) => {
    if (p.status !== "ready") {
      return { ...p, thumb_url: null, web_url: null, large_url: null };
    }
    const origKey = originalKey(album.id, p.id, resolveOriginalExt(p.filename));
    const version = photoVersionSeed(p.updated_at);
    return {
      ...p,
      thumb_url: imgproxyThumb(origKey, { version }),
      web_url: imgproxyWeb(origKey, { version }),
      large_url: imgproxyLarge(origKey, { version }),
    };
  });

  return NextResponse.json({ album, photos: decorated });
}
