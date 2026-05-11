import { sql } from "@/lib/db";
import { getPresignedUrl } from "@/lib/minio";
import { variantKey } from "@/lib/keys";
import {
  groupFavoriteEvents,
  type GroupedSelection,
  type RawFavoriteEvent,
} from "@/lib/viewerGrouping";

export interface WidgetStats {
  albums_total: number;
  albums_published: number;
  photos_total: number;
  storage_bytes: number;
}

export interface WidgetRecentAlbum {
  title: string;
  subtitle: string | null;
  cover_url: string | null;
  photo_count: number;
  favorite_count: number;
  view_count: number;
  share_url: string | null;
  status: "draft" | "published" | "archived";
  updated_at: string;
}

export interface WidgetSummary {
  stats: WidgetStats;
  recent_albums: WidgetRecentAlbum[];
  recent_selections: GroupedSelection[];
}

interface StatsRow {
  albums_total: bigint | string;
  albums_published: bigint | string;
  photos_total: bigint | string;
  storage_bytes: bigint | string;
}

interface AlbumRow {
  id: string;
  title: string;
  subtitle: string | null;
  cover_photo_id: string | null;
  status: "draft" | "published" | "archived";
  updated_at: Date;
  photo_count: bigint | string;
  favorite_count: bigint | string;
  view_count: bigint | string;
  token: string | null;
}

let cache: { at: number; value: WidgetSummary } | null = null;
const CACHE_MS = 60_000;

function n(v: bigint | string | number): number {
  return typeof v === "number" ? v : Number(v);
}

/**
 * Load the read-only summary surfaced by /api/widget/summary.
 *
 * In-process cache: the route handler is already bearer-gated + rate
 * limited, but Postgres queries here are heavier than the network call
 * itself. A 60s memoization absorbs widget polling (~5 min revalidate in
 * personal-hub) and any backoff retries without hammering the DB.
 */
export async function loadWidgetSummary(baseUrl: string): Promise<WidgetSummary> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const statsRows = await sql<StatsRow[]>`
    SELECT
      (SELECT COUNT(*) FROM albums)::bigint AS albums_total,
      (SELECT COUNT(*) FROM albums WHERE status = 'published')::bigint AS albums_published,
      (SELECT COUNT(*) FROM photos)::bigint AS photos_total,
      (SELECT COALESCE(SUM(orig_bytes), 0) FROM photos)::bigint AS storage_bytes
  `;
  const stats = statsRows[0];

  const albums = await sql<AlbumRow[]>`
    SELECT
      a.id, a.title, a.subtitle, a.cover_photo_id, a.status, a.updated_at,
      (SELECT COUNT(*) FROM photos WHERE album_id = a.id)::bigint AS photo_count,
      (SELECT COUNT(DISTINCT f.viewer_id)
         FROM favorites f
         JOIN share_links sl ON sl.token = f.share_token
        WHERE sl.album_id = a.id)::bigint AS favorite_count,
      (SELECT COUNT(DISTINCT v.viewer_id)
         FROM view_events v
         JOIN share_links sl ON sl.token = v.share_token
        WHERE sl.album_id = a.id
          AND v.event_type = 'page_view')::bigint AS view_count,
      (SELECT token FROM share_links
        WHERE album_id = a.id
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC
        LIMIT 1) AS token
    FROM albums a
    WHERE a.status = 'published'
    ORDER BY a.updated_at DESC
    LIMIT 5
  `;

  const recent_albums: WidgetRecentAlbum[] = await Promise.all(
    albums.map(async (a) => {
      let cover_url: string | null = null;
      if (a.cover_photo_id) {
        // 1h presigned URL — within the revalidate window of any sane
        // consumer, so we don't pay the round-trip cost on every render.
        cover_url = await getPresignedUrl(variantKey(a.id, a.cover_photo_id, "web"), 3600);
      }
      return {
        title: a.title,
        subtitle: a.subtitle,
        cover_url,
        photo_count: n(a.photo_count),
        favorite_count: n(a.favorite_count),
        view_count: n(a.view_count),
        share_url: a.token ? `${baseUrl}/a/${a.token}` : null,
        status: a.status,
        updated_at: a.updated_at.toISOString(),
      };
    }),
  );

  const rawEvents = await sql<RawFavoriteEvent[]>`
    SELECT v.share_token, v.viewer_id, v.created_at, a.title AS album_title
      FROM view_events v
      JOIN share_links sl ON sl.token = v.share_token
      JOIN albums a ON a.id = sl.album_id
     WHERE v.event_type = 'favorite_add'
       AND v.created_at > now() - interval '7 days'
     ORDER BY v.created_at DESC
     LIMIT 200
  `;
  const recent_selections = groupFavoriteEvents(rawEvents).slice(0, 5);

  const value: WidgetSummary = {
    stats: {
      albums_total: n(stats.albums_total),
      albums_published: n(stats.albums_published),
      photos_total: n(stats.photos_total),
      storage_bytes: n(stats.storage_bytes),
    },
    recent_albums,
    recent_selections,
  };
  cache = { at: Date.now(), value };
  return value;
}

/** Test hook — drop the in-process cache so each test sees a fresh query. */
export function _resetWidgetCacheForTests(): void {
  cache = null;
}
