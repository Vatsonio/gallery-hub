import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAdminSession } from "@/lib/session";
import { getAlbumById } from "@/lib/albums";
import { presignPut } from "@/lib/presign";
import { originalKey, extFromContentType } from "@/lib/keys";
import { isSameOrigin } from "@/lib/same-origin";
import { loadSettings } from "@/lib/settings";
import { getStorageUsage } from "@/lib/storage-usage";
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
