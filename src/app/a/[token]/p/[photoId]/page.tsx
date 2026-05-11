import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { resolveShareLinkStatus } from "@/lib/share";
import { listPhotos, getAlbumById } from "@/lib/albums";
import { presignGet } from "@/lib/presign";
import { variantKey, originalKey } from "@/lib/keys";
import Lightbox from "@/components/gallery/Lightbox";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string; photoId: string }>;
}

function inferExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/);
  if (!m) return "jpg";
  return m[1] === "jpeg" ? "jpg" : m[1];
}

export default async function PublicPhotoPage({ params }: Props) {
  const { token, photoId } = await params;
  const status = await resolveShareLinkStatus(token, null);

  if (status.kind === "not_found") notFound();
  if (status.kind === "expired" || status.kind === "locked") {
    redirect(`/a/${token}`);
  }

  const album = await getAlbumById(status.link.album_id);
  if (!album) notFound();

  const photos = (await listPhotos(album.id)).filter((p) => p.status === "ready");
  const idx = photos.findIndex((p) => p.id === photoId);
  if (idx < 0) notFound();

  const photo = photos[idx];
  const prev = idx > 0 ? photos[idx - 1] : null;
  const next = idx < photos.length - 1 ? photos[idx + 1] : null;

  const largeUrl = await presignGet(variantKey(album.id, photo.id, "large"), 3600);

  let originalUrl: string | null = null;
  if (status.link.allow_download) {
    const ext = inferExt(photo.filename);
    originalUrl = await presignGet(originalKey(album.id, photo.id, ext), 3600);
  }

  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type)
    VALUES (${token}, 'anon', 'photo_view')
  `.catch(() => undefined);

  return (
    <Lightbox
      photoUrl={largeUrl}
      originalUrl={originalUrl}
      downloadFilename={photo.filename}
      prevHref={prev ? `/a/${token}/p/${prev.id}` : null}
      nextHref={next ? `/a/${token}/p/${next.id}` : null}
      backHref={`/a/${token}`}
      index={idx}
      total={photos.length}
    />
  );
}
