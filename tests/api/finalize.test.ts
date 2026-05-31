import { describe, it, expect, beforeAll, vi } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { POST } from "@/app/api/upload/finalize/route";
import { createAlbum, listPhotos } from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { originalKey } from "@/lib/keys";
import { runMigrations } from "@/../scripts/migrate";

function mockReq(body: unknown): Request {
  return new Request("http://t/api/upload/finalize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-admin": "1" },
    body: JSON.stringify(body),
  });
}

async function putObject(albumId: string, photoId: string, bytes: Buffer): Promise<void> {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: originalKey(albumId, photoId, "jpg"),
    Body: bytes,
    ContentType: "image/jpeg",
  }));
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  await ensureTestAdminUser();
  await ensureBucket();
});

describe("POST /api/upload/finalize", () => {
  it("inserts photos at status=processing with the REAL byte size and enqueues jobs", async () => {
    const a = await createAlbum({ title: "Fin", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const photo_id_1 = crypto.randomUUID();
    const photo_id_2 = crypto.randomUUID();
    // F2: the uploaded object's ContentLength — not the client-claimed
    // `size` — must become orig_bytes. Upload distinct real sizes.
    await putObject(a.id, photo_id_1, Buffer.alloc(2048, 7));
    await putObject(a.id, photo_id_2, Buffer.alloc(1024, 9));

    const res = await POST(mockReq({
      album_id: a.id,
      photos: [
        { photo_id: photo_id_1, filename: "a.jpg", width: 4000, height: 3000, size: 12345 },
        { photo_id: photo_id_2, filename: "b.jpg", width: 1000, height: 800, size: 5000 },
      ],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.inserted).toBe(2);

    const photos = await listPhotos(a.id);
    expect(photos).toHaveLength(2);
    expect(photos.every((p) => p.status === "processing")).toBe(true);
    // F2: orig_bytes reflects the real object size, not the spoofable client `size`.
    const byId = new Map(photos.map((p) => [p.id, p]));
    expect(Number(byId.get(photo_id_1)?.orig_bytes)).toBe(2048);
    expect(Number(byId.get(photo_id_2)?.orig_bytes)).toBe(1024);

    const boss = await getBoss();
    const jobs = await boss.fetch(GENERATE_DERIVATIVES_QUEUE);
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    expect(job).toBeTruthy();
    expect(job?.data).toMatchObject({ album_id: a.id });
    if (job) await boss.complete(GENERATE_DERIVATIVES_QUEUE, job.id);
  });

  it("skips phantom photos whose object was never uploaded (F41)", async () => {
    const a = await createAlbum({ title: "Phantom", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const ghost = crypto.randomUUID();
    const res = await POST(mockReq({
      album_id: a.id,
      photos: [{ photo_id: ghost, filename: "x.jpg", width: 100, height: 100, size: 999 }],
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).inserted).toBe(0);
    expect(await listPhotos(a.id)).toHaveLength(0);
  });

  it("rejects malformed photo metadata before insert (F28)", async () => {
    const a = await createAlbum({ title: "Bad", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const res = await POST(mockReq({
      album_id: a.id,
      photos: [{ photo_id: "not-a-uuid", filename: "x.jpg", width: 100, height: 100, size: 1 }],
    }));
    expect(res.status).toBe(400);
    expect(await listPhotos(a.id)).toHaveLength(0);
  });
});
