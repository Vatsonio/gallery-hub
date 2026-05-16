import { NextResponse } from "next/server";
import sharp from "sharp";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { requireAdminSession } from "@/lib/session";
import { s3Client, BUCKET, headObject } from "@/lib/minio";
import { originalKey } from "@/lib/keys";
import { sql } from "@/lib/db";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { validatePhotoEditPayload, brightnessToModulate, PhotoEditValidationError } from "@/lib/photo-edit";
import { isSameOrigin } from "@/lib/same-origin";
import type { PhotoRow } from "@/lib/types";

interface Ctx { params: Promise<{ id: string }>; }

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as unknown as Uint8Array));
  }
  return Buffer.concat(chunks);
}

async function discoverOriginal(albumId: string, photoId: string): Promise<{ ext: string; key: string; contentType: string } | null> {
  const candidates: { ext: string; contentType: string }[] = [
    { ext: "jpg", contentType: "image/jpeg" },
    { ext: "png", contentType: "image/png" },
    { ext: "webp", contentType: "image/webp" },
  ];
  for (const c of candidates) {
    const key = originalKey(albumId, photoId, c.ext);
    try {
      await headObject(key);
      return { ext: c.ext, key, contentType: c.contentType };
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * POST /api/photos/[id]/edit — applies a sharp transform to the original
 * photo bytes, writes them back to the same key (so the photo id stays
 * stable), then enqueues a derivative regeneration so every variant
 * picks up the change. Body shape is documented in src/lib/photo-edit.ts.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  const { id: photoId } = await ctx.params;
  const rows = await sql<PhotoRow[]>`SELECT * FROM photos WHERE id = ${photoId} LIMIT 1`;
  const photo = rows[0];
  if (!photo) return NextResponse.json({ error: "photo not found" }, { status: 404 });

  let payload;
  try {
    const raw = await req.json();
    payload = validatePhotoEditPayload(raw);
  } catch (err) {
    if (err instanceof PhotoEditValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const orig = await discoverOriginal(photo.album_id, photo.id);
  if (!orig) {
    return NextResponse.json({ error: "original not found in storage" }, { status: 410 });
  }

  // Fetch + transform.
  const get = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: orig.key }));
  if (!get.Body) return NextResponse.json({ error: "empty original body" }, { status: 500 });
  const buf = await streamToBuffer(get.Body as NodeJS.ReadableStream);

  // sharp collapses repeated rotate() calls into one — so we must
  // bake the EXIF auto-orientation into a fresh buffer first, then
  // build the transform pipeline from that pre-oriented buffer. That
  // way subsequent rotate(angle) calls aren't swallowed.
  const oriented = await sharp(buf).rotate().toBuffer();
  let pipeline = sharp(oriented);

  if (payload.crop) {
    const meta = await sharp(oriented).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (W === 0 || H === 0) {
      return NextResponse.json({ error: "could not read image dimensions" }, { status: 500 });
    }
    const left = Math.max(0, Math.round(payload.crop.x * W));
    const top = Math.max(0, Math.round(payload.crop.y * H));
    const width = Math.min(W - left, Math.round(payload.crop.w * W));
    const height = Math.min(H - top, Math.round(payload.crop.h * H));
    if (width <= 0 || height <= 0) {
      return NextResponse.json({ error: "crop region is empty after rounding" }, { status: 400 });
    }
    pipeline = pipeline.extract({ left, top, width, height });
  }

  if (payload.rotate) {
    pipeline = pipeline.rotate(payload.rotate);
  }

  if (payload.brightness !== undefined && payload.brightness !== 0) {
    pipeline = pipeline.modulate({ brightness: brightnessToModulate(payload.brightness) });
  }

  // Re-encode at high quality so subsequent derivative re-runs start
  // from a still-faithful original. JPEG q92 is sharp's near-visually-
  // lossless preset for natural images.
  let outBuf: Buffer;
  if (orig.ext === "png") {
    outBuf = await pipeline.png({ compressionLevel: 8 }).toBuffer();
  } else if (orig.ext === "webp") {
    outBuf = await pipeline.webp({ quality: 92 }).toBuffer();
  } else {
    outBuf = await pipeline.jpeg({ quality: 92 }).toBuffer();
  }

  // Write back to the same key — variants will get re-rendered below.
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: orig.key,
    Body: outBuf,
    ContentType: orig.contentType,
  }));

  // Update width/height on the row so the grid reflects the new aspect.
  const meta = await sharp(outBuf).metadata();
  if (meta.width && meta.height) {
    await sql`
      UPDATE photos
         SET width = ${meta.width}, height = ${meta.height}, orig_bytes = ${outBuf.length},
             status = 'processing'
       WHERE id = ${photoId}`;
  } else {
    await sql`UPDATE photos SET orig_bytes = ${outBuf.length}, status = 'processing' WHERE id = ${photoId}`;
  }

  // Re-enqueue derivatives so the web/large/AVIF mirrors are rebuilt.
  const boss = await getBoss();
  await boss.send(GENERATE_DERIVATIVES_QUEUE, {
    album_id: photo.album_id,
    photo_id: photo.id,
    key: orig.key,
  });

  return NextResponse.json({ ok: true, photo_id: photo.id });
}
