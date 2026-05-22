import { describe, it, expect, beforeAll, vi } from "vitest";
import { POST } from "@/app/api/upload/presign/route";
import { createAlbum } from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { sql } from "@/lib/db";
import { runMigrations } from "@/../scripts/migrate";

function mockReq(body: unknown, authed = true): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authed) headers.set("x-test-admin", "1");
  return new Request("http://t/api/upload/presign", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  await ensureTestAdminUser();
  await sql`DELETE FROM photos`;
  await sql`DELETE FROM albums`;
});

describe("POST /api/upload/presign", () => {
  it("returns presigned URLs and pre-allocated photo ids", async () => {
    const album = await createAlbum({ title: "P", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const res = await POST(mockReq({
      album_id: album.id,
      files: [
        { filename: "a.jpg", size: 1024, contentType: "image/jpeg" },
        { filename: "b.png", size: 2048, contentType: "image/png" },
      ],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(2);
    expect(json.items[0].photo_id).toMatch(/-/);
    expect(json.items[0].put_url).toMatch(/X-Amz-Signature|signature/i);
    expect(json.items[0].key).toMatch(/^albums\/.+\/.+\/original\.jpg$/);
    expect(json.items[1].key).toMatch(/^albums\/.+\/.+\/original\.png$/);
  });

  it("400s on unsupported content-type", async () => {
    const album = await createAlbum({ title: "P2", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const res = await POST(mockReq({
      album_id: album.id,
      files: [{ filename: "x.pdf", size: 10, contentType: "application/pdf" }],
    }));
    expect(res.status).toBe(400);
  });

  it("404s on unknown album", async () => {
    const res = await POST(mockReq({
      album_id: "00000000-0000-0000-0000-000000000000",
      files: [{ filename: "a.jpg", size: 1, contentType: "image/jpeg" }],
    }));
    expect(res.status).toBe(404);
  });

  it("401s when not authed", async () => {
    const res = await POST(mockReq({ album_id: "x", files: [] }, false));
    expect(res.status).toBe(401);
  });
});
