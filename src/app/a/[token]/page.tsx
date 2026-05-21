import { notFound, redirect } from "next/navigation";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { imgproxyLarge, imgproxySrcset, photoVersionSeed } from "@/lib/imgproxy";
import { thumbhashToDataUrl } from "@/lib/thumbhash";
import { watermarkKey } from "@/lib/watermarks";
import { layoutJustifiedRows } from "@/lib/justified";
import { loadShareData } from "@/lib/shareLoader";
import PhotoTile from "@/components/gallery/PhotoTile";
import CoverImage from "@/components/gallery/CoverImage";
import GalleryShell from "./_gallery-shell";
import ViewerLayer from "./_viewer-layer";

/**
 * ISR-style caching: the static shell of this route — cover, layout,
 * photo URLs, tiles, GalleryShell providers — is rendered once per token
 * and cached on the Next.js cache + the CDN edge for `revalidate` seconds.
 * Per-viewer data (favorites, admin preview, export bytes) is fetched
 * client-side by ViewerLayer via /api/viewer-context/{token}, then
 * hydrated into the existing context providers — so the cached HTML stays
 * viewer-agnostic.
 *
 * Password-protected albums fall back to a redirect (we read the share
 * link without the unlock cookie here, so locked → /password page).
 *
 * Invalidate explicitly with revalidatePath('/a/{token}') from admin
 * actions that change album content (new photo, cover swap, watermark
 * toggle) so viewers don't wait up to N seconds for the new layout.
 */
export const revalidate = 60;

interface Props {
  params: Promise<{ token: string }>;
}

export default async function PublicGalleryPage({ params }: Props) {
  const { token } = await params;

  // Cached per-token loader (unstable_cache wrapper). All DB reads land in
  // Next's full-route cache for `revalidate = 60`, so subsequent hits to
  // the same token render zero queries until the window expires or an
  // admin action calls `revalidateShareLink(token)`.
  const data = await loadShareData(token);

  if (data.kind === "not_found") notFound();
  if (data.kind === "expired") {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl font-light tracking-wide">410</div>
          <div className="mt-2 text-white/60">This share link has expired.</div>
        </div>
      </main>
    );
  }
  if (data.kind === "locked") {
    redirect(`/a/${token}/password`);
  }

  const album = data.album;
  const photos = data.photos;
  const watermarkRef = data.watermarkEnabled ? { key: watermarkKey(album.id) } : null;
  const staticSizes = data.staticSizes;

  const decorated = photos.map((p) => {
    const origKey = originalKey(album.id, p.id, resolveOriginalExt(p.filename));
    const version = photoVersionSeed(p.updated_at);
    // 400/800/1600 trio is the sweet spot for justified-row tile sizes:
    // - 400w covers mobile 2-per-row (~187 CSS px × 2 DPR ≈ 374 px)
    // - 800w covers tablet 3-per-row + retina mobile lightbox previews
    // - 1600w covers desktop hero rows and HiDPI panels
    // Watermark + version baked in so the ladder invalidates atomically
    // on watermark toggle / edit.
    const srcset = imgproxySrcset(origKey, [400, 800, 1600], {
      version,
      watermark: watermarkRef,
    });
    return {
      ...p,
      web_url: srcset.src,
      web_srcset: srcset.srcSet,
      avif_url: null as string | null,
      thumbhash_url: thumbhashToDataUrl(p.thumbhash),
    };
  });

  const coverPhoto =
    decorated.find((p) => p.id === album.cover_photo_id) ?? decorated[0] ?? null;
  const coverUrl = coverPhoto
    ? imgproxyLarge(
        originalKey(album.id, coverPhoto.id, resolveOriginalExt(coverPhoto.filename)),
        { version: photoVersionSeed(coverPhoto.updated_at), watermark: watermarkRef },
      )
    : null;
  const coverAvifUrl: string | null = null;

  const desktopRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 1400,
    targetRowHeight: 280,
    gap: 4,
    // 1.0 keeps the last row at the same height as the rest of the
    // gallery (Flickr / Google Photos convention). Was 1.5 — that let
    // the trailing 2–3 photos balloon to 420px while every prior row
    // sat at 280, which the operator flagged as "стретчнутий" bottom
    // strip. Whitespace on the right of the last row is preferable to
    // a row that visually breaks the grid rhythm.
    maxLastRowScale: 1.0,
  });

  const mobileRows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 375,
    targetRowHeight: 200,
    gap: 2,
    // 1.0 keeps the last row at the same height as the rest of the
    // gallery (Flickr / Google Photos convention). Was 1.5 — that let
    // the trailing 2–3 photos balloon to 420px while every prior row
    // sat at 280, which the operator flagged as "стретчнутий" bottom
    // strip. Whitespace on the right of the last row is preferable to
    // a row that visually breaks the grid rhythm.
    maxLastRowScale: 1.0,
  });

  const photoMap = new Map(decorated.map((p) => [p.id, p]));
  const photoIndex = new Map(decorated.map((p, i) => [p.id, i]));

  return (
    <GalleryShell token={token} staticSizes={staticSizes}>
      <ViewerLayer token={token} />
      <main>
        {coverPhoto && coverUrl ? (
          <section className="relative w-full max-h-[60vh] sm:max-h-[85vh] overflow-hidden">
            <div className="relative w-full max-h-[60vh] sm:max-h-[85vh]">
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
                            initialFavorited={false}
                            index={idx}
                            priority={idx < 32 ? "high" : "low"}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
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
                            initialFavorited={false}
                            index={idx}
                            priority={idx < 32 ? "high" : "low"}
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
