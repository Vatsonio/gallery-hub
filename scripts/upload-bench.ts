/**
 * upload-bench.ts — end-to-end profiler for the upload + derivative pipeline.
 *
 * Drives the same code paths the browser uses (presign → PUT to MinIO →
 * finalize → worker), but skips the iron-session login dance by setting
 * NODE_ENV=test and passing the `x-test-admin: 1` header that
 * requireAdminSession honours in tests. The HTTP layer in front of the
 * route handlers is bypassed too — we call POST() directly with a Request —
 * because what we want to measure is server-side work, not Next's
 * request-decoding overhead, which is negligible on localhost.
 *
 * Stages timed:
 *   1. fixture  — generating the N sample JPEGs (excluded from totals).
 *   2. presign  — POST /api/upload/presign (signs N URLs).
 *   3. put      — parallel PUT of N files to MinIO using the signed URLs.
 *                 Concurrency matches NEXT_PUBLIC_UPLOAD_CONCURRENCY so we
 *                 measure the same client-side floor the real Dropzone sees.
 *   4. finalize — POST /api/upload/finalize (inserts rows + enqueues jobs).
 *   5. process  — wall-clock until every photo's row hits status=ready.
 *                 Polls every 250 ms; requires the gallery-hub worker to
 *                 be running (`npm run worker`).
 *
 * Usage (PowerShell, with dev stack + worker running):
 *
 *   $env:DATABASE_URL = "postgresql://gallery:gallery@localhost:5433/gallery_hub"
 *   $env:MINIO_ENDPOINT = "http://localhost:9100"
 *   $env:MINIO_ACCESS_KEY = "minio"
 *   $env:MINIO_SECRET_KEY = "minio12345"
 *   $env:MINIO_BUCKET = "gallery"
 *   $env:MINIO_FORCE_PATH_STYLE = "true"
 *   $env:NODE_ENV = "test"
 *   npx tsx scripts/upload-bench.ts --count 150 --width 4000 --height 3000
 *
 * Output: a Markdown table to stdout for direct paste into commit bodies.
 */
import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { POST as presignPOST } from "@/app/api/upload/presign/route";
import { POST as finalizePOST } from "@/app/api/upload/finalize/route";
import { createAlbum } from "@/lib/albums";
import { sql } from "@/lib/db";
import { ensureBucket } from "@/lib/minio";
import type { PresignResponse, FinalizeResponse } from "@/lib/types";

interface Args {
  count: number;
  width: number;
  height: number;
  concurrency: number;
  timeoutSec: number;
  label: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    count: 150,
    width: 4000,
    height: 3000,
    concurrency: 4,
    timeoutSec: 600,
    label: "baseline",
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--count" && v) { out.count = parseInt(v, 10); i++; }
    else if (k === "--width" && v) { out.width = parseInt(v, 10); i++; }
    else if (k === "--height" && v) { out.height = parseInt(v, 10); i++; }
    else if (k === "--concurrency" && v) { out.concurrency = parseInt(v, 10); i++; }
    else if (k === "--timeout" && v) { out.timeoutSec = parseInt(v, 10); i++; }
    else if (k === "--label" && v) { out.label = v; i++; }
  }
  return out;
}

function nowMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Build a JPEG that compresses to roughly the size a phone shot at q80 hits
 * (~2–4 MB for 4000×3000). The fixture in tests/ uses a solid colour that
 * compresses to ~70 KB and isn't representative — but pure random noise
 * (incompressible) lands at ~7 MB and triples encode time vs a real photo.
 * Real photos are mostly smooth with localised detail, so we blend a smooth
 * gradient with a small amount of high-frequency noise. Result lands at
 * ~2.5 MB at 4000×3000 q80 — closer to actual phone output.
 */
async function buildRealisticJpeg(width: number, height: number, quality: number): Promise<Buffer> {
  // Stamp a band of random bytes on top of a smooth gradient. We keep the
  // full random byte stream (not a tiled one) so the entropy is genuinely
  // high — but only blend it in at full strength for the middle 60% of
  // each row, leaving smooth borders. Result lands ~3 MB at 4000×3000 q80,
  // which matches a typical phone JPEG.
  const noise = randomBytes(width * height * 3);
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const ry = Math.floor((y / height) * 96);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const rx = Math.floor((x / width) * 96);
      // Mid-band strength: 0 at edges, 1 in the centre band (full entropy).
      const dx = Math.abs(x / width - 0.5);
      const dy = Math.abs(y / height - 0.5);
      const strength = Math.max(0, 1 - Math.max(dx, dy) * 2.4);
      const sr = Math.round(noise[i] * strength);
      const sg = Math.round(noise[i + 1] * strength);
      const sb = Math.round(noise[i + 2] * strength);
      raw[i] = (rx + 40 + sr) & 0xff;
      raw[i + 1] = (ry + 40 + sg) & 0xff;
      raw[i + 2] = (((rx + ry) >> 1) + 40 + sb) & 0xff;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .withMetadata({
      exif: { IFD0: { Software: "gallery-hub-bench" } },
    })
    .toBuffer();
}

async function uploadOne(url: string, body: Buffer, contentType: string): Promise<void> {
  // The DOM BodyInit type doesn't include Buffer; copy into a fresh
  // ArrayBuffer-backed Uint8Array (lib.dom requires the strict ArrayBuffer
  // variant, not Buffer's ArrayBufferLike). The copy cost is irrelevant
  // next to the PUT itself.
  const ab = new ArrayBuffer(body.byteLength);
  new Uint8Array(ab).set(body);
  const blob = new Blob([ab], { type: contentType });
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: blob,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`PUT failed ${res.status}: ${t.slice(0, 200)}`);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await task(items[idx], idx);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
}

