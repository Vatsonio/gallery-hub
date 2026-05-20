import { notFound } from "next/navigation";
import { getAlbumBySlug, listPhotos } from "@/lib/albums";
import { loadAlbumStats } from "@/lib/albumStats";
import { loadSettings } from "@/lib/settings";
import { StatsStrip } from "@/components/admin/StatsStrip";
import AlbumUploadAndGrid from "@/components/admin/AlbumUploadAndGrid";
import { AlbumSettingsPanel } from "@/components/admin/AlbumSettingsPanel";
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
  const [photos, link, stats, settings] = await Promise.all([
    listPhotos(albumId),
    loadShareLinkSummary(albumId),
    loadAlbumStats(albumId),
    loadSettings(),
  ]);
  const albumCapBytes = settings.uploads.max_album_gb > 0
    ? settings.uploads.max_album_gb * 1_000_000_000
    : null;

  async function handleCreate() {
    "use server";
    await createShareLink(albumId, {});
  }

  return (
    <div className="space-y-8 p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge className="bg-zinc-800 text-zinc-300">{album.status}</Badge>
            {album.cover_photo_id && (
              <Badge className="bg-rose-500/15 text-rose-200 ring-1 ring-rose-400/30">Cover set</Badge>
            )}
            {album.watermark_enabled && (
              <Badge className="bg-amber-500/15 text-amber-200 ring-1 ring-amber-400/30">Watermark on</Badge>
            )}
          </div>
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

      <StatsStrip
        photos={photos.length}
        views={link?.viewCount ?? 0}
        favorites={link?.favoriteCount ?? 0}
        downloads={0}
        storageBytes={stats.storage_bytes}
        libraryBytes={stats.library_bytes}
        albumCapBytes={albumCapBytes}
        shotFrom={stats.shot_from}
        shotTo={stats.shot_to}
        topCamera={stats.top_camera}
        topCameraPct={stats.top_camera_pct}
      />

      <AlbumUploadAndGrid albumId={album.id} slug={album.slug} />

      <section className="border-t border-white/5 pt-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Settings</h2>
        <AlbumSettingsPanel album={album} />
      </section>
    </div>
  );
}
