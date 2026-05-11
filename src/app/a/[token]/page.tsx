import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import {
  resolveShareLinkStatus,
  unlockCookieName,
} from "@/lib/share";
import { listPhotos, getAlbumById } from "@/lib/albums";
import { presignGet } from "@/lib/presign";
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
import GalleryShell from "./_gallery-shell";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function PublicGalleryPage({ params }: Props) {
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

  // Resolve viewer id. The gh_viewer cookie is minted by middleware before
  // the page renders, so here we only read. Admin previews never get a
  // viewer cookie (middleware skips minting when an admin session is
  // present) — they fall back to the admin-preview sentinel.
  const adminSession = await requireAdminSessionFromCookies().catch(() => ({
    ok: false as const,
  }));
  const viewerId = adminSession.ok
    ? ADMIN_PREVIEW_VIEWER_ID
    : (jar.get(VIEWER_COOKIE)?.value ?? ADMIN_PREVIEW_VIEWER_ID);

  const photos = (await listPhotos(album.id)).filter((p) => p.status === "ready");
  const [decorated, favoriteIds] = await Promise.all([
    Promise.all(
      photos.map(async (p) => ({
        ...p,
        web_url: await presignGet(variantKey(album.id, p.id, "web"), 3600),
      })),
    ),
    listFavoritePhotoIds(token, viewerId),
  ]);
  const favSet = new Set(favoriteIds);

  // Cover hero: prefer album.cover_photo_id, fall back to the first ready photo.
  const coverPhoto =
    decorated.find((p) => p.id === album.cover_photo_id) ?? decorated[0] ?? null;
  const coverUrl = coverPhoto
    ? await presignGet(variantKey(album.id, coverPhoto.id, "large"), 3600)
    : null;

  // Compute TWO justified-rows layouts so mobile gets 2-photo rows and desktop
  // keeps the dense reference layout. flex-basis lets CSS scale either to viewport.
  const desktopRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 1400,
    targetRowHeight: 280,
    gap: 4,
    maxLastRowScale: 1.5,
  });

  const mobileRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 375,
    targetRowHeight: 200,
    gap: 2,
    maxLastRowScale: 1.5,
  });

  const photoMap = new Map(decorated.map((p) => [p.id, p]));

  // Page-view dedupe: skip the insert if the same viewer recorded a
  // page_view in the last 30 minutes. Prevents F5 / lightbox-close
  // re-renders from inflating admin view counts. Admin previews never
  // log here because viewerId === ADMIN_PREVIEW_VIEWER_ID; we still
  // guard explicitly so an accidental sentinel write is a no-op.
  if (viewerId !== ADMIN_PREVIEW_VIEWER_ID) {
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
  }

  const exportSizes = await computeExportSizes(token, viewerId, album.id);

  return (
    <GalleryShell
      token={token}
      favoritesCount={favoriteIds.length}
      exportSizes={exportSizes}
    >
      <main>
        {coverPhoto && coverUrl ? (
          <section className="relative w-full max-h-[60vh] sm:max-h-[85vh] overflow-hidden">
            <div className="relative w-full max-h-[60vh] sm:max-h-[85vh]">
              <img
                src={coverUrl}
                alt=""
                className="w-full object-cover max-h-[60vh] sm:max-h-[85vh]"
              />
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
              <div className="absolute inset-x-0 bottom-0 px-6 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:pb-16 text-center">
                <h1 className="text-3xl sm:text-5xl font-light tracking-tight text-white drop-shadow">
                  {album.title}
                </h1>
                {album.subtitle && (
                  <p className="mt-3 text-sm text-white/80 tracking-widest uppercase">
                    {album.subtitle}
                  </p>
                )}
                <p className="mt-4 text-xs text-white/60">
                  {decorated.length} photo{decorated.length === 1 ? "" : "s"}
                </p>
              </div>
            </div>
          </section>
        ) : (
          <header className="px-6 py-12 sm:py-16 text-center">
            <h1 className="text-3xl sm:text-5xl font-light tracking-tight">{album.title}</h1>
            {album.subtitle && (
              <p className="mt-3 text-sm text-white/60 tracking-widest uppercase">{album.subtitle}</p>
            )}
          </header>
        )}

        <div className="mx-auto max-w-screen-2xl">
          {decorated.length === 0 ? (
            <p className="text-center text-white/40 py-20">
              Photos are still being processed. Refresh in a moment.
            </p>
          ) : (
            <>
              {/* Mobile: tighter rows, smaller target height yields ~2 photos/row at 375px. */}
              <div className="sm:hidden flex flex-col gap-0.5 px-0.5 py-4 pb-[max(6rem,env(safe-area-inset-bottom))]">
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
                          initialFavorited={favSet.has(item.id)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              {/* Desktop: dense justified rows. */}
              <div className="hidden sm:flex flex-col gap-1 px-1 py-8 pb-16">
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
                          initialFavorited={favSet.has(item.id)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <footer className="text-center text-xs text-white/30 pb-8">gallery.divass.space</footer>
        </div>
      </main>
    </GalleryShell>
  );
}
