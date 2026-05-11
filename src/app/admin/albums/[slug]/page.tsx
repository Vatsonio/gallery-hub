import { notFound } from "next/navigation";
import { getAlbumBySlug, listPhotos } from "@/lib/albums";
import { StatsStrip } from "@/components/admin/StatsStrip";
import { Dropzone } from "@/components/admin/Dropzone";
import { PhotoGrid } from "@/components/admin/PhotoGrid";
import { AlbumForm } from "@/components/admin/AlbumForm";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

interface Props { params: Promise<{ slug: string }>; }

export default async function AlbumDetailPage({ params }: Props) {
  const { slug } = await params;
  const album = await getAlbumBySlug(slug);
  if (!album) notFound();
  const photos = await listPhotos(album.id);

  return (
    <div className="space-y-8 p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Badge className="mb-2 bg-zinc-800 text-zinc-300">{album.status}</Badge>
          <h1 className="text-2xl font-light tracking-wide text-white">{album.title}</h1>
          {album.subtitle && <p className="text-sm text-zinc-400">{album.subtitle}</p>}
        </div>
      </header>

      <StatsStrip photos={photos.length} views={0} favorites={0} downloads={0} />

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">Upload</h2>
        <Dropzone albumId={album.id} onComplete={() => { /* PhotoGrid polls on its own */ }} />
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
