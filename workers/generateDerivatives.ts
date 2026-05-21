import { GetObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { s3Client, BUCKET } from "@/lib/minio";
import { readPhotoExif, readTakenAt } from "@/lib/images";
import { computeThumbhash } from "@/lib/thumbhash";
import { finalizePhotoMetadata } from "@/lib/albums";
import type { GenerateDerivativesJobData } from "@/lib/types";

/**
 * Pull the GetObject body into a Buffer the cheap way. The AWS SDK v3
 * StreamingBlobPayloadOutputTypes already exposes
 * .transformToByteArray() which uses a tight internal collector
 * (single typed-array allocation, no chunk array + Buffer.concat()
 * overhead from the old streamToBuffer helper).
 *
 * Buffer.from(Uint8Array) shares the underlying ArrayBuffer in Node
 * — no copy, just a header allocation.
 */
async function bodyToBuffer(body: { transformToByteArray: () => Promise<Uint8Array> }): Promise<Buffer> {
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Read sharp metadata + apply EXIF orientation to width/height. sharp's
 * `.rotate().metadata()` is misleading: `.rotate()` only takes effect at
 * actual encode time, while `.metadata()` reads the JPEG/PNG/WEBP header
 * verbatim. iPhone portrait shots come off the sensor as 4032×3024 landscape
 * pixels with EXIF Orientation=6 (rotate 90° CW for display); without
 * swapping ourselves, the gallery's justified-row layout would treat
 * them as landscape while imgproxy serves them rotated as portrait —
 * cells end up the wrong shape.
 *
 * Orientation values 5–8 are the rotated-90° set; 1 (or null) is upright.
 */
async function readDimensions(buf: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const orient = meta.orientation ?? 1;
  const rotated = orient >= 5 && orient <= 8;
  return {
    width: rotated ? h : w,
    height: rotated ? w : h,
  };
}

/**
 * Metadata-only derivative worker for the imgproxy era. Replaces the old
 * 5-variant pipeline (thumb/web/large WEBP + web/large AVIF) that the
 * pre-encode worker used to bake on upload. Every variant is now served
 * on-demand by imgproxy reading the original from MinIO — see
 * src/lib/imgproxy.ts for the URL signing format.
 *
 * What the worker still owns (the things imgproxy can't compute):
 *   1. EXIF orientation-corrected dimensions (authoritative — the client
 *      uploads these too but server-side is the trust anchor).
 *   2. taken_at, parsed from EXIF DateTimeOriginal / CreateDate.
 *   3. ThumbHash placeholder bytes (rendered behind every tile until the
 *      imgproxy variant arrives).
 *   4. Status transition 'processing' → 'ready'.
 *
 * Hot-path budget: ~80–120 ms per photo on a 4-core dev box (single
 * MinIO GET + sharp.metadata() + exifr.parse() + thumbhash encode +
 * one UPDATE). Down from 5–15 s in the WEBP/AVIF era.
 */
export async function handleGenerateDerivatives(
  data: GenerateDerivativesJobData,
): Promise<void> {
  const obj = await s3Client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: data.key }),
  );
  if (!obj.Body) throw new Error(`empty body for ${data.key}`);
  const buf = await bodyToBuffer(obj.Body as { transformToByteArray: () => Promise<Uint8Array> });

  // The four reads operate on the same Buffer and don't share state,
  // so kick them off in parallel. Promise.all returns in input order.
  // readPhotoExif is exifr-based (same library as readTakenAt) so its
  // marginal cost is dominated by the JSON serialisation, not the EXIF
  // parse — both pulls hit the same exifr cache on the buffer.
  const [{ width, height }, takenAt, thumbhash, exif] = await Promise.all([
    readDimensions(buf),
    readTakenAt(buf),
    computeThumbhash(buf),
    readPhotoExif(buf),
  ]);

  await finalizePhotoMetadata(data.photo_id, {
    width,
    height,
    takenAt,
    thumbhash,
    exif,
  });
}
