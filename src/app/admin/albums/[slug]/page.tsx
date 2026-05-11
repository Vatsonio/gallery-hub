import { notFound } from "next/navigation";
import { getAlbumBySlug, listPhotos } from "@/lib/albums";
import { StatsStrip } from "@/components/admin/StatsStrip";
import { Dropzone } from "@/components/admin/Dropzone";
import { PhotoGrid } from "@/components/admin/PhotoGrid";
import { AlbumForm } from "@/components/admin/AlbumForm";
import { Badge } from "@/components/ui/badge";
import { ShareLinkCard } from "@/components/admin/ShareLinkCard";
import { createShareLink } from "@/lib/share-actions";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

interface Props { params: Promise<{ slug: string }>; }

async function loadShareLinkSummary(albumId: string) {
  const rows = await sql<{
    token: string; expires_at: Date | null; allow_download: boolean; password_hash: string | null;
    views: string; favs: string;
  }[]>`
    SELECT sl.token, sl.expires_at, sl.allow_download, sl.password_hash,
      (SELECT COUNT(*) FROM view_events ve WHERE ve.share_token = sl.token AND ve.event_type = 'page_view')::text AS views,
      (SELECT COUNT(*) FROM favorites f WHERE f.share_token = sl.token)::text AS favs
    FROM share_links sl
    WHERE sl.album_id = ${albumId}
    ORDER BY sl.created_at DESC
    LIMIT 1
  `;
  const r = rows[0];
  return r ? {
    token: r.token,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    allowDownload: r.allow_download,
    hasPassword: r.password_hash !== null,
    viewCount: Number(r.views),
    favoriteCount: Number(r.favs),
  } : null;
}

export default async function AlbumDetailPage({ params }: Props) {
  const { slug } = await params;
  const album = await getAlbumBySlug(slug);
  if (!album) notFound();
  const albumId = album.id;
  const photos = await listPhotos(albumId);
  const link = await loadShareLinkSummary(albumId);

  async function handleCreate() {
    "use server";
    await createShareLink(albumId, {});
  }

  return (
    <div className="space-y-8 p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Badge className="mb-2 bg-zinc-800 text-zinc-300">{album.status}</Badge>
          <h1 className="text-2xl font-light tracking-wide text-white">{album.title}</h1>
          {album.subtitle && <p className="text-sm text-zinc-400">{album.subtitle}</p>}
        </div>
      </header>

      <ShareLinkCard
        publicBaseUrl={process.env.PUBLIC_BASE_URL ?? ""}
        link={link}
        albumId={album.id}
        onCreate={handleCreate}
      />

      <StatsStrip photos={photos.length} views={link?.viewCount ?? 0} favorites={link?.favoriteCount ?? 0} downloads={0} />

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Upload</h2>
        <Dropzone albumId={album.id} onComplete={() => { }} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Photos</h2>
        <PhotoGrid slug={album.slug} />
      </section>

      <section className="border-t border-white/5 pt-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Settings</h2>
        <div className="max-w-xl">
          <AlbumForm mode="edit" initial={{ id: album.id, title: album.title, subtitle: album.subtitle, status: album.status }} />
        </div>
      </section>
    </div>
  );
}
