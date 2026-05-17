import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Heart } from "lucide-react";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-check";
import { getAlbumBySlug, listPhotos } from "@/lib/albums";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { imgproxyThumb, photoVersionSeed } from "@/lib/imgproxy";
import { favoriteCountsByPhoto } from "@/lib/favorites";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ albumSlug: string }>;
  searchParams: Promise<{ viewer?: string }>;
}

/**
 * Per-album preview showing every photo with a heart overlay for the
 * specified anonymous viewer (or aggregate counts when no viewer is
 * specified). Admin-only.
 */
export default async function SelectionsAlbumPage({
  params,
  searchParams,
}: Props) {
  await requireAdmin();
  const { albumSlug } = await params;
  const { viewer } = await searchParams;

  const album = await getAlbumBySlug(albumSlug);
  if (!album) notFound();

  // Find a share link for this album (there may be many; we just need
  // one to attribute favorites against). Selections-per-viewer queries
  // are scoped to a single share token in the data model.
  const tokenRow = await sql<{ token: string }[]>`
    SELECT token FROM share_links WHERE album_id = ${album.id} LIMIT 1
  `;
  const token = tokenRow[0]?.token ?? null;

  const photos = (await listPhotos(album.id)).filter((p) => p.status === "ready");
  const tiles = photos.map((p) => ({
    id: p.id,
    thumbUrl: imgproxyThumb(
      originalKey(album.id, p.id, resolveOriginalExt(p.filename)),
      { version: photoVersionSeed(p.updated_at) },
    ),
  }));

  // Per-viewer heart set (when filtering) + aggregate counts for the
  // small badge under each photo.
  let viewerHearts = new Set<string>();
  if (token && viewer) {
    const favRows = await sql<{ photo_id: string }[]>`
      SELECT photo_id FROM favorites
      WHERE share_token = ${token} AND viewer_id = ${viewer}
    `;
    viewerHearts = new Set(favRows.map((r) => r.photo_id));
  }
  const aggregate = token
    ? await favoriteCountsByPhoto(token)
    : new Map<string, number>();

  const heartedCount = viewer
    ? viewerHearts.size
    : Array.from(aggregate.values()).reduce((s, n) => s + n, 0);

  return (
    <div className="p-6 max-w-screen-xl">
      <div className="flex items-center gap-3">
        <Link
          href="/admin/selections"
          className="text-text-muted hover:text-text transition"
          aria-label="Back"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-light text-white">{album.title}</h1>
          <p className="text-sm text-text-muted">
            {viewer ? (
              <>
                Viewer{" "}
                <span className="font-mono">{viewer.slice(0, 8)}…</span> —{" "}
                <span className="text-[#ff4d6d]">{heartedCount}</span> of{" "}
                {tiles.length} hearted.
              </>
            ) : (
              <>
                Aggregate selections — {heartedCount} total hearts across{" "}
                {tiles.length} photos.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
        {tiles.map((t) => {
          const liked = viewerHearts.has(t.id);
          const count = aggregate.get(t.id) ?? 0;
          return (
            <div
              key={t.id}
              className="relative aspect-square overflow-hidden rounded-md bg-bg-card"
            >
              <img
                src={t.thumbUrl}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
                decoding="async"
              />
              {viewer && liked && (
                <span className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-[#ff4d6d]/95 text-white shadow-lg">
                  <Heart className="h-3.5 w-3.5" fill="currentColor" />
                </span>
              )}
              {!viewer && count > 0 && (
                <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">
                  <Heart
                    className="h-3 w-3"
                    fill="#ff4d6d"
                    color="#ff4d6d"
                  />
                  {count}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
