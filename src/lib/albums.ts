import { CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { variantKey, avifVariantKey, originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { imgproxyWeb, photoVersionSeed } from "@/lib/imgproxy";
import { s3Client, BUCKET, deleteObjectsByPrefix, deleteObject } from "@/lib/minio";
import { watermarkKey } from "@/lib/watermarks";
import type { AlbumRow, AlbumStatus, AlbumWithStats, PhotoExif, PhotoRow } from "@/lib/types";

/**
 * Visibility scope for album queries from the admin surface. Public-side
 * code that has its own auth model (share-tokens) keeps using the
 * unscoped `getAlbumById` — it's already gated upstream.
 *
 *   - role: "owner" sees every admin's albums (the global "superuser"
 *     view kept for support / catalog inspection).
 *   - role: "admin" sees only albums where owner_user_id = userId.
 *
 * Callers always derive this from `requireAdmin()` which guarantees a
 * fresh DB-backed role lookup.
 */
export interface AdminViewer {
  userId: string;
  role: "owner" | "admin";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

async function uniqueSlugForOwner(base: string, ownerUserId: string): Promise<string> {
  const root = slugify(base) || "album";
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const rows = await sql`
      SELECT 1 FROM albums
       WHERE slug = ${candidate} AND owner_user_id = ${ownerUserId}
       LIMIT 1`;
    if (rows.length === 0) return candidate;
  }
  return `${root}-${randomUUID().slice(0, 6)}`;
}

export interface CreateAlbumInput {
  title: string;
  subtitle: string | null;
  status: AlbumStatus;
  /** Admin user who owns the album. Required since the workspace split. */
  ownerUserId: string;
}

export async function createAlbum(input: CreateAlbumInput): Promise<AlbumRow> {
  const id = randomUUID();
  const slug = await uniqueSlugForOwner(input.title, input.ownerUserId);
  const rows = await sql<AlbumRow[]>`
    INSERT INTO albums (id, slug, title, subtitle, status, owner_user_id)
    VALUES (${id}, ${slug}, ${input.title}, ${input.subtitle}, ${input.status}, ${input.ownerUserId})
    RETURNING *`;
  return rows[0];
}

/**
 * Resolve an album by its slug for the given admin viewer. Slugs are
 * unique only within an owner's namespace, so:
 *
 *   - role "admin": match slug AND owner_user_id = viewer.userId
 *   - role "owner": match slug anywhere (any non-owner could in theory
 *     have the same slug, so this picks the first match by updated_at).
 *     In practice the owner is the single backfill recipient + creates
 *     albums under their own owner_user_id, so collisions are rare.
 *
 * Public/share routes don't call this — they go through getAlbumById.
 */
export async function getAlbumBySlug(slug: string, viewer: AdminViewer): Promise<AlbumRow | null> {
  if (viewer.role === "owner") {
    const rows = await sql<AlbumRow[]>`
      SELECT * FROM albums
       WHERE slug = ${slug} AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 1`;
    return rows[0] ?? null;
  }
  const rows = await sql<AlbumRow[]>`
    SELECT * FROM albums
     WHERE slug = ${slug}
       AND owner_user_id = ${viewer.userId}
       AND deleted_at IS NULL
     LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Unscoped lookup — used by public/share flows that have their own
 * auth (share token / unlock cookie). Admin callers MUST verify
 * ownership via `assertAdminAlbumAccess` after fetching.
 */
export async function getAlbumById(id: string): Promise<AlbumRow | null> {
  const rows = await sql<AlbumRow[]>`
    SELECT * FROM albums WHERE id = ${id} AND deleted_at IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Throws if the given admin viewer is neither the owner of the album nor
 * the global "owner" role. Use in admin mutation paths immediately after
 * `getAlbumById` to gate cross-workspace access.
 */
export function assertAdminAlbumAccess(album: AlbumRow, viewer: AdminViewer): void {
  if (viewer.role === "owner") return;
  if (album.owner_user_id === viewer.userId) return;
  throw new Error("forbidden: album belongs to a different workspace");
}

export async function listAlbums(viewer: AdminViewer): Promise<AlbumRow[]> {
  if (viewer.role === "owner") {
    return sql<AlbumRow[]>`
      SELECT * FROM albums WHERE deleted_at IS NULL ORDER BY updated_at DESC`;
  }
  return sql<AlbumRow[]>`
    SELECT * FROM albums
     WHERE owner_user_id = ${viewer.userId} AND deleted_at IS NULL
     ORDER BY updated_at DESC`;
}

export interface UpdateAlbumInput {
  title?: string;
  subtitle?: string | null;
  status?: AlbumStatus;
  watermarkEnabled?: boolean;
  watermarkText?: string | null;
}
export async function updateAlbum(id: string, patch: UpdateAlbumInput): Promise<void> {
  await sql`
    UPDATE albums SET
      title    = COALESCE(${patch.title ?? null}, title),
      subtitle = CASE WHEN ${patch.subtitle === undefined} THEN subtitle ELSE ${patch.subtitle ?? null} END,
      status   = COALESCE(${patch.status ?? null}, status),
      watermark_enabled = CASE WHEN ${patch.watermarkEnabled === undefined} THEN watermark_enabled ELSE ${patch.watermarkEnabled ?? false} END,
      watermark_text    = CASE WHEN ${patch.watermarkText === undefined} THEN watermark_text ELSE ${patch.watermarkText ?? null} END,
      updated_at = now()
    WHERE id = ${id}`;
}

export interface AlbumWatermark {
  enabled: boolean;
  text: string | null;
}

export async function getAlbumWatermark(albumId: string): Promise<AlbumWatermark> {
  const rows = await sql<{ watermark_enabled: boolean; watermark_text: string | null }[]>`
    SELECT watermark_enabled, watermark_text FROM albums WHERE id = ${albumId} LIMIT 1`;
  const r = rows[0];
  return { enabled: r?.watermark_enabled ?? false, text: r?.watermark_text ?? null };
}

export async function softDeleteAlbum(id: string): Promise<void> {
  await sql`UPDATE albums SET deleted_at = now() WHERE id = ${id}`;
}

export async function listSoftDeletedAlbumIds(viewer: AdminViewer): Promise<string[]> {
  if (viewer.role === "owner") {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM albums WHERE deleted_at IS NOT NULL`;
    return rows.map((r) => r.id);
  }
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM albums
     WHERE deleted_at IS NOT NULL AND owner_user_id = ${viewer.userId}`;
  return rows.map((r) => r.id);
}

export async function hardDeleteAlbum(id: string): Promise<void> {
  await sql`DELETE FROM photos WHERE album_id = ${id}`;
  await sql`DELETE FROM albums WHERE id = ${id}`;
}

export interface PurgeResult {
  /** S3 objects under albums/<id>/ that were deleted (originals + any cached variants). */
  s3ObjectsDeleted: number;
  /** Bytes reported by SUM(orig_bytes) on the DB-side photos before delete. */
  bytesFreed: number;
  /** Photo rows deleted. */
  photosDeleted: number;
  /** Watermark file reaped (if any). */
  watermarkDeleted: boolean;
}

/**
 * Wipe an album AND its storage. Walks every MinIO object under
 * `albums/<albumId>/`, the watermark stamp at `watermarks/<albumId>.png`,
 * and the photos + albums DB rows. Safe to call on an already-soft-deleted
 * album (the lookup ignores `deleted_at`).
 *
 * Order is intentional: S3 first, DB second. A storage-side failure leaves
 * the DB row in place so the next purge attempt can retry; the alternative
 * (DB first, S3 second) would orphan objects with no row pointing at them.
 */
export async function purgeAlbumStorage(albumId: string): Promise<PurgeResult> {
  const before = await sql<{ bytes: string; n: string }[]>`
    SELECT COALESCE(SUM(orig_bytes), 0)::text AS bytes,
           COUNT(*)::text AS n
      FROM photos WHERE album_id = ${albumId}
  `;
  const bytesFreed = Number(before[0]?.bytes ?? "0");
  const photosDeleted = Number(before[0]?.n ?? "0");

  const s3ObjectsDeleted = await deleteObjectsByPrefix(`albums/${albumId}/`);

  let watermarkDeleted = false;
  const wmKey = watermarkKey(albumId);
  await deleteObject(wmKey).then(() => {
    watermarkDeleted = true;
  });

  await sql`DELETE FROM photos WHERE album_id = ${albumId}`;
  await sql`DELETE FROM albums WHERE id = ${albumId}`;

  return { s3ObjectsDeleted, bytesFreed, photosDeleted, watermarkDeleted };
}

/**
 * Wipe every album currently flagged `deleted_at IS NOT NULL`. Returns the
 * aggregate result so the caller can surface "freed X MB across Y albums"
 * after a one-click trash purge from /admin/settings.
 */
export async function purgeSoftDeletedAlbums(viewer: AdminViewer): Promise<{
  albumsPurged: number;
  totalBytesFreed: number;
  totalPhotosDeleted: number;
  totalS3ObjectsDeleted: number;
}> {
  const ids = await listSoftDeletedAlbumIds(viewer);
  let totalBytesFreed = 0;
  let totalPhotosDeleted = 0;
  let totalS3ObjectsDeleted = 0;
  for (const id of ids) {
    const r = await purgeAlbumStorage(id);
    totalBytesFreed += r.bytesFreed;
    totalPhotosDeleted += r.photosDeleted;
    totalS3ObjectsDeleted += r.s3ObjectsDeleted;
  }
  return {
    albumsPurged: ids.length,
    totalBytesFreed,
    totalPhotosDeleted,
    totalS3ObjectsDeleted,
  };
}

/**
 * Delete one or more photos from MinIO (originals + cached variants under
 * the photo's prefix). Used by `deletePhoto` / `bulkDeletePhotos` after the
 * DB rows are removed. Each photo's storage lives under
 * `albums/<albumId>/<photoId>/` — the original file plus any orphan
 * variant blobs left over from the pre-imgproxy era.
 */
export async function deletePhotoStorage(albumId: string, photoIds: string[]): Promise<number> {
  if (photoIds.length === 0) return 0;
  let n = 0;
  for (const id of photoIds) {
    n += await deleteObjectsByPrefix(`albums/${albumId}/${id}/`);
  }
  return n;
}

export interface InsertPhotoInput {
  id: string;
  album_id: string;
  filename: string;
  width: number;
  height: number;
  orig_bytes: number;
  taken_at: Date | null;
  /** Admin user who triggered the upload — drives the per-user quota
   * enforcement at presign time. Null for legacy callers / tests. */
  created_by_user_id?: string | null;
}

export async function insertPhoto(input: InsertPhotoInput): Promise<PhotoRow> {
  const rows = await sql<PhotoRow[]>`
    INSERT INTO photos (id, album_id, filename, width, height, orig_bytes, sort_order, taken_at, status, created_by_user_id)
    VALUES (
      ${input.id}, ${input.album_id}, ${input.filename},
      ${input.width}, ${input.height}, ${input.orig_bytes},
      COALESCE((SELECT MAX(sort_order) + 1 FROM photos WHERE album_id = ${input.album_id}), 0),
      ${input.taken_at}, 'processing', ${input.created_by_user_id ?? null}
    ) RETURNING *`;
  return rows[0];
}

/**
 * Bulk-insert photos in a single round-trip. All rows must share the same
 * album_id (this is the only sane batching unit because sort_order is
 * computed relative to the album). Caller is responsible for de-dup; the
 * primary key conflict will explode the whole batch.
 *
 * Rows are assigned sequential sort_order values starting at MAX+1, in the
 * order they appear in `inputs`. status is always 'processing'.
 *
 * Empty input is a no-op (returns []).
 */
export async function insertPhotosBatch(inputs: InsertPhotoInput[]): Promise<PhotoRow[]> {
  if (inputs.length === 0) return [];
  const albumId = inputs[0].album_id;
  // Cheap sanity guard — finalize never mixes albums, but make sure callers
  // who reach for this helper don't accidentally do so.
  for (const i of inputs) {
    if (i.album_id !== albumId) throw new Error("insertPhotosBatch: mixed album_id not supported");
  }
  // Resolve the starting sort_order once per batch. Outside a transaction
  // this is racy against a concurrent insert into the same album, but the
  // finalize route is the only writer and it runs serially per request.
  const maxRows = await sql<{ next: number }[]>`
    SELECT COALESCE(MAX(sort_order) + 1, 0)::int AS next FROM photos WHERE album_id = ${albumId}`;
  const base = maxRows[0]?.next ?? 0;
  const rows: Record<string, unknown>[] = inputs.map((p, i) => ({
    id: p.id,
    album_id: p.album_id,
    filename: p.filename,
    width: p.width,
    height: p.height,
    orig_bytes: p.orig_bytes,
    sort_order: base + i,
    taken_at: p.taken_at,
    status: "processing",
    created_by_user_id: p.created_by_user_id ?? null,
  }));
  // postgres.js sql(rows, ...cols) expands to a multi-row VALUES literal,
  // then RETURNING * gives us the inserted PhotoRows in insertion order.
  // Cast through `as never` because the typed overload of the helper
  // doesn't play well with our mixed value types — runtime is correct.
  return sql<PhotoRow[]>`
    INSERT INTO photos ${sql(
      rows,
      "id",
      "album_id",
      "filename",
      "width",
      "height",
      "orig_bytes",
      "sort_order",
      "taken_at",
      "status",
      "created_by_user_id",
    ) as never}
    RETURNING *`;
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

/**
 * Hard-delete a batch of photos in one transaction. Matches the existing
 * single-photo delete pattern (no soft-delete column on `photos`); the
 * MinIO objects keyed under `albums/<albumId>/<photoId>/` get reaped by
 * the existing reaper when the album is dropped, but for an in-album bulk
 * delete we should clean the objects up here so storage doesn't bloat.
 *
 * If `photoIds` is empty this is a no-op.
 */
export async function bulkDeletePhotos(albumId: string, photoIds: string[]): Promise<void> {
  if (photoIds.length === 0) return;
  await sql`DELETE FROM photos WHERE album_id = ${albumId} AND id IN ${sql(photoIds)}`;
  // Also clear cover_photo_id if it pointed at a deleted photo.
  await sql`UPDATE albums SET cover_photo_id = NULL
    WHERE id = ${albumId} AND cover_photo_id IS NOT NULL
      AND cover_photo_id IN ${sql(photoIds)}`;
}

interface MoveObjectPlan {
  from: string;
  to: string;
}

/**
 * Object-storage keys include the album id (see src/lib/keys.ts), so a
 * cross-album move can't simply update the FK — the variant/original
 * objects must be copied to keys under the new album then deleted from
 * the old. We do the S3 work first (the slow + failure-prone half); if
 * any copy fails we abort before touching the DB. If a *delete* fails
 * after a successful copy we still update the DB and log — the orphan
 * old-album object will be swept by the reaper when its source album is
 * eventually deleted, or never (storage cost is one-time and bounded).
 */
export async function bulkMovePhotos(
  srcAlbumId: string,
  dstAlbumId: string,
  photoIds: string[],
): Promise<void> {
  if (photoIds.length === 0) return;
  if (srcAlbumId === dstAlbumId) return;

  // Build the copy plan: for each photo, original.* + thumb/web/large WEBP +
  // web/large AVIF mirrors. The original's extension is recovered by HEAD
  // since it's not stored in the photos table.
  const variants = ["thumb", "web", "large"] as const;
  const avifVariants = ["web", "large"] as const;

  const plans: MoveObjectPlan[] = [];
  for (const pid of photoIds) {
    // Discover the original's extension by listing the candidate keys; HEAD
    // each plausible extension (jpg/png/webp) until one resolves.
    let origExt: string | null = null;
    for (const ext of ["jpg", "png", "webp"] as const) {
      const key = originalKey(srcAlbumId, pid, ext);
      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
        origExt = ext;
        break;
      } catch {
        // Not this one — try the next.
      }
    }
    if (origExt) {
      plans.push({
        from: originalKey(srcAlbumId, pid, origExt),
        to: originalKey(dstAlbumId, pid, origExt),
      });
    }
    for (const v of variants) {
      plans.push({
        from: variantKey(srcAlbumId, pid, v),
        to: variantKey(dstAlbumId, pid, v),
      });
    }
    for (const v of avifVariants) {
      plans.push({
        from: avifVariantKey(srcAlbumId, pid, v),
        to: avifVariantKey(dstAlbumId, pid, v),
      });
    }
  }

  const copied: MoveObjectPlan[] = [];
  try {
    for (const p of plans) {
      try {
        await s3Client.send(new CopyObjectCommand({
          Bucket: BUCKET,
          // CopySource must include the bucket: "{bucket}/{key}".
          CopySource: `/${BUCKET}/${encodeURIComponent(p.from).replace(/%2F/g, "/")}`,
          Key: p.to,
        }));
        copied.push(p);
      } catch (err) {
        // Variant might legitimately not exist (photo still processing) —
        // treat NoSuchKey/404 as a skip rather than a hard fail. Anything
        // else aborts and rolls back what we copied so far.
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        const status = e?.$metadata?.httpStatusCode;
        if (e?.name === "NoSuchKey" || status === 404) continue;
        throw err;
      }
    }
  } catch (err) {
    // Roll back copies we made so we don't leave half-copied objects.
    for (const p of copied) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: p.to }));
      } catch {
        // Best-effort cleanup.
      }
    }
    throw err;
  }

  // Update DB pointer first so the photos are immediately discoverable
  // under the new album, then sweep old-album objects.
  await sql`UPDATE photos SET album_id = ${dstAlbumId}
            WHERE album_id = ${srcAlbumId} AND id IN ${sql(photoIds)}`;
  // Clear stale cover on source if it pointed at any moved photo.
  await sql`UPDATE albums SET cover_photo_id = NULL
    WHERE id = ${srcAlbumId} AND cover_photo_id IS NOT NULL
      AND cover_photo_id IN ${sql(photoIds)}`;

  // Best-effort delete of source objects. Failures here leave benign
  // orphans which the album-level reaper will collect.
  for (const p of copied) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: p.from }));
    } catch {
      // Swallow — see comment above.
    }
  }
}

