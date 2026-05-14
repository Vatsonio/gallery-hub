import PgBoss from "pg-boss";

export const GENERATE_DERIVATIVES_QUEUE = "generate-derivatives";
export const REAP_DELETED_ALBUMS_QUEUE = "reap-deleted-albums";
export const REAP_STALE_EXPORTS_QUEUE = "reap-stale-exports";
export const STORAGE_USAGE_CHECK_QUEUE = "storage-usage-check";
export const NOTIFICATIONS_QUEUE = "notifications-dispatch";

let bossPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL not set");
      const boss = new PgBoss({
        connectionString: url,
        schema: "pgboss_gallery",
        retryLimit: 3,
        retryBackoff: true,
      });
      boss.on("error", (err) => console.error("[pg-boss]", err));
      await boss.start();
      await boss.createQueue(GENERATE_DERIVATIVES_QUEUE);
      await boss.createQueue(REAP_DELETED_ALBUMS_QUEUE);
      await boss.createQueue(REAP_STALE_EXPORTS_QUEUE);
      await boss.createQueue(STORAGE_USAGE_CHECK_QUEUE);
      await boss.createQueue(NOTIFICATIONS_QUEUE);
      return boss;
    })();
  }
  return bossPromise;
}
