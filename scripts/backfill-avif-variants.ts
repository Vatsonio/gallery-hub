/**
 * Backfill AVIF derivatives for photos that already have WEBP variants but
 * never had AVIF generated. Pulls each photo's original from MinIO, encodes
 * AVIF mirrors of the web + large variants, uploads them, then updates the
 * `avif_bytes_web` / `avif_bytes_large` columns.
 *
 * Skips photos that already have non-null AVIF byte counts (treat them as
 * done — verifying via HEAD would double the wall-clock cost).
 *
 * Usage:
 *   npx tsx scripts/backfill-avif-variants.ts
 */
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import postgres from "postgres";
import sharp from "sharp";
import { s3Client, BUCKET } from "@/lib/minio";
import { originalKey, avifVariantKey } from "@/lib/keys";

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

async function encodeAvif(input: Buffer, maxSide: number, quality: number): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .avif({ quality, effort: 4 })
    .toBuffer();
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql<{ id: string; album_id: string; filename: string }[]>`
      SELECT id, album_id, filename FROM photos
       WHERE status = 'ready'
         AND (avif_bytes_web IS NULL OR avif_bytes_large IS NULL)
    `;
    console.log(`[avif-backfill] ${rows.length} candidate photos`);
    let done = 0;
    for (const p of rows) {
      try {
        const key = originalKey(p.album_id, p.id, inferExt(p.filename));
        const obj = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        if (!obj.Body) {
          console.warn(`[avif-backfill] empty body for ${key}, skipping`);
          continue;
        }
        const buf = await streamToBuffer(obj.Body as NodeJS.ReadableStream);
        const [webAvif, largeAvif] = await Promise.all([
          encodeAvif(buf, 1600, 60),
          encodeAvif(buf, 2400, 64),
        ]);
        await Promise.all([
          s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: avifVariantKey(p.album_id, p.id, "web"),
              Body: webAvif,
              ContentType: "image/avif",
            }),
          ),
          s3Client.send(
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: avifVariantKey(p.album_id, p.id, "large"),
              Body: largeAvif,
              ContentType: "image/avif",
            }),
          ),
        ]);
        await sql`
          UPDATE photos
             SET avif_bytes_web   = ${webAvif.length},
                 avif_bytes_large = ${largeAvif.length}
           WHERE id = ${p.id}
        `;
        done++;
        if (done % 10 === 0) console.log(`[avif-backfill] ${done}/${rows.length}`);
      } catch (err) {
        console.error(`[avif-backfill] failed for photo ${p.id}:`, err);
      }
    }
    console.log(`[avif-backfill] done — updated ${done} rows`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
