/**
 * One-shot backfill: populates photos.thumb_bytes / web_bytes / large_bytes
 * for photos already in the `ready` state (i.e. processed before the
 * derivative worker started persisting variant sizes).
 *
 * Usage:
 *   npx tsx scripts/backfill-variant-sizes.ts
 */
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { s3Client, BUCKET } from "@/lib/minio";
import { variantKey } from "@/lib/keys";

async function head(key: string): Promise<number | null> {
  try {
    const res = await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<{ id: string; album_id: string }[]>`
      SELECT id, album_id FROM photos
       WHERE status = 'ready'
         AND (thumb_bytes IS NULL OR web_bytes IS NULL OR large_bytes IS NULL)
    `;
    console.log(`[backfill] ${rows.length} candidate photos`);
    let done = 0;
    for (const p of rows) {
      const [t, w, l] = await Promise.all([
        head(variantKey(p.album_id, p.id, "thumb")),
        head(variantKey(p.album_id, p.id, "web")),
        head(variantKey(p.album_id, p.id, "large")),
      ]);
      await sql`
        UPDATE photos
           SET thumb_bytes = ${t},
               web_bytes   = ${w},
               large_bytes = ${l}
         WHERE id = ${p.id}
      `;
      done++;
      if (done % 25 === 0) console.log(`[backfill] ${done}/${rows.length}`);
    }
    console.log(`[backfill] done — updated ${done} rows`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
