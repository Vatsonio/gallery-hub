import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type HeadObjectCommandOutput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";

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

export async function headObject(key: string, bucket: string = BUCKET): Promise<HeadObjectCommandOutput> {
  return s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

export async function getObjectStream(key: string, bucket: string = BUCKET): Promise<Readable> {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`empty body for ${key}`);
  return res.Body as Readable;
}

/**
 * Presigned GET URL using the PUBLIC endpoint signer — safe to hand to
 * the browser. Wraps the existing s3SignerClient so callers don't have
 * to know about the internal/public client split.
 */
export async function getPresignedUrl(
  key: string,
  ttlSec: number,
  bucket: string = BUCKET,
  opts: { responseContentDisposition?: string } = {},
): Promise<string> {
  return getSignedUrl(
    s3SignerClient,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: opts.responseContentDisposition,
    }),
    { expiresIn: ttlSec },
  );
}

export async function deleteObject(key: string, bucket: string = BUCKET): Promise<void> {
  await s3Client
    .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    .catch(() => undefined);
}

/**
 * List every object under `prefix` and return their keys. Walks the
 * 1000-key pagination ceiling that S3 / MinIO impose on ListObjectsV2.
 */
export async function listObjectKeys(prefix: string, bucket: string = BUCKET): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Delete every object under `prefix`. Used by the album-purge path to
 * reap originals + watermark assets when an album is wiped. Returns the
 * number of keys actually deleted (best-effort; per-batch errors are
 * swallowed so a single corrupt key can't block the rest).
 */
export async function deleteObjectsByPrefix(
  prefix: string,
  bucket: string = BUCKET,
): Promise<number> {
  const keys = await listObjectKeys(prefix, bucket);
  if (keys.length === 0) return 0;
  let deleted = 0;
  // DeleteObjects caps at 1000 keys per request — chunk to that.
  for (let i = 0; i < keys.length; i += 1000) {
    const slice = keys.slice(i, i + 1000);
    const res = await s3Client
      .send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: slice.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      )
      .catch(() => null);
    if (res) deleted += slice.length - (res.Errors?.length ?? 0);
  }
  return deleted;
}

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
