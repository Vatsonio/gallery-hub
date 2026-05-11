import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestDb, teardownTestDb, resetTestDb, seedAlbumWithPhotos } from "./_helpers";
import { sql } from "@/lib/db";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import AdmZip from "adm-zip";

// Cookie jar shim so the export route's `cookies()` call (server-side) returns
// a viewer cookie we control. The export route also writes a viewer cookie
// when missing — we let it write through and just record it.
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
  await ensureBucket();
}, 180_000);
afterAll(async () => {
  if (skipIf) return;
  await teardownTestDb();
});

async function putObject(key: string, body: Buffer): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: "image/jpeg" }),
  );
}

async function purgeExportsPrefix(): Promise<void> {
  const list = await s3Client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "exports/" }));
  for (const obj of list.Contents ?? []) {
    if (obj.Key) await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
  }
}

let token: string;
let albumId: string;
let photoIds: string[];

beforeEach(async () => {
  if (skipIf) return;
  await resetTestDb();
  cookieStore.clear();
  await purgeExportsPrefix();

  ({ token, albumId, photoIds } = await seedAlbumWithPhotos({ count: 3 }));
  // Seed real JPEG bodies under the originals key. seedAlbumWithPhotos used
  // generic `pN.jpg` filenames — match those so the route's filename-derived
  // extension lands on .jpg.
  for (let i = 0; i < photoIds.length; i++) {
    const jpeg = await sharp({
      create: { width: 80, height: 80, channels: 3, background: { r: (i + 1) * 50, g: 30, b: 60 } },
    }).jpeg().toBuffer();
    await putObject(`albums/${albumId}/${photoIds[i]}/original.jpg`, jpeg);
    await putObject(`albums/${albumId}/${photoIds[i]}/large.webp`, jpeg);
    await sql`UPDATE photos SET orig_bytes = ${jpeg.length}, large_bytes = ${jpeg.length} WHERE id = ${photoIds[i]}`;
  }
});

describe.skipIf(skipIf)("export flow", () => {
  it("returns a ZIP with all 3 photos and the right entry names", async () => {
    const { GET } = await import("@/app/api/export/[token]/route");
    const req = new Request(`http://localhost/api/export/${token}?scope=all&variant=original`);
    const res = await GET(req as never, { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    const entries = zip.getEntries().map((e) => e.entryName).sort();
    expect(entries).toEqual(["001-p0.jpg", "002-p1.jpg", "003-p2.jpg"]);
    for (const e of zip.getEntries()) {
      expect(e.getData().length).toBeGreaterThan(50);
    }
  });

  it("serves cached blob on second request (presigned redirect)", async () => {
    const { GET } = await import("@/app/api/export/[token]/route");
    // First request populates the cache.
    const first = await GET(
      new Request(`http://localhost/api/export/${token}?scope=all&variant=original`) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(first.status).toBe(200);
    // Drain the body so the upload PassThrough actually finishes.
    await first.arrayBuffer();
    // Allow the background MinIO upload to settle.
    await new Promise((r) => setTimeout(r, 1500));

    const second = await GET(
      new Request(`http://localhost/api/export/${token}?scope=all&variant=original`) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(second.status).toBe(302);
    const loc = second.headers.get("location");
    expect(loc).toBeTruthy();
    expect(loc!).toMatch(/X-Amz-Signature=/);
  });

  it("rejects when allow_download is false", async () => {
    await sql`UPDATE share_links SET allow_download = false WHERE token = ${token}`;
    const { GET } = await import("@/app/api/export/[token]/route");
    const res = await GET(
      new Request(`http://localhost/api/export/${token}?scope=all&variant=original`) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown token", async () => {
    const { GET } = await import("@/app/api/export/[token]/route");
    const res = await GET(
      new Request(`http://localhost/api/export/zzz000zzz000?scope=all&variant=original`) as never,
      { params: Promise.resolve({ token: "zzz000zzz000" }) },
    );
    expect(res.status).toBe(404);
  });
});
