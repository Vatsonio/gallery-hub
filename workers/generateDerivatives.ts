import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET } from "@/lib/minio";
import {
  generatePrimaryVariants,
  generateAvifVariants,
  readTakenAt,
  type PrimaryVariants,
} from "@/lib/images";
import { computeThumbhash } from "@/lib/thumbhash";
import { variantKey, avifVariantKey } from "@/lib/keys";
import {
  markPhotoReady,
  writePhotoThumbhash,
  writePhotoVariantSizes,
  getAlbumWatermark,
} from "@/lib/albums";
import type { GenerateDerivativesJobData } from "@/lib/types";

/**
 * Pull the GetObject body into a Buffer the cheap way. The AWS SDK v3
 * StreamingBlobPayloadOutputTypes already exposes
 * .transformToByteArray() which uses a tight internal collector
 * (single typed-array allocation, no chunk array + Buffer.concat()
 * overhead from the old streamToBuffer helper). For 5–25 MB JPEGs
 * the saving is modest in absolute terms (5–15 ms) but every ms in
 * the worker pipeline ladders into the user-visible 'ready' time.
 *
 * Buffer.from(Uint8Array) shares the underlying ArrayBuffer in Node
 * — no copy, just a header allocation.
 */
async function bodyToBuffer(body: { transformToByteArray: () => Promise<Uint8Array> }): Promise<Buffer> {
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function putWebp(album: string, photo: string, name: "thumb" | "web" | "large", body: Buffer): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: variantKey(album, photo, name),
      Body: body,
      ContentType: "image/webp",
    }),
  );
}

async function putAvif(album: string, photo: string, name: "web" | "large", body: Buffer): Promise<void> {
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: avifVariantKey(album, photo, name),
      Body: body,
      ContentType: "image/avif",
    }),
  );
}

/**
 * Two-phase derivative pipeline:
 *
 *   Phase 1 (early-ready): thumb + web + large WEBPs land in MinIO,
 *     thumbhash + EXIF date are written to the DB, photo flips to
 *     status='ready'. Public pages immediately render the grid +
 *     lightbox.
 *   Phase 2 (background): web + large AVIF mirrors land in MinIO and
 *     their byte sizes are recorded. The public album page picks up
 *     AVIF as an optional source (`p.avif_bytes_web ? presign(...) :
 *     null`) so the WEBP fallback already serves traffic during this
 *     window.
 *
 * Both phases run inside the same pg-boss job, so a crash mid-job
 * gets retried as a whole — the AVIF puts are idempotent (same key,
 * S3 PutObject overwrites) so a retry costs duplicate encode work
 * but no correctness risk.
 */
export async function handleGenerateDerivatives(
  data: GenerateDerivativesJobData,
): Promise<void> {
  const obj = await s3Client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: data.key }),
  );
  if (!obj.Body) throw new Error(`empty body for ${data.key}`);
  const buf = await bodyToBuffer(obj.Body as { transformToByteArray: () => Promise<Uint8Array> });

  const watermark = await getAlbumWatermark(data.album_id);
  const watermarkOpts = watermark.enabled ? { text: watermark.text } : null;

  // ---- Phase 1: primary WEBPs + thumbhash + EXIF date + status=ready ----
  let primary: PrimaryVariants;
  let taken: Awaited<ReturnType<typeof readTakenAt>>;
  let thumbhash: string;
  [primary, taken, thumbhash] = await Promise.all([
    generatePrimaryVariants(buf, watermarkOpts),
    readTakenAt(buf),
    computeThumbhash(buf),
  ]);

  await Promise.all([
    putWebp(data.album_id, data.photo_id, "thumb", primary.thumb),
    putWebp(data.album_id, data.photo_id, "web", primary.web),
    putWebp(data.album_id, data.photo_id, "large", primary.large),
  ]);

  await writePhotoThumbhash(data.photo_id, thumbhash);
  await markPhotoReady(data.photo_id, taken);

  // ---- Phase 2: AVIF mirrors -----------------------------------------
  const avif = await generateAvifVariants(primary, watermarkOpts);
  await Promise.all([
    putAvif(data.album_id, data.photo_id, "web", avif.webAvif),
    putAvif(data.album_id, data.photo_id, "large", avif.largeAvif),
  ]);

  // Record byte sizes for both phases at the end — single round-trip
  // and avif_bytes_web is the flag the public page reads to decide
  // whether to issue the AVIF presign. Until this row update lands the
  // page transparently falls back to WEBP, which is exactly the
  // intended degradation.
  await writePhotoVariantSizes(data.photo_id, {
    thumb: primary.thumb.length,
    web: primary.web.length,
    large: primary.large.length,
    avifWeb: avif.webAvif.length,
    avifLarge: avif.largeAvif.length,
  });
}
