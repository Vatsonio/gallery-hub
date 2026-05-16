import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, teardownTestDb, resetTestDb, seedAlbumWithPhotos } from "./_helpers";
import { ADMIN_PREVIEW_VIEWER_ID, VIEWER_COOKIE } from "@/lib/viewer";

// Cookie jar shim so the route's `cookies()` call returns whatever
// the individual test set. Mirrors the pattern in export.flow.test.ts
// but keeps a local mutable map so tests can swap the viewer.
const cookieStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const v = cookieStore.get(name);
      return v === undefined ? undefined : { name, value: v };
    },
    set: (name: string, value: string) => {
      cookieStore.set(name, value);
    },
  }),
}));

const skipIf = process.env.SKIP_TESTCONTAINERS === "1";

beforeAll(async () => {
  if (skipIf) return;
  await setupTestDb();
}, 180_000);
afterAll(async () => {
  if (skipIf) return;
  await teardownTestDb();
});

beforeEach(async () => {
  if (skipIf) return;
  await resetTestDb();
  cookieStore.clear();
});

interface JsonError {
  reason: string;
  message: string;
}

async function readJson(res: Response): Promise<JsonError> {
  const text = await res.text();
  return JSON.parse(text) as JsonError;
}

describe.skipIf(skipIf)("export probe + structured errors", () => {
  it("returns 204 when a real download would succeed (probe=1)", async () => {
    const { token } = await seedAlbumWithPhotos({ count: 2 });
    const { GET } = await import("@/app/api/export/[token]/route");
    const res = await GET(
      new Request(
        `http://localhost/api/export/${token}?scope=all&variant=original&probe=1`,
      ) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(204);
    // 204 must have an empty body — surface a leaked zip stream
    // immediately rather than letting the client mis-render a payload.
    expect(await res.text()).toBe("");
  });

  it("returns 404 + no_favorites JSON for a real viewer with zero favorites", async () => {
    const { token } = await seedAlbumWithPhotos({ count: 3 });
    cookieStore.set(VIEWER_COOKIE, "00000000-0000-0000-0000-000000000001");
    const { GET } = await import("@/app/api/export/[token]/route");
    const res = await GET(
      new Request(
        `http://localhost/api/export/${token}?scope=favorites&variant=original&probe=1`,
      ) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await readJson(res);
    expect(body.reason).toBe("no_favorites");
    expect(body.message).toMatch(/like some photos/i);
  });

  it("returns 404 + admin_preview_no_favorites when the admin-preview viewer probes favorites", async () => {
    const { token } = await seedAlbumWithPhotos({ count: 3 });
    // The middleware never mints a cookie for admin previews. Simulate
    // that path by leaving the viewer cookie unset — the route falls
    // back to ADMIN_PREVIEW_VIEWER_ID via the absent-cookie branch... no,
    // wait: the export route mints a UUID if none is present. To reach
    // the admin-preview branch we set the cookie explicitly to the
    // sentinel because the page-level resolver does the same.
    cookieStore.set(VIEWER_COOKIE, ADMIN_PREVIEW_VIEWER_ID);
    const { GET } = await import("@/app/api/export/[token]/route");
    const res = await GET(
      new Request(
        `http://localhost/api/export/${token}?scope=favorites&variant=original&probe=1`,
      ) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.reason).toBe("admin_preview_no_favorites");
    expect(body.message).toMatch(/private window/i);
  });

  it("returns 404 + empty_album JSON when there are no ready photos", async () => {
    const { token } = await seedAlbumWithPhotos({ count: 0 });
    const { GET } = await import("@/app/api/export/[token]/route");
    const res = await GET(
      new Request(
        `http://localhost/api/export/${token}?scope=all&variant=original&probe=1`,
      ) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.reason).toBe("empty_album");
    expect(body.message).toMatch(/no photos/i);
  });

  it("does not start a zip stream on a probe even when photos exist", async () => {
    const { token } = await seedAlbumWithPhotos({ count: 2 });
    const { GET } = await import("@/app/api/export/[token]/route");
    const res = await GET(
      new Request(
        `http://localhost/api/export/${token}?scope=all&variant=original&probe=1`,
      ) as never,
      { params: Promise.resolve({ token }) },
    );
    // 204 + zero-byte body proves the route exited before invoking
    // createFanOutZip + the MinIO upload pipeline. If a future change
    // accidentally streams during a probe this test will fail because
    // the content-type would flip to application/zip.
    expect(res.status).toBe(204);
    // 204 carries no content-type (or at most "application/json" for
    // edge runtimes that default one in); assert that it's NOT a zip
    // payload by checking it neither says so nor exposes a body.
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).not.toMatch(/zip/);
    expect(await res.text()).toBe("");
  });
});
