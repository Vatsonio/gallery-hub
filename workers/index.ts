import sharp from "sharp";
import {
  getBoss,
  GENERATE_DERIVATIVES_QUEUE,
  REAP_DELETED_ALBUMS_QUEUE,
  REAP_STALE_EXPORTS_QUEUE,
  STORAGE_USAGE_CHECK_QUEUE,
  NOTIFICATIONS_QUEUE,
} from "@/lib/jobs";
import { handleGenerateDerivatives } from "./generateDerivatives";
import { handleReap } from "./reaper";
import { reapStaleExports } from "./exportReaper";
import { handleNotificationJob } from "./notifications";
import { checkStorageQuota } from "@/lib/storage-monitor";
import type { GenerateDerivativesJobData } from "@/lib/types";

// Cap libvips threads per encode. sharp defaults to "host CPU count",
// which oversubscribes badly when batchSize > 1: with batchSize=6 and 5
// variants generated in parallel per job, libvips wants 6 × 5 × N_cpu
// threads — they all contend for the same cores and throughput stalls.
// At 2 threads per encode (instead of N_cpu) the per-image work is
// slightly slower in isolation but the batch parallelism wins
// substantially. Sharp's docs explicitly recommend this pattern for
// concurrent-job workers.
const SHARP_CONCURRENCY = parseInt(process.env.SHARP_CONCURRENCY ?? "2", 10);
sharp.concurrency(SHARP_CONCURRENCY > 0 ? SHARP_CONCURRENCY : 2);

// How many derivative jobs to process concurrently in one worker process.
// 4–8 is the sweet spot on a 4-core dev box: above ~12 sharp's libvips
// threads contend with each other and throughput plateaus or regresses.
// To scale further, run additional worker processes (WORKER_REPLICAS env
// in deploy/, or just launch `npm run worker` in another shell locally).
const DEFAULT_WORKER_BATCH_SIZE = 6;
function resolveBatchSize(): number {
  const raw = parseInt(process.env.WORKER_BATCH_SIZE ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(16, raw);
  return DEFAULT_WORKER_BATCH_SIZE;
}

async function main(): Promise<void> {
  const boss = await getBoss();
  const batchSize = resolveBatchSize();
  console.log(`[worker] started, schema=pgboss_gallery, derivatives batchSize=${batchSize}, sharp.concurrency=${SHARP_CONCURRENCY}`);

  await boss.work<GenerateDerivativesJobData>(
    GENERATE_DERIVATIVES_QUEUE,
    { batchSize },
    async (jobs) => {
      // pg-boss hands us a batch up to `batchSize`. Processing them in
      // parallel is the whole point of bumping batchSize — sequential
      // would just be the old `batchSize: 2` behaviour with a larger
      // window. Failures are captured per-job; we re-throw the first to
      // let pg-boss requeue the batch, but the others have already run.
      const results = await Promise.allSettled(
        jobs.map(async (job) => {
          try {
            await handleGenerateDerivatives(job.data);
            console.log("[worker] derivatives done", job.data.photo_id);
          } catch (err) {
            console.error("[worker] derivatives FAILED", job.id, err);
            throw err;
          }
        }),
      );
      const firstReject = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (firstReject) throw firstReject.reason;
    },
  );

  await boss.work(REAP_DELETED_ALBUMS_QUEUE, async () => {
    await handleReap();
    console.log("[worker] reap pass complete");
  });

  await boss.work(REAP_STALE_EXPORTS_QUEUE, async () => {
    const r = await reapStaleExports();
    console.log(`[worker] export-reaper scanned=${r.scanned} deleted=${r.deleted}`);
  });

  await boss.work(STORAGE_USAGE_CHECK_QUEUE, async () => {
    const r = await checkStorageQuota();
    if (r.skipped) {
      console.log("[worker] storage-quota check skipped (no STORAGE_QUOTA_BYTES)");
    } else {
      console.log(
        `[worker] storage-quota used=${r.used_bytes}B quota=${r.quota_bytes}B pct=${r.used_pct?.toFixed(1)} emitted=${r.emitted}`,
      );
    }
  });

  await boss.work<{ logId: string }>(NOTIFICATIONS_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const outcome = await handleNotificationJob(job.data.logId);
        console.log(`[worker] notification ${job.data.logId} → ${outcome.status}`);
      } catch (err) {
        console.error("[worker] notification FAILED", job.id, err);
        throw err;
      }
    }
  });

  await boss.schedule(REAP_DELETED_ALBUMS_QUEUE, "0 * * * *");
  await boss.schedule(REAP_STALE_EXPORTS_QUEUE, "0 */6 * * *");
  await boss.schedule(STORAGE_USAGE_CHECK_QUEUE, "0 * * * *");

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, async () => {
      console.log(`[worker] received ${sig}, shutting down`);
      await boss.stop({ graceful: true });
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
