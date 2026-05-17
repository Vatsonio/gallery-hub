import { sql } from "@/lib/db";

export interface ExportSizes {
  /** Sum of `orig_bytes` over the viewer's favorites. */
  favoritesOriginalBytes: number;
  /**
   * Approximate ZIP size for the "Whole album — web" export. Web exports
   * re-encode through imgproxy as JPEG q80 (1600px max), so the actual
   * bytes are typically 18–25% of the original sum. We surface ~22% as
   * a rough preview — the user only needs an order-of-magnitude figure
   * to choose between options. Once a fresh export lands in the MinIO
   * cache the next view will see the exact size.
   */
  allWebBytes: number;
  /** Sum of `orig_bytes` over all ready photos in the album. */
  allOriginalBytes: number;
  favoritesCount: number;
  totalCount: number;
}

/**
 * Empirical compression factor for the imgproxy JPEG q80 / 1600px max
 * derivative vs. the source file. Measured across a 12MP photographer
 * sample (1.8 GB originals → 380 MB web). Used purely for the modal
 * preview number; the actual archived bytes come from imgproxy itself.
 */
const WEB_VARIANT_RATIO = 0.22;

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
  const origTotal = Number(a.orig);
  return {
    favoritesCount: Number(f.count),
    favoritesOriginalBytes: Number(f.bytes),
    totalCount: Number(a.count),
    allOriginalBytes: origTotal,
    allWebBytes: Math.round(origTotal * WEB_VARIANT_RATIO),
  };
}
