import { sql } from "@/lib/db";

export interface ExportSizes {
  /** Sum of `orig_bytes` over the viewer's favorites. */
  favoritesOriginalBytes: number;
  /**
   * Sum of `orig_bytes` over all ready photos in the album.
   * In the imgproxy era the export ZIP always streams the original
   * bytes (variants resize on demand and aren't worth a second pass
   * for downloads), so allWebBytes and allOriginalBytes are equal.
   * The field is kept for UI compatibility with the export modal.
   */
  allWebBytes: number;
  /** Sum of `orig_bytes` over all ready photos in the album. */
  allOriginalBytes: number;
  favoritesCount: number;
  totalCount: number;
}

/**
 * Aggregates byte totals for the export modal in a single DB roundtrip
 * pair. Counts come from the same scan so they're guaranteed consistent
 * with the byte totals shown next to them.
 */
export async function computeExportSizes(
  token: string,
  viewerId: string,
  albumId: string,
): Promise<ExportSizes> {
  const [fav, all] = await Promise.all([
    sql<{ count: string; bytes: string }[]>`
      SELECT COUNT(*)::text AS count,
             COALESCE(SUM(p.orig_bytes), 0)::text AS bytes
        FROM favorites f
        JOIN photos p ON p.id = f.photo_id
       WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
    `,
    sql<{ count: string; orig: string }[]>`
      SELECT COUNT(*)::text AS count,
             COALESCE(SUM(orig_bytes), 0)::text AS orig
        FROM photos
       WHERE album_id = ${albumId} AND status = 'ready'
    `,
  ]);
  const f = fav[0] ?? { count: "0", bytes: "0" };
  const a = all[0] ?? { count: "0", orig: "0" };
  return {
    favoritesCount: Number(f.count),
    favoritesOriginalBytes: Number(f.bytes),
    totalCount: Number(a.count),
    allOriginalBytes: Number(a.orig),
    // large_bytes is legacy; web exports stream originals in the
    // imgproxy era so the figure shown to the user is the original size.
    allWebBytes: Number(a.orig),
  };
}
