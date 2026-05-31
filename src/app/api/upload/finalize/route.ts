import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-check";
import { getAlbumById, insertPhotosBatch, assertAdminAlbumAccess } from "@/lib/albums";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { originalKey } from "@/lib/keys";
import { isSameOrigin } from "@/lib/same-origin";
import { sanitizeFilename } from "@/lib/sanitize";
import { notifyNewUpload } from "@/lib/notifications";
import { isImgproxyEnabled, warmImgproxyVariants } from "@/lib/imgproxy";
import { loadSettings } from "@/lib/settings";
import { getStorageUsage } from "@/lib/storage-usage";
import { headObject } from "@/lib/minio";
import { sql } from "@/lib/db";
import type { FinalizeRequestBody, FinalizeResponse, GenerateDerivativesJobData } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT_CANDIDATES = ["jpg", "png", "webp"] as const;

/**
 * F2/F41: find the actually-uploaded original for a photo and read its
 * authoritative byte size. The stored extension derives from the presign
 * content-type (not the filename), so we probe the candidate extensions
 * via HEAD. Returns null when no object was ever uploaded (phantom row).
 */
async function discoverOriginal(
  albumId: string,
  photoId: string,
): Promise<{ key: string; bytes: number } | null> {
  for (const ext of EXT_CANDIDATES) {
    const key = originalKey(albumId, photoId, ext);
    try {
      const head = await headObject(key);
      return { key, bytes: Number(head.ContentLength ?? 0) };
    } catch {
      // not this extension — try the next
    }
  }
  return null;
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
  try {
    assertAdminAlbumAccess(album, { userId: auth.userId, role: auth.role });
  } catch {
    return NextResponse.json({ error: "album not found" }, { status: 404 });
  }

  // F4: enforce settings.uploads.max_files_per_album against the live
  // count + the incoming batch. The presign cap blocks at presign time;
  // a second admin client running concurrently could still push past
  // the limit between presign and finalize, so we re-check here.
  const settings = await loadSettings();
  const countRows = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM photos WHERE album_id = ${album.id}
  `;
  const currentCount = Number(countRows[0]?.n ?? "0");
  if (currentCount + body.photos.length > settings.uploads.max_files_per_album) {
    return NextResponse.json(
      {
        error: `album would exceed max files (${settings.uploads.max_files_per_album})`,
      },
      { status: 400 },
    );
  }

  // F28: validate each photo before any DB work. photo_id becomes a PK +
  // an S3 key segment; width/height are NOT NULL integer columns. Reject
  // the whole batch on a malformed row rather than 500-ing mid-insert.
  for (const p of body.photos) {
    if (
      typeof p?.photo_id !== "string" || !UUID_RE.test(p.photo_id) ||
      !Number.isInteger(p.width) || p.width <= 0 ||
      !Number.isInteger(p.height) || p.height <= 0
    ) {
      return NextResponse.json({ error: "invalid photo metadata in batch" }, { status: 400 });
    }
  }

  const boss = await getBoss();

  // F7: sanitize filenames before they hit the DB / ZIP entry names /
  // Content-Disposition / Telegram messages.
  const sanitized = body.photos.map((p) => ({
    photo_id: p.photo_id,
    filename: sanitizeFilename(p.filename),
    width: p.width,
    height: p.height,
  }));

  // F2/F41: never trust the client-supplied byte size and never finalize a
  // row whose object was never uploaded. HEAD each presigned key to confirm
  // the upload landed and read the authoritative ContentLength. Photos with
  // no backing object (phantom finalize) are dropped from the batch.
  const resolved = (
    await Promise.all(
      sanitized.map(async (p) => {
        const found = await discoverOriginal(album.id, p.photo_id);
        if (!found) {
          console.warn(`[finalize] no uploaded object for ${p.photo_id} — skipping`);
          return null;
        }
        return { ...p, key: found.key, orig_bytes: found.bytes };
      }),
    )
  ).filter((p): p is NonNullable<typeof p> => p !== null);

  if (resolved.length === 0) {
    return NextResponse.json({ inserted: 0 } satisfies FinalizeResponse);
  }

  // F9: re-evaluate byte quotas with the TRUE sizes. Presign checked them
  // against the spoofable client sizes, and concurrent presigns could each
  // have seen a stale pre-batch total — so the per-album and global caps are
  // re-checked here, now that orig_bytes is trustworthy, before committing.
  const realIncoming = resolved.reduce((acc, p) => acc + p.orig_bytes, 0);
  const albumCapGb = settings.uploads.max_album_gb;
  if (albumCapGb && albumCapGb > 0) {
    const rows = await sql<{ used: string | null }[]>`
      SELECT COALESCE(SUM(orig_bytes), 0)::text AS used
        FROM photos WHERE album_id = ${album.id} AND status IN ('ready','processing')
    `;
    const used = Number(rows[0]?.used ?? "0");
    if (used + realIncoming > albumCapGb * 1_000_000_000) {
      return NextResponse.json({ reason: "album_cap_exceeded" }, { status: 507 });
    }
  }
  if (settings.storage.block_uploads_when_full) {
    const usage = await getStorageUsage();
    if (usage.usedBytes + realIncoming >= settings.storage.max_gb * 1_000_000_000) {
      return NextResponse.json({ reason: "storage_full" }, { status: 507 });
    }
  }

  // Single round-trip INSERT for the whole (resolved) batch. orig_bytes is
  // the real object size; created_by_user_id is the calling admin (the
  // test bypass now seeds a real admin_users row, so the FK always resolves).
  await insertPhotosBatch(
    resolved.map((p) => ({
      id: p.photo_id,
      album_id: album.id,
      filename: p.filename,
      width: p.width,
      height: p.height,
      orig_bytes: p.orig_bytes,
      taken_at: null,
      created_by_user_id: auth.userId,
    })),
  );

  // Batch enqueue derivative jobs using the discovered real key (fixes the
  // F41 ext-mismatch where the filename ext diverged from the stored one).
  const jobs = resolved.map((p) => {
    const data: GenerateDerivativesJobData = {
      album_id: album.id,
      photo_id: p.photo_id,
      key: p.key,
    };
    return { name: GENERATE_DERIVATIVES_QUEUE, data: data as unknown as object };
  });
  if (jobs.length > 0) await boss.insert(jobs);

  const inserted = resolved.length;
  void notifyNewUpload({
    album_id: album.id,
    album_title: album.title,
    photo_count: inserted,
  });

  // Pre-warm imgproxy for the hot variants so the first viewer doesn't pay
  // the cold-encode cost. Fire-and-forget; bounded by imgproxy concurrency.
  if (isImgproxyEnabled()) {
    const warmItems = resolved.map((p) => ({ s3Key: p.key }));
    void warmImgproxyVariants(warmItems).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[finalize] imgproxy warm failed:", (err as Error).message);
    });
  }

  const resp: FinalizeResponse = { inserted };
  return NextResponse.json(resp);
}
