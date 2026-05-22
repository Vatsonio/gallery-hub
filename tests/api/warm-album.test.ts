import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { POST } from "@/app/api/admin/albums/[slug]/warm/route";
import { createAlbum, insertPhoto } from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { runMigrations } from "@/../scripts/migrate";
import { __resetImgproxyContextForTests } from "@/lib/imgproxy";

const TEST_KEY_HEX = "0011223344556677889900aabbccddeeff";
const TEST_SALT_HEX = "ffeeddccbbaa00998877665544332211";

function mockReq(): Request {
  return new Request("http://t/api/admin/albums/x/warm", {
    method: "POST",
    headers: {
      "x-test-admin": "1",
      "content-type": "application/json",
      origin: "http://t",
      host: "t",
    },
    body: "{}",
  });
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  await ensureTestAdminUser();
});

beforeEach(() => {
  process.env.PUBLIC_IMGPROXY_URL = "https://img.test.local";
  process.env.IMGPROXY_KEY = TEST_KEY_HEX;
  process.env.IMGPROXY_SALT = TEST_SALT_HEX;
  process.env.IMGPROXY_BUCKET = "gallery-test";
  __resetImgproxyContextForTests();
});

afterEach(() => {
  delete process.env.PUBLIC_IMGPROXY_URL;
  delete process.env.IMGPROXY_KEY;
  delete process.env.IMGPROXY_SALT;
  delete process.env.IMGPROXY_BUCKET;
  __resetImgproxyContextForTests();
  vi.restoreAllMocks();
  // vi.stubGlobal isn't cleared by restoreAllMocks; without this, the
  // fetch stub leaks into later test files that use global fetch.
  vi.unstubAllGlobals();
});

describe("POST /api/admin/albums/[slug]/warm", () => {
  it("returns 404 on unknown slug", async () => {
    const res = await POST(mockReq(), { params: Promise.resolve({ slug: "nope-xyz" }) });
    expect(res.status).toBe(404);
  });

  it("returns {warmed: N, total: N} after hitting imgproxy for every photo", async () => {
    const a = await createAlbum({ title: "Warm", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    for (let i = 0; i < 3; i++) {
      await insertPhoto({
        id: crypto.randomUUID(),
        album_id: a.id,
        filename: `p${i}.jpg`,
        width: 4000,
        height: 3000,
        orig_bytes: 1,
        taken_at: null,
      });
    }
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetched.push(url);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      }),
    );

    const res = await POST(mockReq(), { params: Promise.resolve({ slug: a.slug }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { warmed: number; total: number };
    expect(j).toEqual({ warmed: 3, total: 3 });
    // 2 URLs per photo (thumb + web), 3 photos → 6 fetches.
    expect(fetched).toHaveLength(6);
  });

  it("returns {warmed:0,total:0} with skipped flag when imgproxy is disabled", async () => {
    delete process.env.PUBLIC_IMGPROXY_URL;
    __resetImgproxyContextForTests();
    const a = await createAlbum({ title: "Disabled", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    await insertPhoto({
      id: crypto.randomUUID(),
      album_id: a.id,
      filename: "p.jpg",
      width: 4000,
      height: 3000,
      orig_bytes: 1,
      taken_at: null,
    });
    const res = await POST(mockReq(), { params: Promise.resolve({ slug: a.slug }) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { warmed: number; total: number; skipped?: string };
    expect(j.warmed).toBe(0);
    expect(j.skipped).toBe("imgproxy-disabled");
  });

  it("returns 401 when admin auth is missing", async () => {
    const a = await createAlbum({ title: "Auth", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const req = new Request("http://t/api/admin/albums/x/warm", {
      method: "POST",
      headers: { origin: "http://t", host: "t" },
      body: "{}",
    });
    const res = await POST(req, { params: Promise.resolve({ slug: a.slug }) });
    expect(res.status).toBe(401);
  });
});
