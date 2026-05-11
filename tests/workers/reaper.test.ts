import { describe, it, expect, beforeAll } from "vitest";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { handleReap } from "../../workers/reaper";
import { createAlbum, softDeleteAlbum, getAlbumById, insertPhoto } from "@/lib/albums";
import { originalKey } from "@/lib/keys";
import { runMigrations } from "../../scripts/migrate";

async function objectExists(key: string): Promise<boolean> {
  try { await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

beforeAll(async () => {
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  if (!dockerOff) await ensureBucket();
}, 60_000);

describe.skipIf(dockerOff)("handleReap", () => {
  it("hard-deletes soft-deleted album, removes its MinIO objects", async () => {
    const album = await createAlbum({ title: "ToReap", subtitle: null, status: "draft" });
    const photoId = crypto.randomUUID();
    await insertPhoto({ id: photoId, album_id: album.id, filename: "z.jpg", width: 10, height: 10, orig_bytes: 1, taken_at: null });
    const key = originalKey(album.id, photoId, "jpg");
    await s3Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from("x"), ContentType: "image/jpeg" }));

    await softDeleteAlbum(album.id);
    await handleReap();

    expect(await objectExists(key)).toBe(false);
    expect(await getAlbumById(album.id)).toBeNull();
  }, 60_000);
});
