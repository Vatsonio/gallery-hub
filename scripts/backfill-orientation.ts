/**
 * Backfill: walk every photo, re-read EXIF orientation via sharp, swap
 * width/height when the photo is a portrait-shot-stored-as-landscape
 * (EXIF Orientation 5/6/7/8). Pre-fix the worker stored these as
 * 4032×3024, while imgproxy auto-rotates the rendered image to
 * 3024×4032 — the layout then used the wrong aspect ratio and the
 * grid cells came out misshapen.
 *
 * Idempotent: rows that already have matching dimensions are skipped.
 * Safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=... MINIO_ENDPOINT=... MINIO_ACCESS_KEY=... \
 *   MINIO_SECRET_KEY=... npx tsx scripts/backfill-orientation.ts
 */
import postgres from "postgres";
import sharp from "sharp";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

const DATABASE_URL = process.env.DATABASE_URL;
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
const BUCKET = process.env.MINIO_BUCKET ?? "gallery";

if (!DATABASE_URL || !MINIO_ENDPOINT || !MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
  console.error("[backfill] DATABASE_URL/MINIO_* required");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1 });
const s3 = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: MINIO_ACCESS_KEY!, secretAccessKey: MINIO_SECRET_KEY! },
});

function inferExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/);
  if (!m) return "jpg";
  return m[1] === "jpeg" ? "jpg" : m[1];
}

interface PhotoRow {
  id: string;
  album_id: string;
  filename: string;
  width: number;
  height: number;
}

async function main(): Promise<void> {
  const rows = await sql<PhotoRow[]>`
    SELECT id, album_id, filename, width, height
      FROM photos
     WHERE status = 'ready'
     ORDER BY created_at ASC
  `;
  console.log(`[backfill] candidates: ${rows.length}`);

  let scanned = 0;
  let fixed = 0;
  let errors = 0;
  let skippedMatched = 0;
  let skippedSquare = 0;

  for (const p of rows) {
    scanned++;
    const ext = inferExt(p.filename);
    const key = `albums/${p.album_id}/${p.id}/original.${ext}`;
    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      if (!obj.Body) {
        console.warn(`  [skip] ${p.id} ${p.filename} — empty body`);
        continue;
      }
      const bytes = await (obj.Body as { transformToByteArray: () => Promise<Uint8Array> })
        .transformToByteArray();
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const meta = await sharp(buf).metadata();
      const rawW = meta.width ?? 0;
      const rawH = meta.height ?? 0;
      const orient = meta.orientation ?? 1;
      const rotated = orient >= 5 && orient <= 8;
      const trueW = rotated ? rawH : rawW;
      const trueH = rotated ? rawW : rawH;

      if (trueW === 0 || trueH === 0) {
        console.warn(`  [skip] ${p.id} ${p.filename} — zero dim from sharp`);
        continue;
      }
      if (trueW === p.width && trueH === p.height) {
        skippedMatched++;
        continue;
      }
      // Square photos with orientation=1 vs swapped — same result, skip.
      if (rawW === rawH) {
        skippedSquare++;
        continue;
      }

      await sql`
        UPDATE photos SET width = ${trueW}, height = ${trueH}, updated_at = NOW()
         WHERE id = ${p.id}
      `;
      fixed++;
      if (fixed <= 20 || fixed % 25 === 0) {
        console.log(
          `  [fix ${fixed}] ${p.filename}  ${p.width}×${p.height} → ${trueW}×${trueH}  (orient=${orient})`,
        );
      }
    } catch (err) {
      errors++;
      console.warn(`  [err] ${p.id} ${p.filename}: ${(err as Error).message}`);
    }
    if (scanned % 50 === 0) {
      console.log(`  ...scanned ${scanned}/${rows.length}, fixed ${fixed}`);
    }
  }

  console.log(
    `\n[backfill] done. scanned=${scanned}, fixed=${fixed}, skipped_matched=${skippedMatched}, skipped_square=${skippedSquare}, errors=${errors}`,
  );
  await sql.end();
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
