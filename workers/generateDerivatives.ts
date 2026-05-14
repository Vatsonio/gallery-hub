import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET } from "@/lib/minio";
import { generateVariants, readTakenAt } from "@/lib/images";
import { computeThumbhash } from "@/lib/thumbhash";
import { variantKey, avifVariantKey } from "@/lib/keys";
import {
  markPhotoReady,
  writePhotoThumbhash,
  writePhotoVariantSizes,
  getAlbumWatermark,
} from "@/lib/albums";
import type { GenerateDerivativesJobData } from "@/lib/types";

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export async function handleGenerateDerivatives(
  data: GenerateDerivativesJobData
): Promise<void> {
  const obj = await s3Client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: data.key })
  );
  if (!obj.Body) throw new Error(`empty body for ${data.key}`);
  const buf = await streamToBuffer(obj.Body as NodeJS.ReadableStream);

  const watermark = await getAlbumWatermark(data.album_id);
  const [variants, taken, thumbhash] = await Promise.all([
    generateVariants(buf, watermark.enabled ? { text: watermark.text } : null),
    readTakenAt(buf),
    computeThumbhash(buf),
  ]);

  await Promise.all([
    s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: variantKey(data.album_id, data.photo_id, "thumb"),
        Body: variants.thumb,
        ContentType: "image/webp"
      })
    ),
    s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: variantKey(data.album_id, data.photo_id, "web"),
        Body: variants.web,
        ContentType: "image/webp"
      })
    ),
    s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: variantKey(data.album_id, data.photo_id, "large"),
        Body: variants.large,
        ContentType: "image/webp"
      })
    ),
    s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: avifVariantKey(data.album_id, data.photo_id, "web"),
        Body: variants.webAvif,
        ContentType: "image/avif"
      })
    ),
    s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: avifVariantKey(data.album_id, data.photo_id, "large"),
        Body: variants.largeAvif,
        ContentType: "image/avif"
      })
    )
  ]);

  await writePhotoVariantSizes(data.photo_id, {
    thumb: variants.thumb.length,
    web: variants.web.length,
    large: variants.large.length,
    avifWeb: variants.webAvif.length,
    avifLarge: variants.largeAvif.length,
  });
  await writePhotoThumbhash(data.photo_id, thumbhash);
  await markPhotoReady(data.photo_id, taken);
}
