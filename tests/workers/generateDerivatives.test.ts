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

describe("handleGenerateDerivatives (imgproxy era)", () => {
  it.skipIf(process.env.SKIP_TESTCONTAINERS === "1")(
    "writes metadata-only (dimensions, taken_at, thumbhash, status=ready) and does NOT produce variant blobs",
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
        // Width/height intentionally wrong — worker must overwrite with
        // sharp-verified dimensions.
        filename: "x.jpg",
        width: 1,
        height: 1,
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

      // Hot-path correctness — every metadata field set + status flipped.
      const photos = await listPhotos(album.id);
      const photo = photos.find((p) => p.id === photoId);
      expect(photo?.status).toBe("ready");
      expect(photo?.width).toBe(2000);
      expect(photo?.height).toBe(1500);
      expect(photo?.thumbhash).toBeTruthy();
      expect(photo?.thumbhash?.length).toBeGreaterThan(10);

      // Variants must NOT have been written — imgproxy resizes on demand
      // from the original. The worker is metadata-only now.
      expect(await objectExists(variantKey(album.id, photoId, "thumb"))).toBe(false);
      expect(await objectExists(variantKey(album.id, photoId, "web"))).toBe(false);
      expect(await objectExists(variantKey(album.id, photoId, "large"))).toBe(false);
      expect(await objectExists(avifVariantKey(album.id, photoId, "web"))).toBe(false);
      expect(await objectExists(avifVariantKey(album.id, photoId, "large"))).toBe(false);
    },
    120_000
  );
});
