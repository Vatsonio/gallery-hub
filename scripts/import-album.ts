/**
 * import-album.ts — create a gallery-hub album from a folder of processed
 * photos plus a manifest, WITHOUT going through the browser upload flow.
 *
 * Designed as the ingestion bridge for the AutoPhoto Studio pipeline: Studio
 * exports the picked JPEGs of a project into a folder together with a
 * manifest.json (and a `done` marker written last), and this script — run
 * server-side next to the stack, like the backfill scripts — reads that
 * folder and ingests it straight into Postgres + MinIO. No new HTTP auth
 * surface: it uses the same DATABASE_URL / MINIO_* env the worker uses.
 *
 * The AutoPhoto JPEGs carry NO in-file EXIF (the tags live in the CR2), so
 * the manifest carries capture metadata per photo. We seed photos.taken_at
 * and photos.exif at insert time; the worker's finalizePhotoMetadata now
 * COALESCEs onto those, so a worker pass that parses nothing from the JPEG
 * keeps the seeded values (a real in-file EXIF would still override a null).
 *
 * Manifest shape (only album_title + each photo.filename are required):
 *   {
 *     "album_title": "Поїздка",
 *     "project_id":  "p-0e452c",          // optional, used for the idempotency marker
 *     "cover":       "IMG_6100.jpg",      // optional
 *     "photos": [
 *       {
 *         "filename":  "IMG_6055.jpg",    // file in the same folder
 *         "order":     1,                  // optional; import order otherwise
 *         "raw_path":  "…\\IMG_6055.CR2", // optional, informational only
 *         "exif": {                        // optional; any subset
 *           "taken_at": "2026-09-28T14:03:11+03:00",
 *           "camera": "Canon EOS 750D",
 *           "lens": "EF-S 18-135mm",
 *           "iso": 400,
 *           "aperture": "f/5.6",           // "f/5.6" | 5.6 | "5.6" all accepted
 *           "shutter": "1/250",
 *           "focal_length": "35mm"         // "35mm" | 35 accepted -> focal_mm
 *         }
 *       }
 *     ]
 *   }
 *
 * Usage (PowerShell, with the same env the worker gets):
 *
 *   $env:DATABASE_URL = "postgresql://gallery:...@host:5432/gallery_hub"
 *   $env:MINIO_ENDPOINT = "http://minio:9000"
 *   $env:MINIO_ACCESS_KEY = "..."; $env:MINIO_SECRET_KEY = "..."
 *   $env:MINIO_BUCKET = "gallery"; $env:MINIO_FORCE_PATH_STYLE = "true"
 *   npx tsx scripts/import-album.ts --dir "D:\PROJECTS\AutoPhoto\export\gallery\p-0e452c"
 *
 * Flags:
 *   --dir <path>       folder containing manifest.json, the JPEGs and `done` (required)
 *   --manifest <path>  explicit manifest path (default: <dir>/manifest.json)
 *   --status <s>       album status: draft (default) | published
 *   --require-done     refuse to run until a `done` marker exists (default: on)
 *   --no-require-done  skip the `done` check (for local testing)
 *   --force            re-import even if a .gallery-imported.json marker is present
 *
 * The worker (`npm run worker`) must be running for the photos to leave
 * 'processing' and become visible.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "@/lib/db";
import { createAlbum, insertPhoto } from "@/lib/albums";
import { getOwner } from "@/lib/users";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { originalKey } from "@/lib/keys";
import { resolveOriginalExt } from "@/lib/photoExt";
import { sanitizeFilename } from "@/lib/sanitize";
import { s3Client, BUCKET } from "@/lib/minio";
import type { PhotoExif, GenerateDerivativesJobData, AlbumStatus } from "@/lib/types";

interface ManifestPhoto {
  filename?: string;
  order?: number;
  raw_path?: string;
  exif?: Record<string, unknown>;
}
interface Manifest {
  album_title?: string;
  project_id?: string;
  cover?: string;
  photos?: ManifestPhoto[];
}

const IMPORT_MARKER = ".gallery-imported.json";
const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function die(msg: string): never {
  console.error(`[import-album] ${msg}`);
  process.exit(1);
}

/** "f/5.6" | "5.6" | 5.6 -> 5.6 ; junk -> null */
function parseNumberLike(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const m = v.match(/-?\d+(\.\d+)?/);
    if (m) {
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Normalise a manifest exif blob into gallery-hub's PhotoExif + a Date. */
function normalizeExif(raw: Record<string, unknown> | undefined): {
  exif: PhotoExif | null;
  takenAt: Date | null;
} {
  if (!raw) return { exif: null, takenAt: null };
  const takenIso = asString(raw.taken_at);
  let takenAt: Date | null = null;
  if (takenIso) {
    const d = new Date(takenIso);
    if (!Number.isNaN(d.getTime())) takenAt = d;
  }
  const exif: PhotoExif = {
    camera: asString(raw.camera),
    lens: asString(raw.lens),
    iso: parseNumberLike(raw.iso),
    aperture: parseNumberLike(raw.aperture),
    shutter: asString(raw.shutter),
    // accept either focal_mm or focal_length
    focal_mm: parseNumberLike(raw.focal_mm ?? raw.focal_length),
    taken_at: takenAt ? takenAt.toISOString() : takenIso,
  };
  // Drop entirely-empty exif so we don't seed a row of nulls.
  const hasAny = Object.values(exif).some((v) => v !== null && v !== undefined);
  return { exif: hasAny ? exif : null, takenAt };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) die("DATABASE_URL is required");
  if (!process.env.MINIO_ENDPOINT) die("MINIO_ENDPOINT is required");

  const dir = arg("dir");
  if (!dir) die("--dir <folder> is required");
  const dirAbs = resolve(dir);
  if (!existsSync(dirAbs)) die(`folder not found: ${dirAbs}`);

  const manifestPath = arg("manifest") ?? join(dirAbs, "manifest.json");
  if (!existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);

  const requireDone = !flag("no-require-done");
  if (requireDone) {
    const donePath = join(dirAbs, "done");
    if (!existsSync(donePath)) {
      die(`no 'done' marker in ${dirAbs} — export still in progress (use --no-require-done to override)`);
    }
  }

  const markerPath = join(dirAbs, IMPORT_MARKER);
  if (existsSync(markerPath) && !flag("force")) {
    const prev = readFileSync(markerPath, "utf8");
    die(`already imported (see ${IMPORT_MARKER}: ${prev.trim()}) — pass --force to re-import`);
  }

  let manifest: Manifest;
  try {
    // Strip a UTF-8 BOM if some editor added one — JSON.parse rejects it.
    const text = readFileSync(manifestPath, "utf8").replace(/^﻿/, "");
    manifest = JSON.parse(text) as Manifest;
  } catch (e) {
    return die(`manifest is not valid JSON: ${(e as Error).message}`);
  }

  const title = asString(manifest.album_title);
  if (!title) die("manifest.album_title is required");
  const photos = Array.isArray(manifest.photos) ? manifest.photos : [];
  if (photos.length === 0) die("manifest.photos is empty");

  const status: AlbumStatus = arg("status") === "published" ? "published" : "draft";

  const owner = await getOwner();
  if (!owner) die("no owner admin_users row found — seed the admin first");

  // Optional cross-check against a `done` file that carries "count=<N>".
  const donePath = join(dirAbs, "done");
  if (existsSync(donePath)) {
    const doneTxt = readFileSync(donePath, "utf8");
    const m = doneTxt.match(/count\s*=\s*(\d+)/i);
    if (m && Number(m[1]) !== photos.length) {
      die(`done says count=${m[1]} but manifest has ${photos.length} photos — export incomplete`);
    }
  }

  // Stable order: explicit order first, then manifest order.
  const ordered = photos
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => (a.p.order ?? a.idx + 1) - (b.p.order ?? b.idx + 1))
    .map((x) => x.p);

  // Pre-flight: every referenced file must exist before we create the album.
  for (const p of ordered) {
    const fn = asString(p.filename);
    if (!fn) die("every photo needs a filename");
    if (!existsSync(join(dirAbs, fn))) die(`file listed in manifest is missing: ${fn}`);
  }

  console.log(`[import-album] "${title}" (${status}) — ${ordered.length} photos, owner ${owner.email}`);
  const album = await createAlbum({ title, subtitle: null, status, ownerUserId: owner.id });
  console.log(`[import-album] created album ${album.id} (slug ${album.slug})`);

  const boss = await getBoss();
  let ok = 0;
  for (const p of ordered) {
    const filename = sanitizeFilename(p.filename as string);
    const srcPath = join(dirAbs, p.filename as string);
    const body = readFileSync(srcPath);

    let width = 0;
    let height = 0;
    try {
      const meta = await sharp(body).metadata();
      width = meta.width ?? 0;
      height = meta.height ?? 0;
    } catch (e) {
      console.warn(`[import-album] SKIP ${filename}: not a decodable image (${(e as Error).message})`);
      continue;
    }
    if (width <= 0 || height <= 0) {
      console.warn(`[import-album] SKIP ${filename}: could not read dimensions`);
      continue;
    }

    const photoId = randomUUID();
    const ext = resolveOriginalExt(filename);
    const key = originalKey(album.id, photoId, ext);
    const { exif, takenAt } = normalizeExif(p.exif);

    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      }),
    );

    await insertPhoto({
      id: photoId,
      album_id: album.id,
      filename,
      width,
      height,
      orig_bytes: body.byteLength,
      taken_at: takenAt,
      created_by_user_id: owner.id,
    });

    // Seed rich EXIF now; the worker COALESCEs onto it (the JPEG has none).
    if (exif) {
      await sql`UPDATE photos SET exif = ${sql.json({ ...exif })} WHERE id = ${photoId}`;
    }

    const jobData: GenerateDerivativesJobData = {
      album_id: album.id,
      photo_id: photoId,
      key,
    };
    await boss.send(GENERATE_DERIVATIVES_QUEUE, jobData as unknown as object);

    ok += 1;
    if (ok % 50 === 0) console.log(`[import-album] ${ok}/${ordered.length}`);
  }

  // Optional cover: match by filename.
  const coverName = asString(manifest.cover);
  if (coverName) {
    const san = sanitizeFilename(coverName);
    const row = await sql<{ id: string }[]>`
      SELECT id FROM photos WHERE album_id = ${album.id} AND filename = ${san} LIMIT 1
    `;
    if (row[0]) {
      await sql`UPDATE albums SET cover_photo_id = ${row[0].id} WHERE id = ${album.id}`;
      console.log(`[import-album] cover set to ${san}`);
    } else {
      console.warn(`[import-album] cover "${coverName}" not found among imported photos`);
    }
  }

  writeFileSync(
    markerPath,
    JSON.stringify(
      { albumId: album.id, slug: album.slug, projectId: manifest.project_id ?? null, imported: ok, at: new Date().toISOString() },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`[import-album] done: ${ok}/${ordered.length} photos queued for "${title}" (album ${album.id}).`);
  console.log(`[import-album] the worker will generate thumbnails and flip them to 'ready'.`);
  await sql.end({ timeout: 5 });
  process.exit(0);
}

main().catch((e) => {
  console.error(`[import-album] fatal:`, e);
  process.exit(1);
});