/**
 * Return every photo id in `albumId` whose status is `ready` and whose
 * derivatives need to be regenerated (e.g. watermark toggled). Caller is
 * expected to enqueue derivative jobs for each.
 */
export async function listPhotoIdsForRegeneration(albumId: string): Promise<{ id: string; filename: string }[]> {
  return sql<{ id: string; filename: string }[]>`
    SELECT id, filename FROM photos
    WHERE album_id = ${albumId} AND status IN ('ready', 'processing')`;
}

export async function markPhotoReady(photoId: string, takenAt?: Date | null): Promise<void> {
  if (takenAt) {
    await sql`UPDATE photos SET status = 'ready', taken_at = ${takenAt}, updated_at = now() WHERE id = ${photoId}`;
  } else {
    await sql`UPDATE photos SET status = 'ready', updated_at = now() WHERE id = ${photoId}`;
  }
}

/**
 * One-shot photo "ready" transition for the imgproxy era. Writes
 * width/height (authoritative server-side metadata), taken_at (EXIF),
 * thumbhash, and flips status='ready' + bumps updated_at — all in one
 * round-trip so the worker hot path stays ~one DB write per photo.
 *
 * Variants are NOT generated server-side anymore: imgproxy resizes on
 * demand from the original. The worker only fills in the bits imgproxy
 * doesn't know (EXIF, thumbhash, sharp-verified dimensions).
 *
 * `exif` is the rich EXIF subset emitted by readPhotoExif; pass null
 * when the parser couldn't recover anything useful (older/scrubbed
 * files). Stored as JSONB so the album-stats aggregator can index on
 * `exif->>'camera'`.
 */
