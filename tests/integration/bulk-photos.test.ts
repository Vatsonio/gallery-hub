import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "@/lib/db";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { setupTestDb, resetTestDb } from "./_helpers";
import { createAlbum, insertPhoto, bulkDeletePhotos, bulkMovePhotos, setCover, getAlbumById, listPhotos } from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { originalKey, variantKey } from "@/lib/keys";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function putBlob(key: string, body: string): Promise<void> {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: Buffer.from(body),
    ContentType: "image/jpeg",
  }));
}

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
  if (!dockerOff) await ensureBucket();
}, 60_000);

beforeEach(async () => {
  await resetTestDb();
});

describe.skipIf(dockerOff)("bulkDeletePhotos", () => {
  it("removes a batch of photos and clears cover if pointed at one", async () => {
    const album = await createAlbum({ title: "BulkDel", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (let i = 0; i < ids.length; i++) {
      await insertPhoto({
        id: ids[i], album_id: album.id, filename: `p${i}.jpg`,
        width: 100, height: 100, orig_bytes: 1, taken_at: null,
      });
    }
    await setCover(album.id, ids[0]);

    // Delete first two (including the cover photo).
    await bulkDeletePhotos(album.id, [ids[0], ids[1]]);

    const remaining = await listPhotos(album.id);
    expect(remaining.map((r) => r.id)).toEqual([ids[2]]);

    const reread = await getAlbumById(album.id);
    expect(reread?.cover_photo_id).toBeNull();
  });

  it("is a no-op on empty list", async () => {
    const album = await createAlbum({ title: "Empty", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    await bulkDeletePhotos(album.id, []);
    const rows = await listPhotos(album.id);
    expect(rows).toHaveLength(0);
  });
});

describe.skipIf(dockerOff)("bulkMovePhotos", () => {
  it("moves photos and their MinIO objects between albums", async () => {
    const src = await createAlbum({ title: "Src", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const dst = await createAlbum({ title: "Dst", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const pid = randomUUID();
    await insertPhoto({
      id: pid, album_id: src.id, filename: "x.jpg",
      width: 100, height: 100, orig_bytes: 1, taken_at: null,
    });

    // Seed an original + one variant in MinIO to verify both get copied.
    await putBlob(originalKey(src.id, pid, "jpg"), "ORIG");
    await putBlob(variantKey(src.id, pid, "web"), "WEB");

    await bulkMovePhotos(src.id, dst.id, [pid]);

    // DB now points at destination album.
    const rows = await sql<{ album_id: string }[]>`
      SELECT album_id FROM photos WHERE id = ${pid}`;
    expect(rows[0].album_id).toBe(dst.id);

    // Objects exist under destination prefix.
    expect(await objectExists(originalKey(dst.id, pid, "jpg"))).toBe(true);
    expect(await objectExists(variantKey(dst.id, pid, "web"))).toBe(true);

    // Source objects were cleaned up.
    expect(await objectExists(originalKey(src.id, pid, "jpg"))).toBe(false);
    expect(await objectExists(variantKey(src.id, pid, "web"))).toBe(false);

    // Body integrity preserved.
    const got = await s3Client.send(new GetObjectCommand({
      Bucket: BUCKET, Key: originalKey(dst.id, pid, "jpg"),
    }));
    const chunks: Buffer[] = [];
    for await (const c of got.Body as NodeJS.ReadableStream) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe("ORIG");
  }, 60_000);

  it("is a no-op when src == dst", async () => {
    const a = await createAlbum({ title: "Same", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const pid = randomUUID();
    await insertPhoto({
      id: pid, album_id: a.id, filename: "y.jpg",
      width: 100, height: 100, orig_bytes: 1, taken_at: null,
    });
    await bulkMovePhotos(a.id, a.id, [pid]);
    const rows = await sql<{ album_id: string }[]>`
      SELECT album_id FROM photos WHERE id = ${pid}`;
    expect(rows[0].album_id).toBe(a.id);
  });

  it("clears stale cover on the source album when the cover moves", async () => {
    const src = await createAlbum({ title: "SrcCov", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const dst = await createAlbum({ title: "DstCov", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const pid = randomUUID();
    await insertPhoto({
      id: pid, album_id: src.id, filename: "c.jpg",
      width: 100, height: 100, orig_bytes: 1, taken_at: null,
    });
    await setCover(src.id, pid);

    await bulkMovePhotos(src.id, dst.id, [pid]);
    const reread = await getAlbumById(src.id);
    expect(reread?.cover_photo_id).toBeNull();
  });
});
