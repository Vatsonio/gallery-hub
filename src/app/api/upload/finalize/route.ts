import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/session";
import { getAlbumById, insertPhotosBatch } from "@/lib/albums";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { originalKey } from "@/lib/keys";
import { isSameOrigin } from "@/lib/same-origin";
import { sanitizeFilename } from "@/lib/sanitize";
import { notifyNewUpload } from "@/lib/notifications";
import { isImgproxyEnabled, warmImgproxyVariants } from "@/lib/imgproxy";
import type { FinalizeRequestBody, FinalizeResponse, GenerateDerivativesJobData } from "@/lib/types";

function inferExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/);
  if (!m) return "jpg";
  return m[1] === "jpeg" ? "jpg" : m[1];
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: FinalizeRequestBody;
  try {
    body = (await req.json()) as FinalizeRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body?.album_id || !Array.isArray(body.photos) || body.photos.length === 0) {
    return NextResponse.json({ error: "album_id and photos required" }, { status: 400 });
  }

  const album = await getAlbumById(body.album_id);
  if (!album) return NextResponse.json({ error: "album not found" }, { status: 404 });

  const boss = await getBoss();

  // F7: client-supplied filenames are normalized + stripped of path
  // separators, control chars, leading dots, etc. before they land in the
  // DB. Downstream consumers (ZIP entry names, Content-Disposition,
  // Telegram notifications) all read from the sanitized DB value.
  const sanitized = body.photos.map((p) => ({
    photo_id: p.photo_id,
    filename: sanitizeFilename(p.filename),
    width: p.width,
    height: p.height,
    size: p.size,
  }));

  // Single round-trip INSERT for the whole batch — at 150 photos this
  // collapses 150 sequential round-trips into one (saves ~3–5 s on the
  // dev stack).
  await insertPhotosBatch(
    sanitized.map((p) => ({
      id: p.photo_id,
      album_id: album.id,
      filename: p.filename,
      width: p.width,
      height: p.height,
      orig_bytes: p.size,
      taken_at: null,
    })),
  );

  // Batch enqueue too — pg-boss v10's `insert` writes all rows in one SQL
  // statement, replacing 150 boss.send() round-trips with a single one.
  const jobs = sanitized.map((p) => {
    const ext = inferExt(p.filename);
    const data: GenerateDerivativesJobData = {
      album_id: album.id,
      photo_id: p.photo_id,
      key: originalKey(album.id, p.photo_id, ext),
    };
    return {
      name: GENERATE_DERIVATIVES_QUEUE,
      data: data as unknown as object,
    };
  });
  if (jobs.length > 0) await boss.insert(jobs);

  const inserted = sanitized.length;
  if (inserted > 0) {
    void notifyNewUpload({
      album_id: album.id,
      album_title: album.title,
      photo_count: inserted,
    });
  }

  // Pre-warm imgproxy for the two hot variants (thumb + web) so the first
  // real viewer doesn't pay the 200–500 ms cold-encode cost per tile. We
  // fire-and-forget so finalize itself stays sub-second even at 150 photos:
  // the warm storm runs in the background of the Node event loop and is
  // bounded by imgproxy's own concurrency limit. Originals haven't been
  // versioned yet (worker hasn't bumped updated_at) so we omit the version
  // param — imgproxy still caches against the raw s3:// source key.
  if (inserted > 0 && isImgproxyEnabled()) {
    const warmItems = sanitized.map((p) => ({
      s3Key: originalKey(album.id, p.photo_id, inferExt(p.filename)),
    }));
    void warmImgproxyVariants(warmItems).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[finalize] imgproxy warm failed:", (err as Error).message);
    });
  }

  const resp: FinalizeResponse = { inserted };
  return NextResponse.json(resp);
}
