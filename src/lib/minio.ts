import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand
} from "@aws-sdk/client-s3";

const globalForS3 = globalThis as unknown as { __s3?: S3Client };

function makeClient(): S3Client {
  return new S3Client({
    endpoint: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
    region: process.env.MINIO_REGION ?? "us-east-1",
    forcePathStyle: (process.env.MINIO_FORCE_PATH_STYLE ?? "true") !== "false",
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? "",
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? ""
    }
  });
}

function getClient(): S3Client {
  if (!globalForS3.__s3) globalForS3.__s3 = makeClient();
  return globalForS3.__s3;
}

// Lazy proxy: defers `makeClient()` until first call/property access so that
// vitest can spin up its MinIO testcontainer in `beforeAll` and have
// MINIO_ENDPOINT/credentials ready by the time any test issues a real request.
export const s3Client: S3Client = new Proxy({} as S3Client, {
  get(_t, prop, receiver) {
    return Reflect.get(getClient() as unknown as object, prop, receiver);
  }
});

export const BUCKET: string = process.env.MINIO_BUCKET ?? "gallery";

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
