import { sql } from "@/lib/db";

/**
 * Aggregated stats surfaced on the admin album page. Computed in one
 * round-trip per album so the page render stays cheap even on busy
 * libraries.
 */
export interface AlbumStats {
  /** Total storage occupied by originals in this album. */
  storage_bytes: number;
  /** Earliest and latest `taken_at` of any photo in the album. */
  shot_from: string | null;
  shot_to: string | null;
  /** Most-frequent EXIF camera + the fraction of photos shot with it. */
  top_camera: string | null;
  top_camera_pct: number | null;
  /** Library-wide storage total — used to render this album's share. */
  library_bytes: number;
}

/**
 * Pull everything the StatsStrip needs in one shot. Two queries:
 *   1) per-album aggregates (storage, date range, camera top-1).
 *   2) library-wide total (used only for the "X% of library" bar).
 *
 * The camera aggregation reaches into `photos.exif->>'camera'`. Photos
 * uploaded before the EXIF migration have null in that path and are
 * excluded from the percentage. We deliberately surface the top-1
 * camera only — the StatsStrip has limited horizontal room and the
 * long-tail makes for a confusing chip.
 */
export async function loadAlbumStats(albumId: string): Promise<AlbumStats> {
  const aggRows = await sql<{
    storage_bytes: string | number;
    shot_from: Date | string | null;
    shot_to: Date | string | null;
    top_camera: string | null;
    top_camera_count: string | number | null;
    cameras_total: string | number;
  }[]>`
    WITH camera_counts AS (
      SELECT exif->>'camera' AS camera, COUNT(*)::bigint AS cnt
        FROM photos
       WHERE album_id = ${albumId}
         AND exif IS NOT NULL
         AND exif->>'camera' IS NOT NULL
         AND exif->>'camera' <> ''
       GROUP BY exif->>'camera'
       ORDER BY cnt DESC
       LIMIT 1
    ),
    cameras_total AS (
      SELECT COUNT(*)::bigint AS cnt
        FROM photos
       WHERE album_id = ${albumId}
         AND exif IS NOT NULL
         AND exif->>'camera' IS NOT NULL
         AND exif->>'camera' <> ''
    )
    SELECT
      COALESCE(SUM(p.orig_bytes), 0)::bigint AS storage_bytes,
      MIN(p.taken_at) AS shot_from,
      MAX(p.taken_at) AS shot_to,
      (SELECT camera FROM camera_counts) AS top_camera,
      (SELECT cnt FROM camera_counts) AS top_camera_count,
      (SELECT cnt FROM cameras_total) AS cameras_total
    FROM photos p
    WHERE p.album_id = ${albumId}
  `;
  const a = aggRows[0];

  const libRows = await sql<{ bytes: string | number }[]>`
    SELECT COALESCE(SUM(orig_bytes), 0)::bigint AS bytes FROM photos
  `;
  const libraryBytes = Number(libRows[0]?.bytes ?? 0);

  const topCameraCount = a.top_camera_count === null ? 0 : Number(a.top_camera_count);
  const camerasTotal = Number(a.cameras_total ?? 0);
  const topCameraPct = camerasTotal > 0 && a.top_camera
    ? Math.round((topCameraCount / camerasTotal) * 100)
    : null;

  return {
    storage_bytes: Number(a.storage_bytes ?? 0),
    shot_from: a.shot_from === null
      ? null
      : (a.shot_from instanceof Date ? a.shot_from : new Date(a.shot_from)).toISOString(),
    shot_to: a.shot_to === null
      ? null
      : (a.shot_to instanceof Date ? a.shot_to : new Date(a.shot_to)).toISOString(),
    top_camera: a.top_camera ?? null,
    top_camera_pct: topCameraPct,
    library_bytes: libraryBytes,
  };
}
