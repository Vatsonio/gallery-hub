import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { resolveShareLinkStatus } from "@/lib/share";
import { listPhotos, getAlbumById } from "@/lib/albums";
import { presignGet } from "@/lib/presign";
import { variantKey } from "@/lib/keys";

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

  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type)
    VALUES (${token}, 'anon', 'page_view')
  `.catch(() => undefined);

  return (
    <main className="mx-auto max-w-screen-2xl">
      <header className="px-6 py-12 sm:py-16 text-center">
        <h1 className="text-3xl sm:text-5xl font-light tracking-tight">{album.title}</h1>
        {album.subtitle && <p className="mt-3 text-sm text-white/60 tracking-widest uppercase">{album.subtitle}</p>}
        <p className="mt-4 text-xs text-white/40">{decorated.length} photo{decorated.length === 1 ? "" : "s"}</p>
      </header>

      {decorated.length === 0 ? (
        <p className="text-center text-white/40 py-20">Photos are still being processed. Refresh in a moment.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1 px-1 pb-16">
          {decorated.map((p) => (
            <div key={p.id} className="aspect-[3/2] overflow-hidden bg-white/5">
              <img
                src={p.web_url}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
              />
            </div>
          ))}
        </div>
      )}

      <footer className="text-center text-xs text-white/30 pb-8">gallery.divass.space</footer>
    </main>
  );
}
