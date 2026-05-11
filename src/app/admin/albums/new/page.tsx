import { AlbumForm } from "@/components/admin/AlbumForm";

export default function NewAlbumPage() {
  return (
    <div className="mx-auto max-w-xl p-8">
      <h1 className="mb-6 text-2xl font-light tracking-wide text-white">New album</h1>
      <AlbumForm mode="create" />
    </div>
  );
}
