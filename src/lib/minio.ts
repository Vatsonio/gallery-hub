import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand
} from "@aws-sdk/client-s3";

const globalForS3 = globalThis as unknown as { __s3?: S3Client; __s3Public?: S3Client };

function makeClient(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: process.env.MINIO_REGION ?? "us-east-1",
    forcePathStyle: (process.env.MINIO_FORCE_PATH_STYLE ?? "true") !== "false",
    credentials: {
      accessKeyId: process.env.MINIO_ACCESS_KEY ?? "",
      secretAccessKey: process.env.MINIO_SECRET_KEY ?? ""
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  });
}

function internalEndpoint(): string {
  return process.env.MINIO_ENDPOINT ?? "http://localhost:9000";
}

function publicEndpoint(): string {
  return process.env.MINIO_PUBLIC_ENDPOINT ?? internalEndpoint();
}

function getClient(): S3Client {
  if (!globalForS3.__s3) globalForS3.__s3 = makeClient(internalEndpoint());
  return globalForS3.__s3;
}

function getPublicClient(): S3Client {
  if (!globalForS3.__s3Public) globalForS3.__s3Public = makeClient(publicEndpoint());
  return globalForS3.__s3Public;
}

// Lazy proxy: defers makeClient() until first call/property access so vitest
// can spin up its MinIO testcontainer in beforeAll and have env vars set in
// time. The default client uses the *internal* endpoint (e.g. gallery-minio:9000
// inside Docker) for server-side reads/writes.
export const s3Client: S3Client = new Proxy({} as S3Client, {
  get(_t, prop, receiver) {
    return Reflect.get(getClient() as unknown as object, prop, receiver);
  }
});

// Client whose signed URLs use MINIO_PUBLIC_ENDPOINT — what the browser sees.
// Falls back to the internal endpoint if no public one is configured (dev).
export const s3SignerClient: S3Client = new Proxy({} as S3Client, {
  get(_t, prop, receiver) {
    return Reflect.get(getPublicClient() as unknown as object, prop, receiver);
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
