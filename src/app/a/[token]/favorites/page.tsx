import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  resolveShareLinkStatus,
  unlockCookieName,
} from "@/lib/share";
import { listPhotos, getAlbumById, getAlbumWatermark } from "@/lib/albums";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { imgproxySrcset, photoVersionSeed } from "@/lib/imgproxy";
import { watermarkKey } from "@/lib/watermarks";
import { thumbhashToDataUrl } from "@/lib/thumbhash";
import { layoutJustifiedRows } from "@/lib/justified";
import {
  ADMIN_PREVIEW_VIEWER_ID,
  VIEWER_COOKIE,
} from "@/lib/viewer";
import { listFavoritePhotoIds } from "@/lib/favorites";
import { requireAdminSessionFromCookies } from "@/lib/auth-check";
import { computeExportSizes } from "@/lib/exportSizes";
import { safeCapture } from "@/lib/analytics";
import PhotoTile from "@/components/gallery/PhotoTile";
import GalleryShell from "../_gallery-shell";
import ViewerHydration from "@/components/gallery/ViewerHydration";
import { ExportSizesHydration } from "@/components/gallery/ExportSizesContext";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / 1_000_000;
  if (mb < 1) return `${(bytes / 1000).toFixed(0)} KB`;
  if (mb < 1000) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1000).toFixed(1)} GB`;
}

export default async function FavoritesPage({ params }: Props) {
  const { token } = await params;
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);

  if (status.kind === "not_found") notFound();
  if (status.kind === "expired") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl font-light tracking-wide">410</div>
          <div className="mt-2 text-white/60">This share link has expired.</div>
        </div>
      </main>
    );
  }
  if (status.kind === "locked") {
    redirect(`/a/${token}/password`);
  }

  const album = await getAlbumById(status.link.album_id);
  if (!album) notFound();

  // Viewer cookie is minted by middleware. Admin previews fall back to the
  // admin-preview sentinel because middleware skips minting for them.
  const adminSession = await requireAdminSessionFromCookies().catch(() => ({
    ok: false as const,
  }));
  const viewerId = adminSession.ok
    ? ADMIN_PREVIEW_VIEWER_ID
    : (jar.get(VIEWER_COOKIE)?.value ?? ADMIN_PREVIEW_VIEWER_ID);

  const favIds = await listFavoritePhotoIds(token, viewerId);

  // Server-side capture: admin previews are excluded.
  if (viewerId !== ADMIN_PREVIEW_VIEWER_ID) {
    safeCapture({
      distinctId: viewerId,
      event: "favorites_view",
      properties: {
        share_token: token,
        album_id: album.id,
        favorites_count: favIds.length,
      },
    });
  }

  if (favIds.length === 0) {
    const emptySizes = await computeExportSizes(token, viewerId, album.id);
    return (
      <GalleryShell
        token={token}
        staticSizes={emptySizes}
      >
        <ViewerHydration favoriteIds={[]} favoritesCount={0} />
        <ExportSizesHydration sizes={emptySizes} />
        <Header token={token} count={0} />
        <main className="flex flex-col items-center justify-center px-6 py-24 text-center text-white/60 min-h-[60vh]">
          <div className="text-2xl font-light text-white/80">No favorites yet</div>
          <p className="mt-2 max-w-xs text-sm">
            Double-tap photos you love. They&apos;ll collect here.
          </p>
          <Link
            href={`/a/${token}`}
            className="mt-8 inline-flex items-center gap-1 rounded-full bg-[#ff4d6d] hover:bg-[#ff6b85] px-5 py-2 text-sm font-medium text-white transition"
          >
            Browse album
          </Link>
        </main>
      </GalleryShell>
    );
  }

  // Filter album photos to favorites only, preserving favorites order.
  const allPhotos = (await listPhotos(album.id)).filter((p) => p.status === "ready");
  const byId = new Map(allPhotos.map((p) => [p.id, p]));
  const ordered = favIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);

  const albumWatermark = await getAlbumWatermark(album.id);
  const watermarkRef = albumWatermark.enabled ? { key: watermarkKey(album.id) } : null;

  const decorated = ordered.map((p) => {
    const origKey = originalKey(album.id, p.id, resolveOriginalExt(p.filename));
    const version = photoVersionSeed(p.updated_at);
    const srcset = imgproxySrcset(origKey, [400, 800, 1600], {
      version,
      watermark: watermarkRef,
    });
    return {
      ...p,
      web_url: srcset.src,
      web_srcset: srcset.srcSet,
      // Accept-header negotiation removes the need for a separate AVIF URL.
      avif_url: null as string | null,
      thumbhash_url: thumbhashToDataUrl(p.thumbhash),
    };
  });

  const totalBytes = decorated.reduce((s, p) => s + Number(p.orig_bytes ?? 0), 0);
  const sizeLabel = formatBytes(totalBytes);

  const exportSizes = await computeExportSizes(token, viewerId, album.id);

  const desktopRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 1400,
    targetRowHeight: 240,
    gap: 4,
    maxLastRowScale: 1.0,
  });

  const mobileRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 375,
    targetRowHeight: 180,
    gap: 2,
    maxLastRowScale: 1.0,
  });

  const photoMap = new Map(decorated.map((p) => [p.id, p]));
  const photoIndex = new Map(decorated.map((p, i) => [p.id, i]));

  return (
    <GalleryShell
      token={token}
      staticSizes={exportSizes}
    >
      <ViewerHydration favoriteIds={favIds} favoritesCount={favIds.length} />
      <ExportSizesHydration sizes={exportSizes} />
      <Header token={token} count={favIds.length} />
      <div className="mx-auto max-w-screen-2xl">
        {/* Mobile */}
        <div className="sm:hidden flex flex-col gap-0.5 px-0.5">
          {mobileRows.map((row, i) => {
            const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
            const underfilled = i === mobileRows.length - 1 && totalRowWidth < 375 * 0.97;
            return (
              <div
                key={i}
                className="gallery-row flex w-full gap-0.5"
                style={{
                  height: row.height,
                  ["--row-h" as string]: `${Math.round(row.height)}px`,
                }}
              >
                {row.items.map((item) => {
                  const idx = photoIndex.get(item.id) ?? 0;
                  const p = photoMap.get(item.id)!;
                  return (
                    <PhotoTile
                      key={item.id}
                      token={token}
                      photoId={item.id}
                      href={`/a/${token}/p/${item.id}`}
                      webUrl={p.web_url}
                      avifUrl={p.avif_url}
                      srcSet={p.web_srcset}
                      thumbhashDataUrl={p.thumbhash_url}
                      flexStyle={
                        underfilled
                          ? { flex: `0 0 ${item.width}px` }
                          : { flex: `${item.width / totalRowWidth} 0 0` }
                      }
                      initialFavorited={true}
                      index={idx}
                      priority={idx < 32 ? "high" : "low"}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
        {/* Desktop */}
        <div className="hidden sm:flex flex-col gap-1 px-1 py-4">
          {desktopRows.map((row, i) => {
            const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
            const underfilled = i === desktopRows.length - 1 && totalRowWidth < 1400 * 0.97;
            return (
              <div
                key={i}
                className="gallery-row flex w-full gap-1"
                style={{
                  height: row.height,
                  ["--row-h" as string]: `${Math.round(row.height)}px`,
                }}
              >
                {row.items.map((item) => {
                  const idx = photoIndex.get(item.id) ?? 0;
                  const p = photoMap.get(item.id)!;
                  return (
                    <PhotoTile
                      key={item.id}
                      token={token}
                      photoId={item.id}
                      href={`/a/${token}/p/${item.id}`}
                      webUrl={p.web_url}
                      avifUrl={p.avif_url}
                      srcSet={p.web_srcset}
                      thumbhashDataUrl={p.thumbhash_url}
                      flexStyle={
                        underfilled
                          ? { flex: `0 0 ${item.width}px` }
                          : { flex: `${item.width / totalRowWidth} 0 0` }
                      }
                      initialFavorited={true}
                      index={idx}
                      priority={idx < 32 ? "high" : "low"}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </GalleryShell>
  );
}

function Header({ token, count }: { token: string; count: number }) {
  return (
    <header className="flex items-center gap-3 px-4 py-6 sm:px-8 sm:py-10">
      <Link
        href={`/a/${token}`}
        className="text-white/70 hover:text-white transition"
        aria-label="Back to gallery"
      >
        <ChevronLeft className="h-6 w-6" />
      </Link>
      <div className="flex-1">
        <h1 className="text-xl sm:text-3xl font-light tracking-tight text-white">
          Favorites
        </h1>
        <p className="text-xs text-white/50 mt-0.5">
          {count} photo{count === 1 ? "" : "s"} hearted
        </p>
      </div>
    </header>
  );
}
