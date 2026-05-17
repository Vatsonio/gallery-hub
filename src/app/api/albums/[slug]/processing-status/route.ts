import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/session";
import { getAlbumBySlug } from "@/lib/albums";
import { sql } from "@/lib/db";

interface Ctx { params: Promise<{ slug: string }>; }

interface StatusRow {
  total: bigint | string;
  ready: bigint | string;
  processing: bigint | string;
  uploading: bigint | string;
  /** Median time-to-ready over photos that finished in the last five minutes, in seconds. */
  median_ttr_seconds: number | string | null;
}

/**
 * Lightweight admin endpoint that powers the floating processing tracker.
 *
 * The grid page already polls `photos?status_only=1`, but pulling the
 * entire photo list (with thumb/web/large imgproxy URLs) just to count
 * statuses is wasteful at 1Hz cadence. This endpoint returns the four
 * numbers the tracker needs in one ~150-byte JSON body.
 *
 * The ETA derives from a five-minute window of finalized-to-ready
 * deltas. With imgproxy the worker hot path is ~100ms per photo so this
 * sits around 0–1s for a typical batch, but bursty uploads can stack up
 * behind the worker pool and the ETA gives the user a feeling for that.
 *
 * Shape:
 *   { total, ready, processing, uploading, eta_seconds }
 *
 * `eta_seconds` is null when there's nothing to estimate (no processing
 * photos, or no recent samples to base the throughput on).
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });

  const { slug } = await ctx.params;
  const album = await getAlbumBySlug(slug);
  if (!album) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Single-statement aggregation — we don't need a transaction because
  // the counts are read-only and the table primary key + status are both
  // covered by btree indexes. The `percentile_cont` over the five-minute
  // window of (updated_at - created_at) deltas gives us a median time
  // to ready that smooths over the long-tail derivative jobs.
  const rows = await sql<StatusRow[]>`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE status = 'ready')::bigint AS ready,
      COUNT(*) FILTER (WHERE status = 'processing')::bigint AS processing,
      COUNT(*) FILTER (WHERE status = 'uploading')::bigint AS uploading,
      (
        SELECT percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))
        )
        FROM photos
        WHERE album_id = ${album.id}
          AND status = 'ready'
          AND updated_at > now() - interval '5 minutes'
      )::float AS median_ttr_seconds
    FROM photos
    WHERE album_id = ${album.id}
  `;

  const r = rows[0];
  const total = Number(r.total);
  const ready = Number(r.ready);
  const processing = Number(r.processing);
  const uploading = Number(r.uploading);
  const median = r.median_ttr_seconds === null || r.median_ttr_seconds === undefined
    ? null
    : Number(r.median_ttr_seconds);

  // Throughput estimate: median time per photo × number still processing
  // gives a rough remaining-time. We deliberately don't divide by worker
  // pool size — `median_ttr_seconds` is *observed* wall-clock per
  // finalized photo, which already bakes in the worker parallelism.
  let eta_seconds: number | null = null;
  if (processing > 0 && median !== null && Number.isFinite(median) && median > 0) {
    eta_seconds = Math.max(1, Math.round(median * processing));
  }

  return NextResponse.json({
    total,
    ready,
    processing,
    uploading,
    median_ttr_seconds: median,
    eta_seconds,
  });
}
