import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET } from "@/lib/minio";
import { generateVariants, readTakenAt } from "@/lib/images";
import { variantKey } from "@/lib/keys";
import { markPhotoReady } from "@/lib/albums";
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

  const variants = await generateVariants(buf);
  const taken = await readTakenAt(buf);

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
    )
  ]);

  await markPhotoReady(data.photo_id, taken);
}
