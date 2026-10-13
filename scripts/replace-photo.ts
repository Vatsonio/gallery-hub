/**
 * replace-photo.ts — swap the original of ONE photo in an existing album for a
 * new file (e.g. an AutoPhoto re-render), keeping the photo row, its id, share
 * links, favorites, order and seeded EXIF.
 *
 * What it does:
 *   1. finds the photo by album id + filename,
 *   2. overwrites the original object at the SAME MinIO key,
 *   3. updates width/height/orig_bytes and bumps photos.updated_at (that
 *      timestamp feeds the imgproxy cachebuster, so every derivative URL changes
 *      and viewers get the new picture instead of a cached one),
 *   4. enqueues the derivatives job so the worker recomputes thumbhash and
 *      dimensions (EXIF seeded at import survives: finalizePhotoMetadata
 *      COALESCEs onto it when the JPEG carries none).
 *
 * Runs server-side next to the stack, with the worker's env (DATABASE_URL,
 * MINIO_*), e.g. inside the app container:
 *
 *   npx tsx scripts/replace-photo.ts --album <album uuid> --filename IMG_5902.jpg --file /tmp/IMG_5902.jpg [--dry-run]
 */
import { readFileSync, existsSync } from "node:fs";
import sharp from "sharp";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "@/lib/db";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { sanitizeFilename } from "@/lib/sanitize";
import { s3Client, BUCKET, headObject } from "@/lib/minio";
import type { GenerateDerivativesJobData } from "@/lib/types";

const CONTENT_TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
const EXTS = ["jpg", "png", "webp"] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function die(msg: string): never {
  console.error(`[replace-photo] ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const albumId = arg("album");
  const filename = arg("filename");
  const file = arg("file");
  if (!albumId || !filename || !file) die("usage: --album <uuid> --filename <name> --file <path> [--dry-run]");
  if (!existsSync(file)) die(`file not found: ${file}`);
  if (!process.env.DATABASE_URL) die("DATABASE_URL is required");

  const rows = await sql<{ id: string; filename: string; status: string; width: number; height: number }[]>`
    SELECT id, filename, status, width, height FROM photos
     WHERE album_id = ${albumId} AND filename = ${sanitizeFilename(filename)}
  `;
  if (rows.length !== 1) die(`expected exactly 1 photo named ${filename} in album ${albumId}, found ${rows.length}`);
  const photo = rows[0];

  // Overwrite the object that is really there (its extension came from the
  // upload content-type), and refuse a new file of a different type.
  let key: string | null = null;
  for (const ext of EXTS) {
    const k = originalKey(albumId, photo.id, ext);
    try { await headObject(k); key = k; break; } catch { /* try next */ }
  }
  if (!key) die(`no original object found for photo ${photo.id}`);
  const keyExt = key.slice(key.lastIndexOf(".") + 1);
  const newExt = resolveOriginalExt(file);
  if (newExt !== keyExt) die(`new file is .${newExt} but the stored original is .${keyExt}`);

  const body = readFileSync(file);
  const meta = await sharp(body).metadata().catch((e: Error) => die(`not a decodable image: ${e.message}`));
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width <= 0 || height <= 0) die("could not read image dimensions");

  console.log(`[replace-photo] photo ${photo.id} (${photo.filename}, ${photo.status}, ${photo.width}x${photo.height})`);
  console.log(`[replace-photo] new file ${width}x${height}, ${(body.byteLength / 1e6).toFixed(1)}MB -> ${key}`);
  if (dryRun) {
    console.log("[replace-photo] DRY RUN, nothing written");
    await sql.end({ timeout: 5 });
    return;
  }

  await s3Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: CONTENT_TYPES[keyExt] }));
  await sql`
    UPDATE photos SET width = ${width}, height = ${height}, orig_bytes = ${body.byteLength}, updated_at = now()
     WHERE id = ${photo.id}
  `;
  const boss = await getBoss();
  const data: GenerateDerivativesJobData = { album_id: albumId, photo_id: photo.id, key };
  await boss.send(GENERATE_DERIVATIVES_QUEUE, data as unknown as object);
  console.log("[replace-photo] replaced; derivatives job queued (thumbhash, dimensions)");
  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch((e) => {
  console.error("[replace-photo] fatal:", e);
  process.exit(1);
});
