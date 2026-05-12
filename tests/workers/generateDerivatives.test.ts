import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { handleGenerateDerivatives } from "../../workers/generateDerivatives";
import { createAlbum, insertPhoto, listPhotos } from "@/lib/albums";
import { originalKey, variantKey, avifVariantKey } from "@/lib/keys";
import { createSampleJpeg } from "../fixtures/createSampleJpeg";
import { runMigrations } from "../../scripts/migrate";

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  if (process.env.SKIP_TESTCONTAINERS === "1") return;
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  await ensureBucket();
}, 120_000);

describe("handleGenerateDerivatives", () => {
  it.skipIf(process.env.SKIP_TESTCONTAINERS === "1")(
    "produces WEBP thumb/web/large + AVIF web/large and flips status to ready",
    async () => {
      const album = await createAlbum({
        title: "Worker Test",
        subtitle: null,
        status: "draft"
      });
      const photoId = randomUUID();
      await insertPhoto({
        id: photoId,
        album_id: album.id,
        filename: "x.jpg",
        width: 2000,
        height: 1500,
        orig_bytes: 1,
        taken_at: null
      });
      const key = originalKey(album.id, photoId, "jpg");
      await s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: await createSampleJpeg(2000, 1500),
          ContentType: "image/jpeg"
        })
      );

      await handleGenerateDerivatives({
        album_id: album.id,
        photo_id: photoId,
        key
      });

      expect(await objectExists(variantKey(album.id, photoId, "thumb"))).toBe(true);
      expect(await objectExists(variantKey(album.id, photoId, "web"))).toBe(true);
      expect(await objectExists(variantKey(album.id, photoId, "large"))).toBe(true);
      expect(await objectExists(avifVariantKey(album.id, photoId, "web"))).toBe(true);
      expect(await objectExists(avifVariantKey(album.id, photoId, "large"))).toBe(true);

      const photos = await listPhotos(album.id);
      const photo = photos.find((p) => p.id === photoId);
      expect(photo?.status).toBe("ready");
    },
    120_000
  );
});
