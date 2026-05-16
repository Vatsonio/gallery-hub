import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import {
  notifyFirstShareView,
  recordIpTokenHit,
} from "@/lib/notifications";
import {
  resolveShareLinkStatus,
  unlockCookieName,
} from "@/lib/share";
import { listPhotos, getAlbumById, getAlbumWatermark } from "@/lib/albums";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { imgproxyWeb, imgproxyLarge, imgproxySrcset, photoVersionSeed } from "@/lib/imgproxy";
import { thumbhashToDataUrl } from "@/lib/thumbhash";
import { watermarkKey } from "@/lib/watermarks";
import { layoutJustifiedRows } from "@/lib/justified";
import {
  ADMIN_PREVIEW_VIEWER_ID,
  VIEWER_COOKIE,
} from "@/lib/viewer";
import { listFavoritePhotoIds } from "@/lib/favorites";
import { requireAdminSessionFromCookies } from "@/lib/session";
import { computeExportSizes } from "@/lib/exportSizes";
import { safeCapture } from "@/lib/analytics";
import { createRateLimiter } from "@/lib/rateLimiter";
import { resolveIpFromHeaders } from "@/lib/client-ip";
import PhotoTile from "@/components/gallery/PhotoTile";
import CoverImage from "@/components/gallery/CoverImage";
import GalleryShell from "./_gallery-shell";

