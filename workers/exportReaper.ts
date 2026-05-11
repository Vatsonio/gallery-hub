import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { s3Client, BUCKET } from "@/lib/minio";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface ReapResult {
  scanned: number;
  deleted: number;
}

/**
 * Sweeps `exports/` and deletes any object whose LastModified is older
 * than 24h. Idempotent — safe to run on a tight cron.
 */
export async function reapStaleExports(now: Date = new Date()): Promise<ReapResult> {
  const cutoff = now.getTime() - TTL_MS;
  let continuationToken: string | undefined;
  let scanned = 0;
  let deleted = 0;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "exports/",
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of page.Contents ?? []) {
      scanned++;
      if (!obj.Key || !obj.LastModified) continue;
      if (obj.LastModified.getTime() < cutoff) {
        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
        deleted++;
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return { scanned, deleted };
}
