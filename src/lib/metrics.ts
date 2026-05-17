import { sql } from "@/lib/db";

// Internal metrics aggregations for /admin/metrics (owner-only). All queries
// run server-side and are unauthenticated to the DB — gate access at the
// page level. Every view_events query is bounded by an indexed predicate
// (event_type + created_at) so we never seq-scan the table.

export interface StorageMetrics {
  bytes: number;
  photos: number;
  albums: number;
}

export interface ViewsByDayPoint {
  /** YYYY-MM-DD (UTC). */
  date: string;
  count: number;
}

export interface ViewsMetrics {
  views7d: number;
  views7dPrior: number;
  activeViewers7d: number;
  newViewers7d: number;
  viewsByDay30d: ViewsByDayPoint[];
}

export interface FavoritesMetrics {
  favorites7d: number;
  favoritesAllTime: number;
}

export interface TopAlbumMetric {
  id: string;
  slug: string;
  title: string;
  views30d: number;
  favoritesLifetime: number;
  downloadsLifetime: number;
  created_at: string;
}

export interface RecentExport {
  id: string;
  albumTitle: string;
  scope: string;
  variant: string;
  bytes: number;
  created_at: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  role: "owner" | "admin";
  name: string | null;
  last_login_at: string | null;
}

export interface SystemHealth {
  photosByStatus: { ready: number; processing: number; uploading: number };
  viewEventsRows: number;
  viewEventsBytes: number;
  admins: AdminUserRow[];
}

function num(v: bigint | string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  return Number(v);
}

interface StorageRow {
  bytes: bigint | string | null;
  photos: bigint | string | null;
  albums: bigint | string | null;
}

export async function getStorageMetrics(): Promise<StorageMetrics> {
  const rows = await sql<StorageRow[]>`
    SELECT
      COALESCE(SUM(p.orig_bytes), 0)::bigint AS bytes,
      COUNT(p.id)::bigint                    AS photos,
      COUNT(DISTINCT p.album_id)::bigint     AS albums
    FROM photos p
    WHERE p.status = 'ready'
  `;
  const r = rows[0];
  return { bytes: num(r?.bytes), photos: num(r?.photos), albums: num(r?.albums) };
}

interface CountRow { count: bigint | string | null }
interface DayRow { day: Date | string; count: bigint | string | null }

export async function getViewsMetrics(): Promise<ViewsMetrics> {
  const [views7dRows, viewsPriorRows, viewersRows, newViewersRows, byDayRows] = await Promise.all([
    sql<CountRow[]>`
      SELECT COUNT(*)::bigint AS count
        FROM view_events
       WHERE event_type = 'page_view'
         AND created_at > now() - interval '7 days'
    `,
    sql<CountRow[]>`
      SELECT COUNT(*)::bigint AS count
        FROM view_events
       WHERE event_type = 'page_view'
         AND created_at > now() - interval '14 days'
         AND created_at <= now() - interval '7 days'
    `,
    sql<CountRow[]>`
      SELECT COUNT(DISTINCT viewer_id)::bigint AS count
        FROM view_events
       WHERE created_at > now() - interval '7 days'
    `,
    sql<CountRow[]>`
      SELECT COUNT(*)::bigint AS count
      FROM (
        SELECT viewer_id, MIN(created_at) AS first_seen
          FROM view_events
         GROUP BY viewer_id
      ) v
      WHERE v.first_seen > now() - interval '7 days'
    `,
    sql<DayRow[]>`
      SELECT date_trunc('day', created_at)::date AS day,
             COUNT(*)::bigint                    AS count
        FROM view_events
       WHERE event_type = 'page_view'
         AND created_at > now() - interval '30 days'
       GROUP BY 1
       ORDER BY 1 ASC
    `,
  ]);

  const dayMap = new Map<string, number>();
  for (const r of byDayRows) {
    const d = r.day instanceof Date ? r.day : new Date(r.day);
    dayMap.set(d.toISOString().slice(0, 10), num(r.count));
  }
  const viewsByDay30d: ViewsByDayPoint[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    viewsByDay30d.push({ date: key, count: dayMap.get(key) ?? 0 });
  }

  return {
    views7d: num(views7dRows[0]?.count),
    views7dPrior: num(viewsPriorRows[0]?.count),
    activeViewers7d: num(viewersRows[0]?.count),
    newViewers7d: num(newViewersRows[0]?.count),
    viewsByDay30d,
  };
}

export async function getFavoritesMetrics(): Promise<FavoritesMetrics> {
  const [recentRows, totalRows] = await Promise.all([
    sql<CountRow[]>`
      SELECT COUNT(*)::bigint AS count
        FROM favorites
       WHERE created_at > now() - interval '7 days'
    `,
    sql<CountRow[]>`SELECT COUNT(*)::bigint AS count FROM favorites`,
  ]);
  return {
    favorites7d: num(recentRows[0]?.count),
    favoritesAllTime: num(totalRows[0]?.count),
  };
}

