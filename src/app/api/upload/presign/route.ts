import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireAdminSession } from "@/lib/session";
import { getAlbumById } from "@/lib/albums";
import { presignPut } from "@/lib/presign";
import { originalKey, extFromContentType } from "@/lib/keys";
import type { PresignRequestBody, PresignResponse } from "@/lib/types";

const MAX_FILES = 100;
const MAX_SIZE = 50 * 1024 * 1024; // 50 MB

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdminSession(req);
  if (!auth.ok) return new NextResponse(null, { status: 401 });

  let body: PresignRequestBody;
  try {
    body = (await req.json()) as PresignRequestBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!body?.album_id || !Array.isArray(body.files)) {
    return NextResponse.json({ error: "album_id and files required" }, { status: 400 });
  }
  if (body.files.length === 0 || body.files.length > MAX_FILES) {
    return NextResponse.json({ error: `files must be 1..${MAX_FILES}` }, { status: 400 });
  }

  const album = await getAlbumById(body.album_id);
  if (!album) return NextResponse.json({ error: "album not found" }, { status: 404 });

  const items = [];
  for (const f of body.files) {
    if (f.size > MAX_SIZE) {
      return NextResponse.json({ error: `${f.filename} exceeds ${MAX_SIZE} bytes` }, { status: 400 });
    }
    let ext: string;
    try {
      ext = extFromContentType(f.contentType);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    const photo_id = randomUUID();
    const key = originalKey(album.id, photo_id, ext);
    const put_url = await presignPut(key, f.contentType, 900);
    items.push({ photo_id, put_url, key });
  }

  const resp: PresignResponse = { items };
  return NextResponse.json(resp);
}
