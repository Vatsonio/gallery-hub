import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { setupTestDb, resetTestDb } from "./_helpers";
import { createAlbum, insertPhoto, updateAlbum } from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { originalKey } from "@/lib/keys";
import { handleGenerateDerivatives } from "../../workers/generateDerivatives";
import { createSampleJpeg } from "../fixtures/createSampleJpeg";
import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
  if (!dockerOff) await ensureBucket();
}, 60_000);

beforeEach(async () => { await resetTestDb(); });

describe.skipIf(dockerOff)("derivative worker — watermark integration (imgproxy era)", () => {
  it(
    "with watermark_enabled toggled the worker still flips status=ready (watermark composition happens lazily in imgproxy now)",
    async () => {
      // Imgproxy migration changed the contract: watermark is no longer
      // burned into pre-generated WEBP/AVIF variants at upload time. Instead,
      // when album.watermark_enabled is true the URL builder appends
      // imgproxy's `watermark` + `wm_url` processing steps so imgproxy
      // composites a watermark PNG onto every resize request. The worker
      // now only owns metadata (status, dimensions, taken_at, thumbhash),
      // so the assertion here is: the worker tolerates either flag without
      // touching pixels.
      const albumOn = await createAlbum({ title: "WM_ON", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
      const albumOff = await createAlbum({ title: "WM_OFF", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
      await updateAlbum(albumOn.id, { watermarkEnabled: true, watermarkText: "TEST STAMP" });

      const buf = await createSampleJpeg(1200, 800);

      const pOn = randomUUID();
      const pOff = randomUUID();
      await insertPhoto({
        id: pOn, album_id: albumOn.id, filename: "wm.jpg",
        width: 1200, height: 800, orig_bytes: buf.length, taken_at: null,
      });
      await insertPhoto({
        id: pOff, album_id: albumOff.id, filename: "wm.jpg",
        width: 1200, height: 800, orig_bytes: buf.length, taken_at: null,
      });

      const keyOn = originalKey(albumOn.id, pOn, "jpg");
      const keyOff = originalKey(albumOff.id, pOff, "jpg");
      for (const k of [keyOn, keyOff]) {
        await s3Client.send(new PutObjectCommand({
          Bucket: BUCKET, Key: k, Body: buf, ContentType: "image/jpeg",
        }));
      }

      await handleGenerateDerivatives({ album_id: albumOn.id, photo_id: pOn, key: keyOn });
      await handleGenerateDerivatives({ album_id: albumOff.id, photo_id: pOff, key: keyOff });

      // Both photos must reach status=ready regardless of watermark setting,
      // because watermark composition no longer happens in the worker.
      const rows = await sql<{ id: string; status: string; width: number; height: number; thumbhash: string | null }[]>`
        SELECT id, status, width, height, thumbhash FROM photos WHERE id IN ${sql([pOn, pOff])}`;
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.status === "ready")).toBe(true);
      expect(rows.every((r) => r.width === 1200 && r.height === 800)).toBe(true);
      expect(rows.every((r) => r.thumbhash && r.thumbhash.length > 0)).toBe(true);
    },
    120_000,
  );
});
