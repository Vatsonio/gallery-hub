import { sql } from "@/lib/db";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { imgproxyWeb, photoVersionSeed } from "@/lib/imgproxy";
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

  // Resolve cover photos' filenames + updated_at in one batch so we can
  // build the imgproxy URLs without N+1 round-trips.
  const coverIds = albums.map((a) => a.cover_photo_id).filter((id): id is string => id !== null);
  type CoverRow = { id: string; filename: string; updated_at: Date };
  const coverPhotos = coverIds.length
    ? await sql<CoverRow[]>`SELECT id, filename, updated_at FROM photos WHERE id IN ${sql(coverIds)}`
    : [];
  const coverMap = new Map(coverPhotos.map((c) => [c.id, c]));

  const recent_albums: WidgetRecentAlbum[] = albums.map((a) => {
    let cover_url: string | null = null;
    if (a.cover_photo_id) {
      const cover = coverMap.get(a.cover_photo_id);
      if (cover) {
        // imgproxy URLs are content-addressed by signature, so cache-friendly
        // even without explicit revalidation windows. version=updated_at
        // invalidates on photo-edit; otherwise the URL is stable forever.
        cover_url = imgproxyWeb(
          originalKey(a.id, cover.id, resolveOriginalExt(cover.filename)),
          { version: photoVersionSeed(cover.updated_at) },
        );
      }
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
  });

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

// ---------------------------------------------------------------------------
// /chikaq insights aggregators.
//
// These run on demand (no caching) — the page is admin-gated and refreshes
// rarely. Keeping them cache-less also means the dashboard never serves stale
// numbers, which matters when the user is actively diagnosing traffic.
// ---------------------------------------------------------------------------

export interface InsightsStats {
  albums_total: number;
  photos_total: number;
  storage_bytes: number;
}

export interface ViewsTrendPoint {
  /** ISO date (YYYY-MM-DD) bucket. */
  day: string;
  views: number;
}

export interface TopAlbumRow {
  album_id: string;
  title: string;
  views: number;
}

export type RecentActivityKind = "favorite" | "page_view" | "download";

export interface RecentActivityRow {
  kind: RecentActivityKind;
  viewer_id_short: string;
  album_title: string;
  at: string;
  /** Extra context — favorited count for grouped runs, bytes for downloads. */
  detail: string | null;
}

interface TrendRow {
  day: Date;
  views: bigint | string;
}

interface TopAlbumDbRow {
  album_id: string;
  title: string;
  views: bigint | string;
}

interface RecentRawRow {
  share_token: string;
  viewer_id: string;
  event_type: string;
  created_at: Date;
  album_title: string;
  details: { bytes?: number; scope?: string; variant?: string } | null;
}

/**
 * Headline tiles for /chikaq: total albums, total photos, total bytes
 * across all originals. The widget cache shares the same SQL but adds
 * "published" splits and recent_albums; this version is intentionally
 * smaller because /chikaq has its own composition.
 */
export async function loadInsightsStats(): Promise<InsightsStats> {
  const rows = await sql<StatsRow[]>`
    SELECT
      (SELECT COUNT(*) FROM albums)::bigint AS albums_total,
      (SELECT COUNT(*) FROM albums WHERE status = 'published')::bigint AS albums_published,
      (SELECT COUNT(*) FROM photos)::bigint AS photos_total,
      (SELECT COALESCE(SUM(orig_bytes), 0) FROM photos)::bigint AS storage_bytes
  `;
  const r = rows[0];
  return {
    albums_total: n(r.albums_total),
    photos_total: n(r.photos_total),
    storage_bytes: n(r.storage_bytes),
  };
}

/**
 * Period switcher input for /chikaq. Values map to whole-day windows; "all"
 * skips the date filter entirely (use cautiously — view_events on a busy
 * site can be in the millions).
 */
export type ChikaqPeriod = "7d" | "30d" | "90d" | "all";

export function periodToDays(p: ChikaqPeriod): number | null {
  switch (p) {
    case "7d": return 7;
    case "30d": return 30;
    case "90d": return 90;
    case "all": return null;
  }
}

/** Parse a URL search-params value into a valid ChikaqPeriod. Falls back to 30d. */
export function parseChikaqPeriod(raw: string | null | undefined): ChikaqPeriod {
  if (raw === "7d" || raw === "30d" || raw === "90d" || raw === "all") return raw;
  return "30d";
}

/**
 * Daily views trend over the given period. Returns one entry per day with
 * at least one page_view; missing days are NOT zero-filled — the sparkline
 * renderer fills them client-side from the date range. Keeps the SQL
 * simple and lets the renderer decide the gap-handling story.
 *
 * `days=null` means "all time" (no date filter).
 */
export async function loadViewsTrend(days: number | null = 30): Promise<ViewsTrendPoint[]> {
  if (days === null) {
    const rows = await sql<TrendRow[]>`
      SELECT date_trunc('day', created_at)::date AS day,
             COUNT(*)::bigint AS views
        FROM view_events
       WHERE event_type = 'page_view'
       GROUP BY 1
       ORDER BY 1 ASC
    `;
    return rows.map((r) => ({
      day: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
      views: n(r.views),
    }));
  }
  const rows = await sql<TrendRow[]>`
    SELECT date_trunc('day', created_at)::date AS day,
           COUNT(*)::bigint AS views
      FROM view_events
     WHERE created_at > now() - (${days} * interval '1 day')
       AND event_type = 'page_view'
     GROUP BY 1
     ORDER BY 1 ASC
  `;
  return rows.map((r) => ({
    day: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
    views: n(r.views),
  }));
}

/** Legacy 30-day alias retained for any caller still wired to the old name. */
export async function loadViewsTrend30d(): Promise<ViewsTrendPoint[]> {
  return loadViewsTrend(30);
}

/**
 * Top N albums by distinct-viewer page_view count over the given period.
 * Distinct viewers (not raw events) is the metric that matters — a single
 * refresh-spam viewer can't inflate the leaderboard.
 *
 * `days=null` means "all time".
 */
export async function loadTopAlbums(limit: number = 5, days: number | null = 30): Promise<TopAlbumRow[]> {
  if (days === null) {
    const rows = await sql<TopAlbumDbRow[]>`
      SELECT a.id AS album_id, a.title, COUNT(DISTINCT v.viewer_id)::bigint AS views
        FROM view_events v
        JOIN share_links sl ON sl.token = v.share_token
        JOIN albums a       ON a.id    = sl.album_id
       WHERE v.event_type = 'page_view'
       GROUP BY a.id, a.title
       ORDER BY views DESC
       LIMIT ${limit}
    `;
    return rows.map((r) => ({
      album_id: r.album_id,
      title: r.title,
      views: n(r.views),
    }));
  }
  const rows = await sql<TopAlbumDbRow[]>`
    SELECT a.id AS album_id, a.title, COUNT(DISTINCT v.viewer_id)::bigint AS views
      FROM view_events v
      JOIN share_links sl ON sl.token = v.share_token
      JOIN albums a       ON a.id    = sl.album_id
     WHERE v.event_type = 'page_view'
       AND v.created_at > now() - (${days} * interval '1 day')
     GROUP BY a.id, a.title
     ORDER BY views DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    album_id: r.album_id,
    title: r.title,
    views: n(r.views),
  }));
}

/** Legacy 30-day alias retained for any caller still wired to the old name. */
export async function loadTopAlbums30d(limit: number = 5): Promise<TopAlbumRow[]> {
  return loadTopAlbums(limit, 30);
}

/**
 * Daily favorites/page_views/photos-created sparkline data for the four
 * stat tiles. Cheap aggregation — we return one map keyed by metric so the
 * /chikaq page can pull all four series in a single round-trip.
 *
 * `days=null` is treated as "last 365 days" so the sparkline doesn't try
 * to render thousands of bars in extreme cases.
 */
export interface TileSparklineSeries {
  photos: ViewsTrendPoint[];
  favorites: ViewsTrendPoint[];
  storage: ViewsTrendPoint[];
}

export async function loadTileSparklines(days: number | null = 30): Promise<TileSparklineSeries> {
  const window = days ?? 365;
  const photos = await sql<TrendRow[]>`
    SELECT date_trunc('day', created_at)::date AS day,
           COUNT(*)::bigint AS views
      FROM photos
     WHERE created_at > now() - (${window} * interval '1 day')
     GROUP BY 1
     ORDER BY 1 ASC
  `;
  const favorites = await sql<TrendRow[]>`
    SELECT date_trunc('day', created_at)::date AS day,
           COUNT(*)::bigint AS views
      FROM favorites
     WHERE created_at > now() - (${window} * interval '1 day')
     GROUP BY 1
     ORDER BY 1 ASC
  `;
  // Storage growth is a running SUM(orig_bytes) over photos.created_at —
  // we approximate it client-side by feeding the per-day created bytes as
  // a sparkline ("storage delta per day"). The cumulative form would
  // require a window function and the tile is happy with the delta shape.
  const storage = await sql<TrendRow[]>`
    SELECT date_trunc('day', created_at)::date AS day,
           COALESCE(SUM(orig_bytes), 0)::bigint AS views
      FROM photos
     WHERE created_at > now() - (${window} * interval '1 day')
     GROUP BY 1
     ORDER BY 1 ASC
  `;
  function toPoints(rows: TrendRow[]): ViewsTrendPoint[] {
    return rows.map((r) => ({
      day: (r.day instanceof Date ? r.day : new Date(r.day)).toISOString().slice(0, 10),
      views: n(r.views),
    }));
  }
  return {
    photos: toPoints(photos),
    favorites: toPoints(favorites),
    storage: toPoints(storage),
  };
}

/**
 * Last 24h activity feed, mixing page_view / favorite_add / download events
 * and collapsing the favorite_add runs through the existing viewerGrouping
 * window so a 10-photo selection burst shows as one row, not ten.
 */
export async function loadRecentActivity24h(limit: number = 20): Promise<RecentActivityRow[]> {
  const rows = await sql<RecentRawRow[]>`
    SELECT v.share_token, v.viewer_id, v.event_type, v.created_at,
           a.title AS album_title, v.details
      FROM view_events v
      JOIN share_links sl ON sl.token = v.share_token
      JOIN albums a       ON a.id    = sl.album_id
     WHERE v.created_at > now() - interval '24 hours'
       AND v.event_type IN ('page_view', 'favorite_add', 'download')
     ORDER BY v.created_at DESC
     LIMIT 500
  `;

  // Group the favorite_add runs through the shared windowing helper so the
  // feed shows "+12 favourites" instead of twelve consecutive heart rows.
  const favRows: RawFavoriteEvent[] = rows
    .filter((r) => r.event_type === "favorite_add")
    .map((r) => ({
      share_token: r.share_token,
      viewer_id: r.viewer_id,
      created_at: r.created_at,
      album_title: r.album_title,
    }));
  const grouped = groupFavoriteEvents(favRows);

  const out: RecentActivityRow[] = [];
  for (const g of grouped) {
    out.push({
      kind: "favorite",
      viewer_id_short: g.viewer_id_short,
      album_title: g.album_title,
      at: g.at,
      detail: `+${g.added_count} hearted`,
    });
  }
  for (const r of rows) {
    if (r.event_type === "page_view") {
      out.push({
        kind: "page_view",
        viewer_id_short: r.viewer_id.slice(0, 8),
        album_title: r.album_title,
        at: r.created_at.toISOString(),
        detail: null,
      });
    } else if (r.event_type === "download") {
      const bytes = r.details?.bytes;
      const mb = typeof bytes === "number" ? Math.max(1, Math.round(bytes / 1_000_000)) : null;
      out.push({
        kind: "download",
        viewer_id_short: r.viewer_id.slice(0, 8),
        album_title: r.album_title,
        at: r.created_at.toISOString(),
        detail: mb ? `${mb} MB` : null,
      });
    }
  }

  out.sort((a, b) => b.at.localeCompare(a.at));
  return out.slice(0, limit);
}
