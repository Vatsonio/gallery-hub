import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAdminSession } from "@/lib/auth-check";
import { getAlbumById } from "@/lib/albums";
import { presignPut } from "@/lib/presign";
import { originalKey, extFromContentType } from "@/lib/keys";
import { isSameOrigin } from "@/lib/same-origin";
import { loadSettings } from "@/lib/settings";
import { getStorageUsage } from "@/lib/storage-usage";
import { sql } from "@/lib/db";
import type { PresignRequestBody, PresignResponse } from "@/lib/types";

// Hard upper bound on a single presign batch — guards Next's default body
// limits and the route runtime budget. The per-operator soft cap lives in
// app_settings.uploads.max_files_per_album.
const HARD_MAX_FILES = 1000;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  }

  let body: PresignRequestBody;
  try {
    body = (await req.json()) as PresignRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body?.album_id || !Array.isArray(body.files)) {
    return NextResponse.json({ error: "album_id and files required" }, { status: 400 });
  }

  // F4: settings-driven caps. Hard ceilings still apply on top so a
  // bad app_settings row can't unbound the route.
  const settings = await loadSettings();
  const maxFiles = Math.min(HARD_MAX_FILES, settings.uploads.max_files_per_album);
  const maxSize = settings.uploads.max_file_size_mb * 1024 * 1024;

  if (body.files.length === 0 || body.files.length > maxFiles) {
    return NextResponse.json({ error: `files must be 1..${maxFiles}` }, { status: 400 });
  }

  const album = await getAlbumById(body.album_id);
  if (!album) return NextResponse.json({ error: "album not found" }, { status: 404 });

  if (settings.storage.block_uploads_when_full) {
    const usage = await getStorageUsage();
    const capBytes = settings.storage.max_gb * 1_000_000_000;
    if (usage.usedBytes >= capBytes) {
      return NextResponse.json({ reason: "storage_full" }, { status: 507 });
    }
  }

  // Pre-compute incoming bytes — reused by every quota check below.
  const incomingBytes = body.files.reduce(
    (acc, f) => acc + (typeof f.size === "number" && f.size > 0 ? f.size : 0),
    0,
  );

  // Per-album cap (0 = disabled). Sums all photos already in this album
  // (ready + processing) and rejects the batch if the new files would
  // push it over. Computed inline because storage-usage's getStorageUsage()
  // is gallery-wide; this needs the per-album figure.
  const albumCapGb = settings.uploads.max_album_gb;
  if (albumCapGb && albumCapGb > 0) {
    const rows = await sql<{ used_bytes: string | null }[]>`
      SELECT COALESCE(SUM(orig_bytes), 0)::text AS used_bytes
      FROM photos
      WHERE album_id = ${album.id}
        AND status IN ('ready', 'processing')
    `;
    const usedBytes = Number(rows[0]?.used_bytes ?? "0");
    const capBytes = albumCapGb * 1_000_000_000;
    if (usedBytes + incomingBytes > capBytes) {
      return NextResponse.json(
        {
          reason: "album_cap_exceeded",
          used_bytes: usedBytes,
          incoming_bytes: incomingBytes,
          cap_bytes: capBytes,
        },
        { status: 507 },
      );
    }
  }

  // Per-user quotas. Two flavours stack on top of the per-album cap:
  //
  //   - TOTAL  — bytes this user has uploaded across every album.
  //   - ALBUM  — bytes this user has uploaded into THIS specific album.
  //
  // Each flavour has a per-user override (admin_users.quota_*_bytes) and a
  // global default (settings.uploads.default_user_quota_*_gb). NULL override
  // → use default. default of 0 → unlimited (and so is a NULL override
  // combined with default-0).
  //
  // Test-bypass sessions never persist a created_by_user_id, so their
  // historical bytes always sum to zero and they implicitly pass.
  if (auth.userId && auth.userId !== "test-admin") {
    const userRows = await sql<{
      quota_total_bytes: string | null;
      quota_album_bytes: string | null;
    }[]>`
      SELECT quota_total_bytes::text AS quota_total_bytes,
             quota_album_bytes::text AS quota_album_bytes
        FROM admin_users WHERE id = ${auth.userId}
    `;
    const u = userRows[0];
    const overrideTotal = u?.quota_total_bytes ? Number(u.quota_total_bytes) : null;
    const overrideAlbum = u?.quota_album_bytes ? Number(u.quota_album_bytes) : null;
    const defaultTotalBytes = settings.uploads.default_user_quota_total_gb * 1_000_000_000;
    const defaultAlbumBytes = settings.uploads.default_user_quota_album_gb * 1_000_000_000;
    const effectiveTotalCap = overrideTotal ?? defaultTotalBytes;
    const effectiveAlbumCap = overrideAlbum ?? defaultAlbumBytes;

    if (effectiveTotalCap > 0) {
      const sumRows = await sql<{ used: string | null }[]>`
        SELECT COALESCE(SUM(orig_bytes), 0)::text AS used
          FROM photos
         WHERE created_by_user_id = ${auth.userId}
           AND status IN ('ready', 'processing')
      `;
      const usedBytes = Number(sumRows[0]?.used ?? "0");
      if (usedBytes + incomingBytes > effectiveTotalCap) {
        return NextResponse.json(
          {
            reason: "user_total_quota_exceeded",
            used_bytes: usedBytes,
            incoming_bytes: incomingBytes,
            cap_bytes: effectiveTotalCap,
          },
          { status: 507 },
        );
      }
    }

    if (effectiveAlbumCap > 0) {
      const sumRows = await sql<{ used: string | null }[]>`
        SELECT COALESCE(SUM(orig_bytes), 0)::text AS used
          FROM photos
         WHERE created_by_user_id = ${auth.userId}
           AND album_id = ${album.id}
           AND status IN ('ready', 'processing')
      `;
      const usedBytes = Number(sumRows[0]?.used ?? "0");
      if (usedBytes + incomingBytes > effectiveAlbumCap) {
        return NextResponse.json(
          {
            reason: "user_album_quota_exceeded",
            used_bytes: usedBytes,
            incoming_bytes: incomingBytes,
            cap_bytes: effectiveAlbumCap,
          },
          { status: 507 },
        );
      }
    }
  }

  // Validate everything up-front so a single bad row fails fast and
  // we don't waste presign time on the others.
  for (const f of body.files) {
    if (f.size > maxSize) {
      return NextResponse.json(
        { error: `${f.filename} exceeds ${maxSize} bytes` },
        { status: 400 },
      );
    }
    try {
      extFromContentType(f.contentType);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }

  // Sign in parallel. presignPut is a pure SigV4 computation against
  // an env-driven endpoint — no network hop — so the only cost here
  // is CPU. 179-file batches drop from seconds to <500ms.
  const items = await Promise.all(
    body.files.map(async (f) => {
      const ext = extFromContentType(f.contentType);
      const photo_id = randomUUID();
      const key = originalKey(album.id, photo_id, ext);
      const put_url = await presignPut(key, f.contentType, 900);
      return { photo_id, put_url, key };
    }),
  );

  const resp: PresignResponse = { items };
  return NextResponse.json(resp);
}
