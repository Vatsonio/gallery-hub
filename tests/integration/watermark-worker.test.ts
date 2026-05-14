import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET, ensureBucket } from "@/lib/minio";
import { setupTestDb, resetTestDb } from "./_helpers";
import { createAlbum, insertPhoto, updateAlbum } from "@/lib/albums";
import { originalKey, variantKey } from "@/lib/keys";
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

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe.skipIf(dockerOff)("derivative worker — watermark integration", () => {
  it("produces a watermarked web variant when albums.watermark_enabled = true", async () => {
    const albumOn = await createAlbum({ title: "WM_ON", subtitle: null, status: "draft" });
    const albumOff = await createAlbum({ title: "WM_OFF", subtitle: null, status: "draft" });
    await updateAlbum(albumOn.id, { watermarkEnabled: true, watermarkText: "TEST STAMP" });

    const buf = await createSampleJpeg(1200, 800);

    // Two photos, same source bytes, one in each album.
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

    // Both variants should exist...
    const got = (k: string) => s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }));
    const onWeb = await streamToBuffer((await got(variantKey(albumOn.id, pOn, "web"))).Body as NodeJS.ReadableStream);
    const offWeb = await streamToBuffer((await got(variantKey(albumOff.id, pOff, "web"))).Body as NodeJS.ReadableStream);

    // ...and they must differ — same source bytes, different stamping
    // decision means the stamped one carries the SVG overlay.
    expect(onWeb.equals(offWeb)).toBe(false);

    // Photo rows transitioned to ready.
    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM photos WHERE id IN ${sql([pOn, pOff])}`;
    expect(rows.every((r) => r.status === "ready")).toBe(true);
  }, 120_000);
});
