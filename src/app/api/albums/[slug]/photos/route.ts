import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/session";
import { getAlbumBySlug, listPhotos } from "@/lib/albums";
import { presignGet } from "@/lib/presign";
import { variantKey } from "@/lib/keys";

interface Ctx { params: Promise<{ slug: string }>; }

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });

  const { slug } = await ctx.params;
  const album = await getAlbumBySlug(slug);
  if (!album) return NextResponse.json({ error: "not found" }, { status: 404 });

  const photos = await listPhotos(album.id);
  const decorated = await Promise.all(photos.map(async (p) => ({
    ...p,
    thumb_url: p.status === "ready" ? await presignGet(variantKey(album.id, p.id, "thumb"), 3600) : null,
  })));

  return NextResponse.json({ album, photos: decorated });
}