// F6 — per-IP-per-token defense-in-depth on the share landing. Tokens are
// 12 chars of base64url (~72 bits) so guessing is mathematically out of
// reach, but a leaked token must not be scrapable without throttle, and a
// future change to token length / alphabet would silently lose the only
// line of defense if no limiter ever existed here.
const shareViewLimiter = createRateLimiter({ max: 60, windowMs: 60_000 });

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function PublicGalleryPage({ params }: Props) {
  const { token } = await params;

  // F6 — rate-limit anonymous share views (per token x IP / 60 / 60s).
  const ip = resolveIpFromHeaders(await headers());
  if (!shareViewLimiter.allow(`share:${token}:${ip}`)) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl font-light tracking-wide">429</div>
          <div className="mt-2 text-white/60">Too many requests. Please slow down.</div>
        </div>
      </main>
    );
  }

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

  // Resolve the album-level watermark once. The PNG (rendered + uploaded on
  // first toggle by AlbumSettingsPanel's server action) lives at
  // watermarks/{albumId}.png; imgproxy composites it onto every resized
  // variant via the wm_url processing step.
  const albumWatermark = await getAlbumWatermark(album.id);
  const watermarkRef = albumWatermark.enabled ? { key: watermarkKey(album.id) } : null;

  const [decorated, favoriteIds] = await Promise.all([
    Promise.resolve(
      photos.map((p) => {
        const origKey = originalKey(album.id, p.id, resolveOriginalExt(p.filename));
        const version = photoVersionSeed(p.updated_at);
        // 400/800/1600 trio is the sweet spot for justified-row tile sizes:
        // - 400w covers mobile 2-per-row (~187 CSS px × 2 DPR ≈ 374 px)
        // - 800w covers tablet 3-per-row + retina mobile lightbox previews
        // - 1600w covers desktop hero rows and HiDPI panels
        // We bake the watermark / version params into every variant so the
        // entire ladder invalidates atomically on watermark toggle / edit.
        const srcset = imgproxySrcset(origKey, [400, 800, 1600], {
          version,
          watermark: watermarkRef,
        });
        return {
          ...p,
          // `web_url` is the 1600w fallback; modern browsers pick from
          // srcset, IE11/old spiders hit this URL.
          web_url: srcset.src,
          web_srcset: srcset.srcSet,
          // imgproxy negotiates format from the Accept header (AVIF→WEBP→JPEG)
          // so the <picture> <source type="image/avif"> dance is no longer
          // needed. Pass null through so the renderer skips the AVIF branch.
          avif_url: null as string | null,
          thumbhash_url: thumbhashToDataUrl(p.thumbhash),
        };
      }),
    ),
    listFavoritePhotoIds(token, viewerId),
  ]);
  const favSet = new Set(favoriteIds);

  // Cover hero: prefer album.cover_photo_id, fall back to the first ready photo.
  const coverPhoto =
    decorated.find((p) => p.id === album.cover_photo_id) ?? decorated[0] ?? null;
  const coverUrl = coverPhoto
    ? imgproxyLarge(
        originalKey(album.id, coverPhoto.id, resolveOriginalExt(coverPhoto.filename)),
        { version: photoVersionSeed(coverPhoto.updated_at), watermark: watermarkRef },
      )
    : null;
  // Accept-header negotiation means we no longer hand the browser two
  // separate (WEBP + AVIF) URLs — imgproxy picks per request.
  const coverAvifUrl: string | null = null;

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
  // Stable index map for grid-stagger fade-in (CSS --i var).
  const photoIndex = new Map(decorated.map((p, i) => [p.id, i]));

  // Page-view dedupe: skip the insert if the same viewer recorded a
  // page_view in the last 30 minutes. Prevents F5 / lightbox-close
  // re-renders from inflating admin view counts. Admin previews never
  // log here because viewerId === ADMIN_PREVIEW_VIEWER_ID; we still
  // guard explicitly so an accidental sentinel write is a no-op.
  if (viewerId !== ADMIN_PREVIEW_VIEWER_ID) {
    // Detect first-ever view for this share token BEFORE the insert,
    // so the dedup check below doesn't race against it. Notifications
    // are fire-and-forget — we don't await the dispatch.
    const priorViews = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n
        FROM view_events
       WHERE share_token = ${token}
         AND event_type = 'page_view'
    `.catch(() => [{ n: "1" }] as { n: string }[]);
    const isFirstView = Number(priorViews[0]?.n ?? "0") === 0;

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
    safeCapture({
      distinctId: viewerId,
      event: "gallery_view",
      properties: {
        share_token: token,
        album_id: album.id,
        album_title: album.title,
        photo_count: decorated.length,
      },
    });

    if (isFirstView) {
      void notifyFirstShareView({
        album_title: album.title,
        share_token: token,
        viewer_id: viewerId,
      });
    }

    // Suspicious-IP detection. The IP comes from CF-Connecting-IP behind
    // Cloudflare; fall back to X-Forwarded-For's first hop, then the
    // empty string (skip detection if no header is present).
    const h = await headers();
    const ip =
      h.get("cf-connecting-ip") ??
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "";
    if (ip) {
      void recordIpTokenHit(ip, token);
    }
  }

  const exportSizes = await computeExportSizes(token, viewerId, album.id);

  return (
    <GalleryShell
      token={token}
      favoritesCount={favoriteIds.length}
      exportSizes={exportSizes}
      isAdminPreview={adminSession.ok}
    >
      <main>
        {coverPhoto && coverUrl ? (
          <section className="relative w-full max-h-[60vh] sm:max-h-[85vh] overflow-hidden">
            <div className="relative w-full max-h-[60vh] sm:max-h-[85vh]">
              {/*
                Preload the cover so the browser starts fetching during HTML
                parse (before React hydration). fetchPriority="high" and
                decoding="sync" let the browser bias network + decode work
                toward the LCP image. When AVIF exists, preload that instead
                of the WEBP — the imagesrcset would be ideal but isn't widely
                honored, so we preload the lighter variant directly.
              */}
              <link
                rel="preload"
                as="image"
                href={coverAvifUrl ?? coverUrl}
                fetchPriority="high"
              />
              <CoverImage
                src={coverUrl}
                avifSrc={coverAvifUrl}
                className="w-full object-cover max-h-[60vh] sm:max-h-[85vh] cover-kenburns"
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
              <div className="sm:hidden flex flex-col gap-0.5 px-0.5">
                {mobileRows.map((row, i) => {
                  const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
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
                            flexStyle={{ flex: `${item.width / totalRowWidth} 0 0` }}
                            initialFavorited={favSet.has(item.id)}
                            index={idx}
                            // W4: only the first 32 tiles get fetchPriority=high
                            // + loading="eager". Everything below that drops to
                            // fetchPriority="low" + loading="lazy" so the
                            // browser saves bandwidth for what the viewer can
                            // actually see.
                            priority={idx < 32}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              {/* Desktop: dense justified rows. */}
              <div className="hidden sm:flex flex-col gap-1 px-1">
                {desktopRows.map((row, i) => {
                  const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
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
                            flexStyle={{ flex: `${item.width / totalRowWidth} 0 0` }}
                            initialFavorited={favSet.has(item.id)}
                            index={idx}
                            // W4: only the first 32 tiles get fetchPriority=high
                            // + loading="eager". Everything below that drops to
                            // fetchPriority="low" + loading="lazy" so the
                            // browser saves bandwidth for what the viewer can
                            // actually see.
                            priority={idx < 32}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </main>
    </GalleryShell>
  );
}
