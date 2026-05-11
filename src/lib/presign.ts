import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3SignerClient, BUCKET } from "@/lib/minio";

// Presigned URLs are handed to the browser, so they must use the PUBLIC
// MinIO endpoint (MINIO_PUBLIC_ENDPOINT) rather than the internal Docker
// hostname (gallery-minio:9000) which the browser can't reach.
export async function presignPut(key: string, contentType: string, expiresInSeconds = 900): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3SignerClient, cmd, { expiresIn: expiresInSeconds });
}

export async function presignGet(key: string, expiresInSeconds = 3600): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3SignerClient, cmd, { expiresIn: expiresInSeconds });
}
