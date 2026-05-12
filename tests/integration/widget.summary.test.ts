import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, resetTestDb, seedAlbumWithPhotos } from "./_helpers";
import { sql } from "@/lib/db";
import { ensureBucket } from "@/lib/minio";

const skipIf = process.env.SKIP_TESTCONTAINERS === "1";
const WIDGET_TOKEN = "test-widget-token-32-chars-abcd1234567";

beforeAll(async () => {
  if (skipIf) return;
  process.env.WIDGET_TOKEN = WIDGET_TOKEN;
  process.env.PUBLIC_BASE_URL = "http://localhost:3000";
  await setupTestDb();
  await ensureBucket();
}, 180_000);

afterAll(async () => {
  if (skipIf) return;
  await teardownTestDb();
});

let token: string;

beforeEach(async () => {
  if (skipIf) return;
  await resetTestDb();
  // Reset the in-process cache between assertions so each test sees its
  // own seeded state instead of the previous test's snapshot.
  const mod = await import("@/lib/widgetQuery");
  mod._resetWidgetCacheForTests();

  ({ token } = await seedAlbumWithPhotos({ count: 2 }));
  await sql`UPDATE albums SET title = 'Anna & Oleh' WHERE id = (SELECT album_id FROM share_links WHERE token = ${token})`;

  // 3 favorite_add events within a 5-minute window from the same viewer →
  // one grouped selection of count=3.
  for (let i = 0; i < 3; i++) {
    await sql`
      INSERT INTO view_events (share_token, viewer_id, event_type, created_at)
      VALUES (${token}, ${"viewer-a4f12345"}, 'favorite_add', now() - (${i} * interval '1 minute'))
    `;
  }
  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type)
    VALUES (${token}, ${"viewer-anyone"}, 'page_view')
  `;
});

function bearer(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/widget/summary", { headers }) as Request;
}

describe.skipIf(skipIf)("/api/widget/summary", () => {
  it("rejects missing bearer", async () => {
    const { GET } = await import("@/app/api/widget/summary/route");
    const res = await GET(bearer() as never);
    expect(res.status).toBe(401);
  });

  it("rejects wrong bearer", async () => {
    const { GET } = await import("@/app/api/widget/summary/route");
    const res = await GET(bearer({ Authorization: "Bearer wrong-token-here-1234567890ab" }) as never);
    expect(res.status).toBe(401);
  });

  it("returns the spec-shaped JSON with valid bearer", async () => {
    const { GET } = await import("@/app/api/widget/summary/route");
    const res = await GET(bearer({ Authorization: `Bearer ${WIDGET_TOKEN}` }) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      stats: {
        albums_total: expect.any(Number),
        albums_published: expect.any(Number),
        photos_total: expect.any(Number),
        storage_bytes: expect.any(Number),
      },
      recent_albums: expect.any(Array),
      recent_selections: expect.any(Array),
    });
    expect(body.stats.photos_total).toBe(2);
    expect(body.recent_albums[0]).toMatchObject({
      title: "Anna & Oleh",
      photo_count: 2,
      view_count: 1,
    });
    expect(body.recent_selections[0]).toMatchObject({
      album_title: "Anna & Oleh",
      added_count: 3,
      viewer_id_short: "viewer-a",
      at: expect.any(String),
    });
  });

  it("rate-limits after 6 calls / minute", async () => {
    // Use a distinct token to get a fresh sliding-window bucket — the
    // limiter is keyed by the configured token, so a token swap is the
    // simplest way to avoid leaking state from earlier tests' calls.
    const altToken = "alt-widget-token-32-chars-abcd123456";
    const prev = process.env.WIDGET_TOKEN;
    process.env.WIDGET_TOKEN = altToken;
    try {
      const { GET } = await import("@/app/api/widget/summary/route");
      const url = (h: Record<string, string>) =>
        new Request("http://localhost/api/widget/summary", { headers: h }) as never;
      for (let i = 0; i < 6; i++) {
        const r = await GET(url({ Authorization: `Bearer ${altToken}` }));
        expect(r.status).toBe(200);
      }
      const r = await GET(url({ Authorization: `Bearer ${altToken}` }));
      expect(r.status).toBe(429);
      expect(r.headers.get("Retry-After")).toBe("60");
    } finally {
      process.env.WIDGET_TOKEN = prev;
    }
  });

  it("returns 503 when WIDGET_TOKEN is unset", async () => {
    const prev = process.env.WIDGET_TOKEN;
    delete process.env.WIDGET_TOKEN;
    const { GET } = await import("@/app/api/widget/summary/route");
    const res = await GET(bearer({ Authorization: `Bearer ${WIDGET_TOKEN}` }) as never);
    expect(res.status).toBe(503);
    process.env.WIDGET_TOKEN = prev;
  });
});

describe.skipIf(skipIf)("/chikaq insights aggregators", () => {
  it("loadInsightsStats counts albums + photos + bytes", async () => {
    const { loadInsightsStats } = await import("@/lib/widgetQuery");
    const s = await loadInsightsStats();
    expect(s.albums_total).toBeGreaterThanOrEqual(1);
    expect(s.photos_total).toBe(2);
    expect(s.storage_bytes).toBe(4_000_000); // 2 × 2 000 000 bytes from the seed
  });

  it("loadViewsTrend30d returns a day bucket with the seeded page_view", async () => {
    const { loadViewsTrend30d } = await import("@/lib/widgetQuery");
    const trend = await loadViewsTrend30d();
    // The seed inserts exactly one page_view for the album; trend should
    // collapse to one day with views >= 1.
    expect(trend.length).toBeGreaterThanOrEqual(1);
    const total = trend.reduce((s, p) => s + p.views, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it("loadTopAlbums30d ranks the seeded album with one distinct viewer", async () => {
    const { loadTopAlbums30d } = await import("@/lib/widgetQuery");
    const rows = await loadTopAlbums30d(5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ title: "Anna & Oleh", views: 1 });
  });

  it("loadRecentActivity24h merges favorite groups + page_views", async () => {
    const { loadRecentActivity24h } = await import("@/lib/widgetQuery");
    const rows = await loadRecentActivity24h(20);
    // Seed has 3 favorite_add + 1 page_view → grouping collapses favs into one row.
    const fav = rows.find((r) => r.kind === "favorite");
    const view = rows.find((r) => r.kind === "page_view");
    expect(fav).toBeTruthy();
    expect(fav?.detail).toBe("+3 hearted");
    expect(view).toBeTruthy();
  });
});

describe("analytics safeCapture", () => {
  it("does not throw when POSTHOG_KEY is unset", async () => {
    const prev = process.env.POSTHOG_KEY;
    delete process.env.POSTHOG_KEY;
    const { safeCapture, getPostHogClient, _resetAnalyticsForTests } = await import(
      "@/lib/analytics"
    );
    _resetAnalyticsForTests();
    expect(getPostHogClient()).toBeNull();
    expect(() =>
      safeCapture({ distinctId: "v1", event: "noop", properties: { ok: true } }),
    ).not.toThrow();
    if (prev !== undefined) process.env.POSTHOG_KEY = prev;
    _resetAnalyticsForTests();
  });
});
