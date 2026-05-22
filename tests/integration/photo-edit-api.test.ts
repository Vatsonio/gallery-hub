import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { setupTestDb, resetTestDb } from "./_helpers";
import { createAlbum, insertPhoto } from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { originalKey } from "@/lib/keys";
import { POST } from "@/app/api/photos/[id]/edit/route";
import { getBoss } from "@/lib/jobs";
import { createSampleJpeg } from "../fixtures/createSampleJpeg";
import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await setupTestDb();
  if (!dockerOff) await ensureBucket();
}, 60_000);

afterAll(async () => {
  if (dockerOff) return;
  try {
    const boss = await getBoss();
    await boss.stop({ graceful: true, wait: false });
  } catch {
    // boss may not have started in some scenarios
  }
});

beforeEach(async () => { await resetTestDb(); });

function adminReq(body: unknown): Request {
  return new Request("http://t/api/photos/x/edit", {
    method: "POST",
    headers: { "x-test-admin": "1", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe.skipIf(dockerOff)("POST /api/photos/[id]/edit", () => {
  it("rotates the original and marks the photo as processing", async () => {
    const album = await createAlbum({ title: "EditTest", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const photoId = randomUUID();
    await insertPhoto({
      id: photoId, album_id: album.id, filename: "p.jpg",
      width: 2000, height: 1500, orig_bytes: 1, taken_at: null,
    });
    await sql`UPDATE photos SET status = 'ready' WHERE id = ${photoId}`;
    const buf = await createSampleJpeg(2000, 1500);
    const key = originalKey(album.id, photoId, "jpg");
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: buf, ContentType: "image/jpeg",
    }));

    const res = await POST(adminReq({ rotate: 90 }), {
      params: Promise.resolve({ id: photoId }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    // Photo status flipped back to processing so the worker re-renders.
    const rows = await sql<{ width: number; height: number; status: string }[]>`
      SELECT width, height, status FROM photos WHERE id = ${photoId}`;
    expect(rows[0].status).toBe("processing");

    // Re-read the original and confirm dimensions swapped (90° rotate).
    const got = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const rewritten = await streamToBuffer(got.Body as NodeJS.ReadableStream);
    const meta = await sharp(rewritten).metadata();
    // After a 90° rotate, the long edge moves to the short axis. Source was
    // 2000x1500, so post-rotate should be 1500x2000.
    expect(meta.width).toBe(1500);
    expect(meta.height).toBe(2000);
    // DB row matches stored bytes.
    expect(rows[0].width).toBe(meta.width);
    expect(rows[0].height).toBe(meta.height);
  }, 60_000);

  it("rejects invalid payloads with 400", async () => {
    const album = await createAlbum({ title: "Bad", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const photoId = randomUUID();
    await insertPhoto({
      id: photoId, album_id: album.id, filename: "p.jpg",
      width: 200, height: 150, orig_bytes: 1, taken_at: null,
    });
    await sql`UPDATE photos SET status = 'ready' WHERE id = ${photoId}`;
    const buf = await createSampleJpeg(200, 150);
    const key = originalKey(album.id, photoId, "jpg");
    await s3Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: "image/jpeg" }));

    const res = await POST(adminReq({ rotate: 45 }), {
      params: Promise.resolve({ id: photoId }),
    });
    expect(res.status).toBe(400);
  }, 60_000);

  it("returns 404 for an unknown photo id", async () => {
    const res = await POST(adminReq({ rotate: 90 }), {
      params: Promise.resolve({ id: randomUUID() }),
    });
    expect(res.status).toBe(404);
  }, 30_000);

  it("rejects unauthenticated requests with 401", async () => {
    const req = new Request("http://t/api/photos/x/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rotate: 90 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: randomUUID() }) });
    expect(res.status).toBe(401);
  });
});
