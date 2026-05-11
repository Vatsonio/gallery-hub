import { listAlbumsWithStats } from "@/lib/albums";
import { AlbumCard } from "@/components/admin/AlbumCard";
import { NewAlbumCard } from "@/components/admin/NewAlbumCard";

export const dynamic = "force-dynamic";

export default async function AlbumsPage() {
  const albums = await listAlbumsWithStats();
  return (
    <div className="p-8">
      <header className="mb-8 flex items-baseline justify-between">
        <h1 className="text-2xl font-light tracking-wide text-white">Albums</h1>
        <p className="text-sm text-zinc-500">{albums.length} total</p>
      </header>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <NewAlbumCard />
        {albums.map((a) => <AlbumCard key={a.id} album={a} />)}
      </div>
    </div>
  );
}