export async function finalizePhotoMetadata(
  photoId: string,
  meta: {
    width: number;
    height: number;
    takenAt: Date | null;
    thumbhash: string;
    exif?: PhotoExif | null;
  },
): Promise<void> {
  await sql`
    UPDATE photos
       SET width      = ${meta.width},
           height     = ${meta.height},
           taken_at   = ${meta.takenAt},
           thumbhash  = ${meta.thumbhash},
           exif       = ${meta.exif ? sql.json({ ...meta.exif }) : null},
           status     = 'ready',
           updated_at = now()
     WHERE id = ${photoId}
  `;
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

export async function listAlbumsWithStats(viewer: AdminViewer): Promise<AlbumWithStats[]> {
  const rows = viewer.role === "owner"
    ? await sql<(AlbumRow & { photo_count: number })[]>`
        SELECT a.*, COALESCE(p.cnt, 0)::int AS photo_count
        FROM albums a
        LEFT JOIN (SELECT album_id, COUNT(*)::int AS cnt FROM photos GROUP BY album_id) p
          ON p.album_id = a.id
        WHERE a.deleted_at IS NULL
        ORDER BY a.updated_at DESC`
    : await sql<(AlbumRow & { photo_count: number })[]>`
        SELECT a.*, COALESCE(p.cnt, 0)::int AS photo_count
        FROM albums a
        LEFT JOIN (SELECT album_id, COUNT(*)::int AS cnt FROM photos GROUP BY album_id) p
          ON p.album_id = a.id
        WHERE a.deleted_at IS NULL AND a.owner_user_id = ${viewer.userId}
        ORDER BY a.updated_at DESC`;
  // Cover thumbs now resolve through imgproxy. We need the cover photo's
  // filename (for ext recovery) + updated_at (for cache-bust) — pulled in
  // one batch lookup so the album list stays O(1) DB round-trips.
  const coverIds = rows.map((r) => r.cover_photo_id).filter((id): id is string => id !== null);
  type CoverRow = { id: string; filename: string; updated_at: string };
  const covers = coverIds.length
    ? await sql<CoverRow[]>`SELECT id, filename, updated_at FROM photos WHERE id IN ${sql(coverIds)}`
    : [];
  const coverMap = new Map(covers.map((c) => [c.id, c]));
  return rows.map((r) => {
    let cover_thumb_url: string | null = null;
    if (r.cover_photo_id) {
      const cover = coverMap.get(r.cover_photo_id);
      if (cover) {
        cover_thumb_url = imgproxyWeb(
          originalKey(r.id, cover.id, resolveOriginalExt(cover.filename)),
          { version: photoVersionSeed(cover.updated_at) },
        );
      }
    }
    return { ...r, cover_thumb_url };
  });
}