interface TopAlbumRow {
  id: string;
  slug: string;
  title: string;
  views30d: bigint | string | null;
  favorites_lifetime: bigint | string | null;
  downloads_lifetime: bigint | string | null;
  created_at: Date;
}

export async function getTopAlbums(limit = 10): Promise<TopAlbumMetric[]> {
  // Single round-trip: sub-selects per album are bounded by the album row
  // count which is small (hundreds, not millions). The view_events
  // sub-select is the costly one but is gated by the indexed
  // (event_type, created_at) predicate and joined to share_links → album_id.
  const rows = await sql<TopAlbumRow[]>`
    WITH ranked AS (
      SELECT a.id, a.slug, a.title, a.created_at,
        (
          SELECT COUNT(*)::bigint
            FROM view_events v
            JOIN share_links sl ON sl.token = v.share_token
           WHERE sl.album_id = a.id
             AND v.event_type = 'page_view'
             AND v.created_at > now() - interval '30 days'
        ) AS views30d,
        (
          SELECT COUNT(*)::bigint
            FROM favorites f
            JOIN share_links sl ON sl.token = f.share_token
           WHERE sl.album_id = a.id
        ) AS favorites_lifetime,
        (
          SELECT COUNT(*)::bigint
            FROM view_events v
            JOIN share_links sl ON sl.token = v.share_token
           WHERE sl.album_id = a.id
             AND v.event_type = 'download'
        ) AS downloads_lifetime
      FROM albums a
      WHERE a.deleted_at IS NULL
    )
    SELECT id, slug, title, views30d, favorites_lifetime, downloads_lifetime, created_at
      FROM ranked
     ORDER BY views30d DESC, favorites_lifetime DESC, created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    views30d: num(r.views30d),
    favoritesLifetime: num(r.favorites_lifetime),
    downloadsLifetime: num(r.downloads_lifetime),
    created_at: r.created_at.toISOString(),
  }));
}

interface ExportRow {
  id: bigint | string;
  album_title: string;
  details: { scope?: string; variant?: string; bytes?: number } | null;
  created_at: Date;
}

export async function getRecentExports(limit = 20): Promise<RecentExport[]> {
  const rows = await sql<ExportRow[]>`
    SELECT v.id, a.title AS album_title, v.details, v.created_at
      FROM view_events v
      JOIN share_links sl ON sl.token = v.share_token
      JOIN albums a       ON a.id    = sl.album_id
     WHERE v.event_type = 'download'
     ORDER BY v.created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: String(r.id),
    albumTitle: r.album_title,
    scope: r.details?.scope ?? "unknown",
    variant: r.details?.variant ?? "unknown",
    bytes: typeof r.details?.bytes === "number" ? r.details.bytes : 0,
    created_at: r.created_at.toISOString(),
  }));
}

interface PhotoStatusRow { status: string; count: bigint | string | null }
interface RelSizeRow { bytes: bigint | string | null }
interface AdminDbRow {
  id: string;
  email: string;
  role: "owner" | "admin";
  name: string | null;
  last_login_at: Date | null;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const [statusRows, relRows, eventCountRows, adminRows] = await Promise.all([
    sql<PhotoStatusRow[]>`
      SELECT status::text AS status, COUNT(*)::bigint AS count
        FROM photos
       GROUP BY status
    `,
    sql<RelSizeRow[]>`SELECT pg_total_relation_size('view_events')::bigint AS bytes`,
    sql<CountRow[]>`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'view_events'`,
    sql<AdminDbRow[]>`
      SELECT id, email, role, name, last_login_at
        FROM admin_users
       WHERE disabled_at IS NULL
       ORDER BY last_login_at DESC NULLS LAST, created_at ASC
    `,
  ]);

  const byStatus: SystemHealth["photosByStatus"] = { ready: 0, processing: 0, uploading: 0 };
  for (const r of statusRows) {
    const c = num(r.count);
    if (r.status === "ready") byStatus.ready = c;
    else if (r.status === "processing") byStatus.processing = c;
    else if (r.status === "uploading") byStatus.uploading = c;
  }

  return {
    photosByStatus: byStatus,
    viewEventsRows: num(eventCountRows[0]?.count),
    viewEventsBytes: num(relRows[0]?.bytes),
    admins: adminRows.map((a) => ({
      id: a.id,
      email: a.email,
      role: a.role,
      name: a.name,
      last_login_at: a.last_login_at ? a.last_login_at.toISOString() : null,
    })),
  };
}
