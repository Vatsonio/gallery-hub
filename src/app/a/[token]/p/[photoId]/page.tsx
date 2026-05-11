import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { resolveShareLinkStatus, unlockCookieName } from "@/lib/share";
import { listPhotos, getAlbumById } from "@/lib/albums";
import { presignGet, contentDispositionAttachment } from "@/lib/presign";
import { variantKey, originalKey } from "@/lib/keys";
import {
  ADMIN_PREVIEW_VIEWER_ID,
  VIEWER_COOKIE,
} from "@/lib/viewer";
import { listFavoritePhotoIds } from "@/lib/favorites";
import { requireAdminSessionFromCookies } from "@/lib/session";
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
  const jar = await cookies();
  const unlocked = jar.get(unlockCookieName(token))?.value ?? null;
  const status = await resolveShareLinkStatus(token, unlocked);

  if (status.kind === "not_found") notFound();
  if (status.kind === "expired") {
    redirect(`/a/${token}`);
  }
  if (status.kind === "locked") {
    redirect(`/a/${token}/password`);
  }

  const album = await getAlbumById(status.link.album_id);
  if (!album) notFound();

  const photos = (await listPhotos(album.id)).filter((p) => p.status === "ready");
  const idx = photos.findIndex((p) => p.id === photoId);
  if (idx < 0) notFound();

  const photo = photos[idx];
  const prev = idx > 0 ? photos[idx - 1] : null;
  const next = idx < photos.length - 1 ? photos[idx + 1] : null;

  // Viewer cookie is minted by middleware. Admin previews skip it and fall
  // back to the admin-preview sentinel.
  const adminSession = await requireAdminSessionFromCookies().catch(() => ({
    ok: false as const,
  }));
  const viewerId = adminSession.ok
    ? ADMIN_PREVIEW_VIEWER_ID
    : (jar.get(VIEWER_COOKIE)?.value ?? ADMIN_PREVIEW_VIEWER_ID);

  const [largeUrl, favIds] = await Promise.all([
    presignGet(variantKey(album.id, photo.id, "large"), 3600),
    listFavoritePhotoIds(token, viewerId),
  ]);

  let originalUrl: string | null = null;
  if (status.link.allow_download) {
    const ext = inferExt(photo.filename);
    // Force a file download with the original filename. Without
    // ResponseContentDisposition the browser may render the image inline
    // (cross-origin presigned URLs make the <a download> attribute
    // a hint that the response can override) — by setting it on the
    // presigned URL we guarantee the Save button writes a file.
    originalUrl = await presignGet(
      originalKey(album.id, photo.id, ext),
      3600,
      {
        responseContentDisposition: contentDispositionAttachment(photo.filename),
      },
    );
  }

  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type, photo_id)
    VALUES (${token}, ${viewerId}, 'photo_view', ${photo.id})
  `.catch(() => undefined);

  return (
    <Lightbox
      token={token}
      photoId={photo.id}
      photoUrl={largeUrl}
      originalUrl={originalUrl}
      downloadFilename={photo.filename}
      prevHref={prev ? `/a/${token}/p/${prev.id}` : null}
      nextHref={next ? `/a/${token}/p/${next.id}` : null}
      backHref={`/a/${token}`}
      index={idx}
      total={photos.length}
      initialFavorited={favIds.includes(photo.id)}
    />
  );
}
