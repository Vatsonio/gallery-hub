import {
  getBoss,
  GENERATE_DERIVATIVES_QUEUE,
  REAP_DELETED_ALBUMS_QUEUE,
  REAP_STALE_EXPORTS_QUEUE,
} from "@/lib/jobs";
import { handleGenerateDerivatives } from "./generateDerivatives";
import { handleReap } from "./reaper";
import { reapStaleExports } from "./exportReaper";
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

  await boss.schedule(REAP_DELETED_ALBUMS_QUEUE, "0 * * * *");
  await boss.schedule(REAP_STALE_EXPORTS_QUEUE, "0 */6 * * *");

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
