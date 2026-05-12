import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { presignGet, IMMUTABLE_VARIANT_CACHE_CONTROL } from "@/lib/presign";
import { variantKey } from "@/lib/keys";
import type { AlbumRow, AlbumStatus, AlbumWithStats, PhotoRow } from "@/lib/types";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "album";
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const rows = await sql`SELECT 1 FROM albums WHERE slug = ${candidate} LIMIT 1`;
    if (rows.length === 0) return candidate;
  }
  return `${root}-${randomUUID().slice(0, 6)}`;
}

export interface CreateAlbumInput {
  title: string;
  subtitle: string | null;
  status: AlbumStatus;
}

export async function createAlbum(input: CreateAlbumInput): Promise<AlbumRow> {
  const id = randomUUID();
  const slug = await uniqueSlug(input.title);
  const rows = await sql<AlbumRow[]>`
    INSERT INTO albums (id, slug, title, subtitle, status)
    VALUES (${id}, ${slug}, ${input.title}, ${input.subtitle}, ${input.status})
    RETURNING *`;
  return rows[0];
}

export async function getAlbumBySlug(slug: string): Promise<AlbumRow | null> {
  const rows = await sql<AlbumRow[]>`
    SELECT * FROM albums WHERE slug = ${slug} AND deleted_at IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

export async function getAlbumById(id: string): Promise<AlbumRow | null> {
  const rows = await sql<AlbumRow[]>`
    SELECT * FROM albums WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

export async function listAlbums(): Promise<AlbumRow[]> {
  return sql<AlbumRow[]>`
    SELECT * FROM albums WHERE deleted_at IS NULL ORDER BY updated_at DESC`;
}

export interface UpdateAlbumInput {
  title?: string;
  subtitle?: string | null;
  status?: AlbumStatus;
}
export async function updateAlbum(id: string, patch: UpdateAlbumInput): Promise<void> {
  await sql`
    UPDATE albums SET
      title    = COALESCE(${patch.title ?? null}, title),
      subtitle = CASE WHEN ${patch.subtitle === undefined} THEN subtitle ELSE ${patch.subtitle ?? null} END,
      status   = COALESCE(${patch.status ?? null}, status),
      updated_at = now()
    WHERE id = ${id}`;
}

export async function softDeleteAlbum(id: string): Promise<void> {
  await sql`UPDATE albums SET deleted_at = now() WHERE id = ${id}`;
}

export async function listSoftDeletedAlbumIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM albums WHERE deleted_at IS NOT NULL`;
  return rows.map((r) => r.id);
}

export async function hardDeleteAlbum(id: string): Promise<void> {
  await sql`DELETE FROM photos WHERE album_id = ${id}`;
  await sql`DELETE FROM albums WHERE id = ${id}`;
}

export interface InsertPhotoInput {
  id: string;
  album_id: string;
  filename: string;
  width: number;
  height: number;
  orig_bytes: number;
  taken_at: Date | null;
}

export async function insertPhoto(input: InsertPhotoInput): Promise<PhotoRow> {
  const rows = await sql<PhotoRow[]>`
    INSERT INTO photos (id, album_id, filename, width, height, orig_bytes, sort_order, taken_at, status)
    VALUES (
      ${input.id}, ${input.album_id}, ${input.filename},
      ${input.width}, ${input.height}, ${input.orig_bytes},
      COALESCE((SELECT MAX(sort_order) + 1 FROM photos WHERE album_id = ${input.album_id}), 0),
      ${input.taken_at}, 'processing'
    ) RETURNING *`;
  return rows[0];
}

export async function listPhotos(albumId: string): Promise<PhotoRow[]> {
  return sql<PhotoRow[]>`
    SELECT * FROM photos WHERE album_id = ${albumId} ORDER BY sort_order ASC, created_at ASC`;
}

export async function setCover(albumId: string, photoId: string): Promise<void> {
  await sql`UPDATE albums SET cover_photo_id = ${photoId}, updated_at = now() WHERE id = ${albumId}`;
}

export async function reorderPhotos(albumId: string, orderedIds: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx`UPDATE photos SET sort_order = ${i} WHERE id = ${orderedIds[i]} AND album_id = ${albumId}`;
    }
  });
}

export async function deletePhoto(photoId: string): Promise<void> {
  await sql`DELETE FROM photos WHERE id = ${photoId}`;
}

export async function markPhotoReady(photoId: string, takenAt?: Date | null): Promise<void> {
  if (takenAt) {
    await sql`UPDATE photos SET status = 'ready', taken_at = ${takenAt} WHERE id = ${photoId}`;
  } else {
    await sql`UPDATE photos SET status = 'ready' WHERE id = ${photoId}`;
  }
}

export interface VariantSizes {
  thumb: number;
  web: number;
  large: number;
  /** Byte size of the AVIF mirror of the web variant. */
  avifWeb?: number | null;
  /** Byte size of the AVIF mirror of the large variant. */
  avifLarge?: number | null;
}

/**
 * Persist the base64-encoded ThumbHash for a photo. Called once per
 * photo by the derivative worker after the variants are uploaded.
 */
export async function writePhotoThumbhash(photoId: string, hash: string): Promise<void> {
  await sql`UPDATE photos SET thumbhash = ${hash} WHERE id = ${photoId}`;
}

export async function writePhotoVariantSizes(photoId: string, sizes: VariantSizes): Promise<void> {
  await sql`
    UPDATE photos
       SET thumb_bytes      = ${sizes.thumb},
           web_bytes        = ${sizes.web},
           large_bytes      = ${sizes.large},
           avif_bytes_web   = ${sizes.avifWeb ?? null},
           avif_bytes_large = ${sizes.avifLarge ?? null}
     WHERE id = ${photoId}
  `;
}

export async function listAlbumsWithStats(): Promise<AlbumWithStats[]> {
  const rows = await sql<(AlbumRow & { photo_count: number })[]>`
    SELECT a.*, COALESCE(p.cnt, 0)::int AS photo_count
    FROM albums a
    LEFT JOIN (SELECT album_id, COUNT(*)::int AS cnt FROM photos GROUP BY album_id) p
      ON p.album_id = a.id
    WHERE a.deleted_at IS NULL
    ORDER BY a.updated_at DESC`;
  return Promise.all(rows.map(async (r) => ({
    ...r,
    cover_thumb_url: r.cover_photo_id ? await presignGet(variantKey(r.id, r.cover_photo_id, "web"), 3600, {
      responseCacheControl: IMMUTABLE_VARIANT_CACHE_CONTROL,
    }) : null,
  })));
}
