import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-check";
import { getAlbumViewersDetail } from "@/lib/metrics";
import { lookupGeoBatch, geoipAvailable } from "@/lib/geoip";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NOTE: the dynamic segment is named `slug` to match the sibling routes
// (warm, photos, processing-status) — Next.js forbids two different param
// names at the same path level. The value passed here is actually the album
// id (the metrics drill-down has the id), which we use directly.
interface Ctx {
  params: Promise<{ slug: string }>;
}

/**
 * Owner-only drill-down behind the /admin/metrics "Top albums → Views(30d)"
 * cell. Returns one row per IP that viewed the album or tried its password,
 * with country (captured cf-ipcountry), city/region (resolved from the GeoIP
 * DB when GEOIP_DB_PATH is set), view counts, and password-attempt outcomes.
 */
export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });
  // Owner-only, matching the /admin/metrics page this is launched from.
  if (auth.role !== "owner") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug: albumId } = await ctx.params;
  const url = new URL(req.url);
  const daysRaw = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.floor(daysRaw))) : 30;

  const [rows, protRows, geoEnabled] = await Promise.all([
    getAlbumViewersDetail(albumId, days),
    sql<{ protected: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM share_links
         WHERE album_id = ${albumId} AND password_hash IS NOT NULL
      ) AS protected
    `,
    geoipAvailable(),
  ]);

  // Enrich city/region from the GeoIP DB for the distinct IPs shown. Prefer
  // the GeoIP country when present, else the cf-ipcountry captured at view time.
  const distinctIps = Array.from(new Set(rows.map((r) => r.ip).filter(Boolean)));
  const geo = await lookupGeoBatch(distinctIps);
  const enriched = rows.map((r) => {
    const g = geo.get(r.ip);
    return {
      ...r,
      country: g?.country ?? r.country,
      city: g?.city ?? null,
      region: g?.region ?? null,
    };
  });

  return NextResponse.json(
    {
      album_id: albumId,
      days,
      password_protected: protRows[0]?.protected ?? false,
      geoip_enabled: geoEnabled,
      rows: enriched,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
