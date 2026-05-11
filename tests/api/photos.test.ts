import { describe, it, expect, beforeAll, vi } from "vitest";
import { GET } from "@/app/api/albums/[slug]/photos/route";
import { createAlbum, insertPhoto } from "@/lib/albums";
import { runMigrations } from "@/../scripts/migrate";

function mockReq(): Request {
  return new Request("http://t/api/albums/x/photos", {
    headers: { "x-test-admin": "1" },
  });
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
});

describe("GET /api/albums/[slug]/photos", () => {
  it("returns photos sorted by sort_order", async () => {
    const a = await createAlbum({ title: "PollA", subtitle: null, status: "draft" });
    const p1 = crypto.randomUUID();
    await insertPhoto({ id: p1, album_id: a.id, filename: "a.jpg", width: 100, height: 80, orig_bytes: 1, taken_at: null });
    const res = await GET(mockReq(), { params: Promise.resolve({ slug: a.slug }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.photos).toHaveLength(1);
    expect(json.photos[0].id).toBe(p1);
    expect(json.photos[0].status).toBe("processing");
  });

  it("404s on unknown slug", async () => {
    const res = await GET(mockReq(), { params: Promise.resolve({ slug: "nope-x" }) });
    expect(res.status).toBe(404);
  });
});
