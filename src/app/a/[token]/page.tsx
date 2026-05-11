import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { resolveShareLinkStatus } from "@/lib/share";
import { listPhotos, getAlbumById } from "@/lib/albums";
import { presignGet } from "@/lib/presign";
import { variantKey } from "@/lib/keys";
import { layoutJustifiedRows } from "@/lib/justified";

export const dynamic = "force-dynamic";

interface Props { params: Promise<{ token: string }>; }

export default async function PublicGalleryPage({ params }: Props) {
  const { token } = await params;
  const status = await resolveShareLinkStatus(token, null);

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
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl font-light tracking-wide">🔒</div>
          <div className="mt-2 text-white/60">Password gate is not yet implemented in this build.</div>
        </div>
      </main>
    );
  }

  const album = await getAlbumById(status.link.album_id);
  if (!album) notFound();

  const photos = (await listPhotos(album.id)).filter((p) => p.status === "ready");
  const decorated = await Promise.all(
    photos.map(async (p) => ({
      ...p,
      web_url: await presignGet(variantKey(album.id, p.id, "web"), 3600),
    })),
  );

  // Cover hero: prefer album.cover_photo_id, fall back to the first ready photo.
  const coverPhoto =
    decorated.find((p) => p.id === album.cover_photo_id) ?? decorated[0] ?? null;
  const coverUrl = coverPhoto
    ? await presignGet(variantKey(album.id, coverPhoto.id, "large"), 3600)
    : null;

  // Compute justified rows from a hardcoded reference width; flex-basis lets CSS scale.
  const rows = layoutJustifiedRows({
    photos: decorated.map((p) => ({ id: p.id, width: p.width, height: p.height })),
    containerWidth: 1400,
    targetRowHeight: 280,
    gap: 4,
    maxLastRowScale: 1.5,
  });

  const photoMap = new Map(decorated.map((p) => [p.id, p]));

  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type)
    VALUES (${token}, 'anon', 'page_view')
  `.catch(() => undefined);

  return (
    <main>
      {coverPhoto && coverUrl ? (
        <section className="relative w-full" style={{ maxHeight: "85vh" }}>
          <div className="relative w-full" style={{ maxHeight: "85vh" }}>
            <img
              src={coverUrl}
              alt=""
              className="w-full object-cover"
              style={{ maxHeight: "85vh" }}
            />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 px-6 pb-10 sm:pb-16 text-center">
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
          <div className="flex flex-col gap-1 px-1 py-8 pb-16">
            {rows.map((row, i) => {
              const totalRowWidth = row.items.reduce((s, it) => s + it.width, 0);
              return (
                <div key={i} className="flex w-full gap-1" style={{ height: row.height }}>
                  {row.items.map((item) => (
                    <Link
                      key={item.id}
                      href={`/a/${token}/p/${item.id}`}
                      style={{ flex: `${item.width / totalRowWidth} 0 0` }}
                      className="block overflow-hidden bg-white/5"
                    >
                      <img
                        src={photoMap.get(item.id)!.web_url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
                      />
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        <footer className="text-center text-xs text-white/30 pb-8">gallery.divass.space</footer>
      </div>
    </main>
  );
}
