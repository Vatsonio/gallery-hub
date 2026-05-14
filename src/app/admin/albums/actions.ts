"use server";
import { revalidatePath } from "next/cache";
import { requireAdminSessionFromCookies } from "@/lib/session";
import {
  createAlbum, updateAlbum, softDeleteAlbum,
  setCover, reorderPhotos, deletePhoto,
  bulkDeletePhotos, bulkMovePhotos,
  listPhotoIdsForRegeneration, getAlbumById,
  listAlbums,
} from "@/lib/albums";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { originalKey } from "@/lib/keys";
import { headObject } from "@/lib/minio";
import type { AlbumStatus } from "@/lib/types";

async function gate(): Promise<void> {
  // Test harness bypass: integration tests run server actions directly
  // without an iron-session cookie. Honour the same env flag the
  // requireAdmin() helper uses for its DB-bound call sites.
  if (process.env.GH_TEST_BYPASS_AUTH === "1") return;
  const auth = await requireAdminSessionFromCookies();
  if (!auth.ok) throw new Error("unauthorized");
}

export async function createAlbumAction(input: {
  title: string; subtitle: string | null; status: AlbumStatus;
}): Promise<string> {
  await gate();
  const a = await createAlbum(input);
  revalidatePath("/admin/albums");
  return a.slug;
}

export async function updateAlbumAction(id: string, patch: {
  title?: string; subtitle?: string | null; status?: AlbumStatus;
}): Promise<void> {
  await gate();
  await updateAlbum(id, patch);
  revalidatePath("/admin/albums");
}

export async function softDeleteAlbumAction(id: string): Promise<void> {
  await gate();
  await softDeleteAlbum(id);
  revalidatePath("/admin/albums");
}

export async function setCoverAction(albumId: string, photoId: string): Promise<void> {
  await gate();
  await setCover(albumId, photoId);
  revalidatePath("/admin/albums");
}

export async function reorderPhotosAction(albumId: string, orderedIds: string[]): Promise<void> {
  await gate();
  await reorderPhotos(albumId, orderedIds);
}

export async function deletePhotoAction(photoId: string): Promise<void> {
  await gate();
  await deletePhoto(photoId);
}

export async function bulkDeletePhotosAction(albumId: string, photoIds: string[]): Promise<void> {
  await gate();
  await bulkDeletePhotos(albumId, photoIds);
  revalidatePath("/admin/albums");
}

export async function bulkMovePhotosAction(
  srcAlbumId: string,
  dstAlbumId: string,
  photoIds: string[],
): Promise<void> {
  await gate();
  await bulkMovePhotos(srcAlbumId, dstAlbumId, photoIds);
  revalidatePath("/admin/albums");
}

export interface AlbumSummary {
  id: string;
  title: string;
  slug: string;
}

/** Returns the album list (id, title, slug) for the "Move to..." picker. */
export async function listAlbumsForPickerAction(): Promise<AlbumSummary[]> {
  await gate();
  const rows = await listAlbums();
  return rows.map((a) => ({ id: a.id, title: a.title, slug: a.slug }));
}

export async function updateAlbumWatermarkAction(
  albumId: string,
  enabled: boolean,
  text: string | null,
): Promise<void> {
  await gate();
  await updateAlbum(albumId, { watermarkEnabled: enabled, watermarkText: text });
  revalidatePath("/admin/albums");
}

/**
 * Re-enqueue every photo in the album for derivative regeneration. Used
 * after toggling the watermark setting — the worker will re-stamp (or
 * un-stamp) the web + large variants based on the album's current flag.
 *
 * Only photos with a discoverable `original.*` key are enqueued; if the
 * original is missing (e.g. still uploading) it gets skipped silently
 * and will be picked up on its first natural derivative run.
 */
export async function regenerateAlbumDerivativesAction(albumId: string): Promise<{ enqueued: number }> {
  await gate();
  const album = await getAlbumById(albumId);
  if (!album) throw new Error("album not found");
  const photos = await listPhotoIdsForRegeneration(albumId);
  const boss = await getBoss();
  let enqueued = 0;
  for (const p of photos) {
    // Recover original extension by HEAD'ing each candidate.
    let key: string | null = null;
    for (const ext of ["jpg", "png", "webp"]) {
      const candidate = originalKey(albumId, p.id, ext);
      try {
        await headObject(candidate);
        key = candidate;
        break;
      } catch {
        // try next ext
      }
    }
    if (!key) continue;
    await boss.send(GENERATE_DERIVATIVES_QUEUE, {
      album_id: albumId,
      photo_id: p.id,
      key,
    });
    enqueued += 1;
  }
  return { enqueued };
}
