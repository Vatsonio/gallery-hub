import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/session";
import { getAlbumById, insertPhoto } from "@/lib/albums";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { originalKey } from "@/lib/keys";
import { notifyNewUpload } from "@/lib/notifications";
import type { FinalizeRequestBody, FinalizeResponse, GenerateDerivativesJobData } from "@/lib/types";

function inferExt(filename: string): string {
  const m = filename.toLowerCase().match(/\.(jpg|jpeg|png|webp)$/);
  if (!m) return "jpg";
  return m[1] === "jpeg" ? "jpg" : m[1];
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });

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
  let inserted = 0;
  for (const p of body.photos) {
    await insertPhoto({
      id: p.photo_id,
      album_id: album.id,
      filename: p.filename,
      width: p.width,
      height: p.height,
      orig_bytes: p.size,
      taken_at: null,
    });
    const ext = inferExt(p.filename);
    const job: GenerateDerivativesJobData = {
      album_id: album.id,
      photo_id: p.photo_id,
      key: originalKey(album.id, p.photo_id, ext),
    };
    await boss.send(GENERATE_DERIVATIVES_QUEUE, job);
    inserted++;
  }
  if (inserted > 0) {
    void notifyNewUpload({
      album_id: album.id,
      album_title: album.title,
      photo_count: inserted,
    });
  }
  const resp: FinalizeResponse = { inserted };
  return NextResponse.json(resp);
}
