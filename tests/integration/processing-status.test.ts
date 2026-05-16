import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDb, resetTestDb } from "./_helpers";
import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
}, 60_000);

beforeEach(async () => {
  await resetTestDb();
});

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

async function makeAlbum(slug: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO albums (id, slug, title, status)
    VALUES (${id}, ${slug}, ${"Test " + slug}, 'draft')
  `;
  return id;
}

async function insertPhoto(albumId: string, status: string, ageSeconds: number): Promise<string> {
  const id = randomUUID();
  // Plant the created_at backwards so the median TTR sample has a known
  // delta against now(). `updated_at` defaults to now() on insert.
  await sql`
    INSERT INTO photos (id, album_id, filename, width, height, orig_bytes, sort_order, status, created_at)
    VALUES (
      ${id}, ${albumId}, ${id + ".jpg"}, 100, 100, 1000, 0, ${status},
      now() - (${ageSeconds} * interval '1 second')
    )
  `;
  return id;
}

function buildRequest(slug: string): Request {
  return new Request(`http://localhost/api/albums/${slug}/processing-status`, {
    // The route's `requireAdminSession` accepts an `x-test-admin: 1`
    // header in NODE_ENV=test; vitest sets that automatically so the
    // header is enough to satisfy the auth gate.
    headers: { "x-test-admin": "1" },
  });
}

describe.skipIf(dockerOff)("/api/albums/[slug]/processing-status", () => {
  it("returns zero-state shape when the album has no photos", async () => {
    await makeAlbum("empty");
    const { GET } = await import("@/app/api/albums/[slug]/processing-status/route");
    const res = await GET(buildRequest("empty") as never, { params: Promise.resolve({ slug: "empty" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      total: 0,
      ready: 0,
      processing: 0,
      uploading: 0,
      median_ttr_seconds: null,
      eta_seconds: null,
    });
  });

  it("404s for unknown slugs", async () => {
    const { GET } = await import("@/app/api/albums/[slug]/processing-status/route");
    const res = await GET(buildRequest("ghost") as never, { params: Promise.resolve({ slug: "ghost" }) });
    expect(res.status).toBe(404);
  });

  it("counts photos by status and exposes the totals", async () => {
    const albumId = await makeAlbum("counts");
    await insertPhoto(albumId, "ready", 0);
    await insertPhoto(albumId, "ready", 0);
    await insertPhoto(albumId, "processing", 0);
    await insertPhoto(albumId, "uploading", 0);
    const { GET } = await import("@/app/api/albums/[slug]/processing-status/route");
    const res = await GET(buildRequest("counts") as never, { params: Promise.resolve({ slug: "counts" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(4);
    expect(body.ready).toBe(2);
    expect(body.processing).toBe(1);
    expect(body.uploading).toBe(1);
  });

  it("estimates eta_seconds when there are recent ready samples plus active processing", async () => {
    const albumId = await makeAlbum("eta");
    // Plant two ready photos with a known created_at delta so the median
    // is well-defined. updated_at defaulted to now() — created_at sits 2s
    // earlier — so the per-photo time-to-ready is ~2s.
    await insertPhoto(albumId, "ready", 2);
    await insertPhoto(albumId, "ready", 2);
    // Three more in processing. ETA should be ~ 3 × 2 = 6 seconds (give
    // or take a fraction depending on test runtime).
    await insertPhoto(albumId, "processing", 0);
    await insertPhoto(albumId, "processing", 0);
    await insertPhoto(albumId, "processing", 0);

    const { GET } = await import("@/app/api/albums/[slug]/processing-status/route");
    const res = await GET(buildRequest("eta") as never, { params: Promise.resolve({ slug: "eta" }) });
    const body = await res.json();
    expect(body.processing).toBe(3);
    expect(body.median_ttr_seconds).toBeGreaterThanOrEqual(1.5);
    expect(body.median_ttr_seconds).toBeLessThanOrEqual(3.5);
    expect(body.eta_seconds).not.toBeNull();
    expect(body.eta_seconds).toBeGreaterThanOrEqual(3);
    expect(body.eta_seconds).toBeLessThanOrEqual(12);
  });

  it("returns null eta when nothing is processing", async () => {
    const albumId = await makeAlbum("calm");
    await insertPhoto(albumId, "ready", 1);
    const { GET } = await import("@/app/api/albums/[slug]/processing-status/route");
    const res = await GET(buildRequest("calm") as never, { params: Promise.resolve({ slug: "calm" }) });
    const body = await res.json();
    expect(body.eta_seconds).toBeNull();
  });
});
