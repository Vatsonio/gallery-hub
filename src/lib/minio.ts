import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand
} from "@aws-sdk/client-s3";

const endpoint = process.env.MINIO_ENDPOINT ?? "http://localhost:9000";
const region = process.env.MINIO_REGION ?? "us-east-1";
const accessKeyId = process.env.MINIO_ACCESS_KEY ?? "";
const secretAccessKey = process.env.MINIO_SECRET_KEY ?? "";
const forcePathStyle = (process.env.MINIO_FORCE_PATH_STYLE ?? "true") !== "false";

export const BUCKET = process.env.MINIO_BUCKET ?? "gallery";

export const s3Client = new S3Client({
  endpoint,
  region,
  forcePathStyle,
  credentials: { accessKeyId, secretAccessKey }
});

export async function ensureBucket(bucket: string = BUCKET): Promise<void> {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
    return;
  } catch (err: unknown) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404) {
      await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
      return;
    }
    throw err;
  }
}