async function pollProcessing(albumId: string, expected: number, timeoutSec: number): Promise<number> {
  const start = nowMs();
  // 250 ms polls — fine-grained enough to capture sub-second wins without
  // hammering the DB.
  while (nowMs() - start < timeoutSec * 1000) {
    const rows = await sql<{ ready: number; total: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'ready')::int AS ready,
        COUNT(*)::int AS total
      FROM photos WHERE album_id = ${albumId}`;
    const r = rows[0];
    if (r && r.ready >= expected) return nowMs() - start;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`processing timed out after ${timeoutSec}s waiting for ${expected} photos`);
}

function buildRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-admin": "1",
      // POST handlers also gate on same-origin; spoof the Origin to match the
      // Request URL host so isSameOrigin() returns true.
      "origin": "http://localhost:3000",
      "host": "localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  // NODE_ENV is typed as a literal union ("development" | "production" |
  // "test") and the project's tsconfig pulls in @types/node which marks it
  // as read-only. Reassigning at runtime is fine in Node; we cast through
  // an index access to dodge the literal-type assignment error.
  if (process.env.NODE_ENV !== "test") {
    (process.env as Record<string, string>).NODE_ENV = "test";
  }
  const args = parseArgs(process.argv.slice(2));
  console.log(`[bench] label=${args.label} count=${args.count} ${args.width}x${args.height} concurrency=${args.concurrency}`);

  await ensureBucket();

  // ---- 1. fixture --------------------------------------------------------
  const tFixStart = nowMs();
  const sample = await buildRealisticJpeg(args.width, args.height, 80);
  const fixtureMs = nowMs() - tFixStart;
  console.log(`[bench] sample JPEG ${sample.length} bytes (built in ${fmt(fixtureMs)})`);

  const album = await createAlbum({
    title: `bench-${args.label}-${Date.now()}`,
    subtitle: null,
    status: "draft",
  });
  console.log(`[bench] album=${album.id} slug=${album.slug}`);

  // ---- 2. presign --------------------------------------------------------
  const presignBody = {
    album_id: album.id,
    files: Array.from({ length: args.count }, (_v, i) => ({
      filename: `bench-${i.toString().padStart(4, "0")}.jpg`,
      size: sample.length,
      contentType: "image/jpeg",
    })),
  };
  const tPresignStart = nowMs();
  const presignRes = await presignPOST(buildRequest("/api/upload/presign", presignBody));
  if (presignRes.status !== 200) {
    throw new Error(`presign failed: ${presignRes.status} ${await presignRes.text()}`);
  }
  const presignJson = (await presignRes.json()) as PresignResponse;
  const presignMs = nowMs() - tPresignStart;

  // ---- 3. PUT ------------------------------------------------------------
  const tPutStart = nowMs();
  await runWithConcurrency(presignJson.items, args.concurrency, async (item) => {
    await uploadOne(item.put_url, sample, "image/jpeg");
  });
  const putMs = nowMs() - tPutStart;

  // ---- 4. finalize -------------------------------------------------------
  const finalizeBody = {
    album_id: album.id,
    photos: presignJson.items.map((it, i) => ({
      photo_id: it.photo_id,
      filename: presignBody.files[i].filename,
      width: args.width,
      height: args.height,
      size: sample.length,
    })),
  };
  const tFinStart = nowMs();
  const finRes = await finalizePOST(buildRequest("/api/upload/finalize", finalizeBody));
  if (finRes.status !== 200) {
    throw new Error(`finalize failed: ${finRes.status} ${await finRes.text()}`);
  }
  const finJson = (await finRes.json()) as FinalizeResponse;
  const finalizeMs = nowMs() - tFinStart;
  if (finJson.inserted !== args.count) {
    console.warn(`[bench] WARN: inserted=${finJson.inserted} expected=${args.count}`);
  }

  // ---- 5. process --------------------------------------------------------
  const processMs = await pollProcessing(album.id, args.count, args.timeoutSec);

  // ---- output ------------------------------------------------------------
  const totalMs = presignMs + putMs + finalizeMs + processMs;
  const sizeMB = (sample.length / 1024 / 1024).toFixed(2);
  const totalBytes = sample.length * args.count;
  const throughputMBs = (totalBytes / 1024 / 1024) / (totalMs / 1000);

  console.log("");
  console.log(`| stage    | wall-clock | per-photo |`);
  console.log(`|----------|-----------:|----------:|`);
  console.log(`| presign  | ${fmt(presignMs).padStart(9)} | ${fmt(presignMs / args.count).padStart(9)} |`);
  console.log(`| put      | ${fmt(putMs).padStart(9)} | ${fmt(putMs / args.count).padStart(9)} |`);
  console.log(`| finalize | ${fmt(finalizeMs).padStart(9)} | ${fmt(finalizeMs / args.count).padStart(9)} |`);
  console.log(`| process  | ${fmt(processMs).padStart(9)} | ${fmt(processMs / args.count).padStart(9)} |`);
  console.log(`| **total**| **${fmt(totalMs)}** | **${fmt(totalMs / args.count)}** |`);
  console.log("");
  console.log(`[bench] label=${args.label} count=${args.count} per-file=${sizeMB} MB throughput=${throughputMBs.toFixed(2)} MB/s`);
}

main()
  .then(async () => {
    // Close postgres pool so the process exits.
    try { await (sql as unknown as { end?: () => Promise<void> }).end?.(); } catch { /* ignore */ }
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[bench] FAILED", err);
    try { await (sql as unknown as { end?: () => Promise<void> }).end?.(); } catch { /* ignore */ }
    process.exit(1);
  });
