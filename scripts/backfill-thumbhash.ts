/**
 * Backfill `photos.thumbhash` for photos processed before the
 * derivative worker started computing thumbhashes. Re-pulls the
 * original from MinIO, computes the hash, persists it.
 *
 * Usage:
 *   npx tsx scripts/backfill-thumbhash.ts
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { s3Client, BUCKET } from "@/lib/minio";
import { originalKey } from "@/lib/keys";
import { computeThumbhash } from "@/lib/thumbhash";

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function inferExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/);
  if (!m) return "jpg";
  return m[1] === "jpeg" ? "jpg" : m[1];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<{ id: string; album_id: string; filename: string }[]>`
      SELECT id, album_id, filename FROM photos
       WHERE status = 'ready' AND thumbhash IS NULL
    `;
    console.log(`[thumbhash-backfill] ${rows.length} candidate photos`);
    let done = 0;
    for (const p of rows) {
      try {
        const key = originalKey(p.album_id, p.id, inferExt(p.filename));
        const obj = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        if (!obj.Body) {
          console.warn(`[thumbhash-backfill] empty body for ${key}, skipping`);
          continue;
        }
        const buf = await streamToBuffer(obj.Body as NodeJS.ReadableStream);
        const hash = await computeThumbhash(buf);
        await sql`UPDATE photos SET thumbhash = ${hash} WHERE id = ${p.id}`;
        done++;
        if (done % 25 === 0) console.log(`[thumbhash-backfill] ${done}/${rows.length}`);
      } catch (err) {
        console.error(`[thumbhash-backfill] failed for photo ${p.id}:`, err);
      }
    }
    console.log(`[thumbhash-backfill] done — updated ${done} rows`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
