import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  resolveShareLinkStatus,
  unlockCookieName,
} from "@/lib/share";
import { listPhotos, getAlbumById } from "@/lib/albums";
import { presignGet, IMMUTABLE_VARIANT_CACHE_CONTROL } from "@/lib/presign";
import { variantKey } from "@/lib/keys";
import { layoutJustifiedRows } from "@/lib/justified";
import {
  ADMIN_PREVIEW_VIEWER_ID,
  VIEWER_COOKIE,
} from "@/lib/viewer";
import { listFavoritePhotoIds } from "@/lib/favorites";
import { requireAdminSessionFromCookies } from "@/lib/session";
import { computeExportSizes } from "@/lib/exportSizes";
import PhotoTile from "@/components/gallery/PhotoTile";
import GalleryShell from "../_gallery-shell";

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

  if (favIds.length === 0) {
    const emptySizes = await computeExportSizes(token, viewerId, album.id);
    return (
      <GalleryShell
        token={token}
        favoritesCount={0}
        exportSizes={emptySizes}
        isAdminPreview={adminSession.ok}
      >
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

  const decorated = await Promise.all(
    ordered.map(async (p) => ({
      ...p,
      web_url: await presignGet(variantKey(album.id, p.id, "web"), 3600, {
        responseCacheControl: IMMUTABLE_VARIANT_CACHE_CONTROL,
      }),
    })),
  );

  const totalBytes = decorated.reduce((s, p) => s + Number(p.orig_bytes ?? 0), 0);
  const sizeLabel = formatBytes(totalBytes);

  const exportSizes = await computeExportSizes(token, viewerId, album.id);

  const desktopRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 1400,
    targetRowHeight: 240,
    gap: 4,
    maxLastRowScale: 1.5,
  });

  const mobileRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 375,
    targetRowHeight: 180,
    gap: 2,
    maxLastRowScale: 1.5,
  });

  const photoMap = new Map(decorated.map((p) => [p.id, p]));
  const photoIndex = new Map(decorated.map((p, i) => [p.id, i]));

  return (
    <GalleryShell
      token={token}
      favoritesCount={favIds.length}
      favoritesSizeLabel={sizeLabel}
      exportSizes={exportSizes}
      isAdminPreview={adminSession.ok}
    >
      <Header token={token} count={favIds.length} />
      <div className="mx-auto max-w-screen-2xl">
        {/* Mobile */}
        <div className="sm:hidden flex flex-col gap-0.5 px-0.5">
          {mobileRows.map((row, i) => {
            const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
            return (
              <div
                key={i}
                className="flex w-full gap-0.5"
                style={{ height: row.height }}
              >
                {row.items.map((item) => (
                  <PhotoTile
                    key={item.id}
                    token={token}
                    photoId={item.id}
                    href={`/a/${token}/p/${item.id}`}
                    webUrl={photoMap.get(item.id)!.web_url}
                    flexStyle={{ flex: `${item.width / totalRowWidth} 0 0` }}
                    initialFavorited={true}
                    index={photoIndex.get(item.id) ?? 0}
                  />
                ))}
              </div>
            );
          })}
        </div>
        {/* Desktop */}
        <div className="hidden sm:flex flex-col gap-1 px-1 py-4">
          {desktopRows.map((row, i) => {
            const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
            return (
              <div key={i} className="flex w-full gap-1" style={{ height: row.height }}>
                {row.items.map((item) => (
                  <PhotoTile
                    key={item.id}
                    token={token}
                    photoId={item.id}
                    href={`/a/${token}/p/${item.id}`}
                    webUrl={photoMap.get(item.id)!.web_url}
                    flexStyle={{ flex: `${item.width / totalRowWidth} 0 0` }}
                    initialFavorited={true}
                    index={photoIndex.get(item.id) ?? 0}
                  />
                ))}
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
