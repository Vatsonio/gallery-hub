/**
 * Storage usage observability + quota alerting.
 *
 * Two concerns living together because they share the same source-of-truth
 * walks:
 *
 *   1. getStorageUsage() — read-only snapshot for the /chikaq dashboard.
 *      Sums object sizes via ListObjectsV2 (paginated), queries Postgres
 *      for pg_database_size + SUM(orig_bytes), and tries to read the
 *      last-backup manifest dropped by deploy/scripts/pg-backup.sh.
 *
 *   2. checkStorageQuota() — invoked by the hourly pg-boss worker. Reads
 *      STORAGE_QUOTA_BYTES; emits a `storage_critical` PostHog event when
 *      MinIO usage crosses 85% of quota. No quota env → silent no-op (this
 *      is the dev / unbounded-storage path).
 *
 * Everything here goes through safeCapture/try-catch — analytics or
 * filesystem failures must never bubble into /chikaq render.
 */
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "@/lib/db";
import { s3Client, BUCKET } from "@/lib/minio";
import { safeCapture } from "@/lib/analytics";

export interface StorageUsage {
  /** Bytes consumed by all objects in the gallery MinIO bucket. */
  minio_bytes: number;
  /** Object count in the gallery bucket (sanity figure for /chikaq). */
  minio_objects: number;
  /** Result of pg_database_size(current_database()) — full DB footprint. */
  postgres_db_size_bytes: number;
  /** SUM(orig_bytes) FROM photos — useful for "user-attributable" storage. */
  photos_orig_bytes_sum: number;
  /** ISO timestamp of the last successful pg-backup, if the manifest exists. */
  last_backup_at: string | null;
  /** ISO timestamp of the last successful mc mirror, if the manifest exists. */
  last_mirror_at: string | null;
}

interface DbSizeRow {
  pg_db_size_bytes: bigint | string;
  photos_orig_bytes_sum: bigint | string;
}

function toNum(v: bigint | string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
}

/**
 * Walk every object in the bucket once, summing Size and counting keys.
 * Pagination via ContinuationToken; same pattern as workers/exportReaper.ts
 * so a 100k-object bucket stays bounded in memory.
 */
async function sumBucketBytes(bucket: string): Promise<{ bytes: number; objects: number }> {
  let token: string | undefined;
  let bytes = 0;
  let objects = 0;
  do {
    const page = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      objects++;
      bytes += obj.Size ?? 0;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return { bytes, objects };
}

/**
 * Try to read a JSON manifest dropped by the backup container. The
 * container writes /backups/last-backup.json after every successful run;
 * /chikaq mounts the same volume read-only via BACKUP_MANIFEST_DIR.
 */
async function readManifest(filename: string): Promise<string | null> {
  const dir = process.env.BACKUP_MANIFEST_DIR;
  if (!dir) return null;
  try {
    const raw = await fs.readFile(path.join(dir, filename), "utf8");
    const parsed = JSON.parse(raw) as { completed_at?: unknown };
    return typeof parsed.completed_at === "string" ? parsed.completed_at : null;
  } catch {
    // Missing manifest is normal — first boot, fresh deploy, etc.
    return null;
  }
}

export async function getStorageUsage(): Promise<StorageUsage> {
  // Run the bucket walk and the DB query in parallel; they hit unrelated
  // services and combined latency dominates the page render.
  const [bucketStats, dbRows, lastBackup, lastMirror] = await Promise.all([
    sumBucketBytes(BUCKET),
    sql<DbSizeRow[]>`
      SELECT
        pg_database_size(current_database())::bigint AS pg_db_size_bytes,
        COALESCE((SELECT SUM(orig_bytes) FROM photos), 0)::bigint AS photos_orig_bytes_sum
    `,
    readManifest("last-backup.json"),
    readManifest("last-mirror.json"),
  ]);
  const row = dbRows[0];
  return {
    minio_bytes: bucketStats.bytes,
    minio_objects: bucketStats.objects,
    postgres_db_size_bytes: toNum(row?.pg_db_size_bytes),
    photos_orig_bytes_sum: toNum(row?.photos_orig_bytes_sum),
    last_backup_at: lastBackup,
    last_mirror_at: lastMirror,
  };
}

export interface QuotaCheckResult {
  /** True when STORAGE_QUOTA_BYTES is unset — caller treats as silent skip. */
  skipped: boolean;
  used_bytes: number;
  quota_bytes: number | null;
  used_pct: number | null;
  /** True when the threshold was crossed and PostHog was notified. */
  emitted: boolean;
}

export const STORAGE_CRITICAL_PCT = 85;

/**
 * Decide if quota usage warrants an alert. Pure function over the inputs so
 * the test suite doesn't need to mock PostHog or the env. The caller
 * (checkStorageQuota) does the env read + capture; this just computes.
 */
export function evaluateQuota(
  usedBytes: number,
  quotaBytes: number | null,
): QuotaCheckResult {
  if (quotaBytes === null || quotaBytes <= 0) {
    return {
      skipped: true,
      used_bytes: usedBytes,
      quota_bytes: quotaBytes,
      used_pct: null,
      emitted: false,
    };
  }
  const pct = (usedBytes / quotaBytes) * 100;
  return {
    skipped: false,
    used_bytes: usedBytes,
    quota_bytes: quotaBytes,
    used_pct: pct,
    emitted: pct >= STORAGE_CRITICAL_PCT,
  };
}

function readQuotaEnv(): number | null {
  const raw = process.env.STORAGE_QUOTA_BYTES;
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Worker entry. Snapshots MinIO usage, decides if the 85% threshold is
 * crossed, and emits a `storage_critical` PostHog event when it is.
 *
 * Returns the result so the worker can log it; throws on infrastructure
 * errors (which pg-boss will retry per its policy).
 */
export async function checkStorageQuota(): Promise<QuotaCheckResult> {
  const quota = readQuotaEnv();
  const bucket = await sumBucketBytes(BUCKET);
  const result = evaluateQuota(bucket.bytes, quota);
  if (result.emitted) {
    safeCapture({
      distinctId: "gallery-hub-system",
      event: "storage_critical",
      properties: {
        used_bytes: result.used_bytes,
        quota_bytes: result.quota_bytes,
        used_pct: result.used_pct,
        bucket: BUCKET,
      },
    });
  }
  return result;
}
