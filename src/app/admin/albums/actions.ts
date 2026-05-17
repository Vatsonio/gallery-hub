"use server";
import { revalidatePath } from "next/cache";
import { requireAdminSessionFromCookies } from "@/lib/auth-check";
import {
  createAlbum, updateAlbum,
  purgeAlbumStorage, purgeSoftDeletedAlbums,
  setCover, reorderPhotos, deletePhoto,
  bulkDeletePhotos, bulkMovePhotos,
  deletePhotoStorage,
  listPhotoIdsForRegeneration, getAlbumById,
  listAlbums,
} from "@/lib/albums";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { originalKey } from "@/lib/keys";
import { headObject } from "@/lib/minio";
import { rewriteWatermarkPng } from "@/lib/watermarks";
import { DEFAULT_WATERMARK_TEXT } from "@/lib/images";
import { sql } from "@/lib/db";
import { listShareTokensForAlbum } from "@/lib/share";
import type { AlbumStatus } from "@/lib/types";

// F5: any mutation that changes album content (cover, photos, watermark)
// must invalidate every active share-link prerender for that album, else
// /a/{token} can serve up-to-60-s-stale HTML carrying signed imgproxy
// URLs to content the operator just revoked.
async function revalidateAlbumTokens(albumId: string): Promise<void> {
  const tokens = await listShareTokensForAlbum(albumId);
  for (const t of tokens) revalidatePath(`/a/${t}`);
}

async function revalidateAlbumTokensForMany(albumIds: string[]): Promise<void> {
  const seen = new Set<string>();
  for (const id of albumIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    await revalidateAlbumTokens(id);
  }
}

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
  await revalidateAlbumTokens(id);
}

export async function softDeleteAlbumAction(id: string): Promise<void> {
  await gate();
  // "Soft delete" is now immediate purge — MinIO objects + DB rows go away
  // together so the photographer's storage quota reflects reality. The
  // name is kept for back-compat with the AlbumForm client component.
  const tokens = await listShareTokensForAlbum(id);
  await purgeAlbumStorage(id);
  revalidatePath("/admin/albums");
  for (const t of tokens) revalidatePath(`/a/${t}`);
}

/**
 * Reap every album that's still flagged `deleted_at IS NOT NULL` from the
 * previous soft-delete-only era. Wipes their MinIO objects + DB rows.
 * Returns the aggregate so the UI can surface "freed X MB across Y albums".
 */
export async function purgeSoftDeletedAlbumsAction(): Promise<{
  albumsPurged: number;
  totalBytesFreed: number;
  totalPhotosDeleted: number;
  totalS3ObjectsDeleted: number;
}> {
  await gate();
  const r = await purgeSoftDeletedAlbums();
  revalidatePath("/admin/albums");
  revalidatePath("/admin/settings");
  revalidatePath("/admin/metrics");
  return r;
}

export async function setCoverAction(albumId: string, photoId: string): Promise<void> {
  await gate();
  await setCover(albumId, photoId);
  revalidatePath("/admin/albums");
  await revalidateAlbumTokens(albumId);
}

export async function reorderPhotosAction(albumId: string, orderedIds: string[]): Promise<void> {
  await gate();
  await reorderPhotos(albumId, orderedIds);
  await revalidateAlbumTokens(albumId);
}

export async function deletePhotoAction(photoId: string): Promise<void> {
  await gate();
  const rows = await sql<{ album_id: string }[]>`
    SELECT album_id FROM photos WHERE id = ${photoId} LIMIT 1
  `;
  const albumId = rows[0]?.album_id;
  await deletePhoto(photoId);
  if (albumId) {
    await deletePhotoStorage(albumId, [photoId]);
    await revalidateAlbumTokens(albumId);
  }
}

export async function bulkDeletePhotosAction(albumId: string, photoIds: string[]): Promise<void> {
  await gate();
  await bulkDeletePhotos(albumId, photoIds);
  await deletePhotoStorage(albumId, photoIds);
  revalidatePath("/admin/albums");
  await revalidateAlbumTokens(albumId);
}

export async function bulkMovePhotosAction(
  srcAlbumId: string,
  dstAlbumId: string,
  photoIds: string[],
): Promise<void> {
  await gate();
  await bulkMovePhotos(srcAlbumId, dstAlbumId, photoIds);
  revalidatePath("/admin/albums");
  await revalidateAlbumTokensForMany([srcAlbumId, dstAlbumId]);
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
  // imgproxy era: composition happens lazily at request time via the
  // wm_url processing step. We just need the watermark PNG to exist at
  // watermarks/{albumId}.png; the URL builder references it directly.
  // Rewriting the bytes invalidates any in-flight imgproxy cache entries
  // that hold the previous watermark (the source URL is the same — we
  // can't ?v= a static asset — but ETag-based revalidation handles it).
  if (enabled) {
    const t = (text ?? "").trim() || DEFAULT_WATERMARK_TEXT;
    await rewriteWatermarkPng(albumId, t).catch((err) => {
      console.error("[admin] watermark PNG rewrite failed", err);
    });
  }
  // Bump every photo's updated_at so the next render forces fresh
  // imgproxy URLs that pick up the new watermark composition (or its
  // absence). The actual pixel work happens on the next image fetch —
  // no worker queue involvement needed in the imgproxy era.
  await sql`UPDATE photos SET updated_at = now() WHERE album_id = ${albumId}`;
  revalidatePath("/admin/albums");
  await revalidateAlbumTokens(albumId);
}

/**
 * Legacy regen entry point — kept for compatibility with the UI's
 * "Re-stamp all" button. In the imgproxy era there's nothing to
 * regenerate (variants resize on demand), but we still bump updated_at
 * so the URL builder emits fresh ?v= values and re-queue the metadata
 * worker so width/height/thumbhash get re-read if the originals shifted.
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
