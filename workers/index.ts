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

async function main(): Promise<void> {
  const boss = await getBoss();
  console.log("[worker] started, schema=pgboss_gallery");

  await boss.work<GenerateDerivativesJobData>(
    GENERATE_DERIVATIVES_QUEUE,
    { batchSize: 2 },
    async (jobs) => {
      for (const job of jobs) {
        try {
          await handleGenerateDerivatives(job.data);
          console.log("[worker] derivatives done", job.data.photo_id);
        } catch (err) {
          console.error("[worker] derivatives FAILED", job.id, err);
          throw err;
        }
      }
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
