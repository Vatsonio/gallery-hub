import { sql } from '@/lib/db';
import { logViewEvent } from '@/lib/view-events';

export interface ToggleResult { state: 'added' | 'removed' }

export async function toggleFavoriteForViewer(
  token: string,
  photoId: string,
  viewerId: string,
): Promise<ToggleResult> {
  const deleted = await sql`
    DELETE FROM favorites
    WHERE share_token = ${token} AND photo_id = ${photoId} AND viewer_id = ${viewerId}
    RETURNING photo_id
  `;
  if (deleted.length > 0) {
    await logViewEvent(token, viewerId, 'favorite_remove', photoId);
    return { state: 'removed' };
  }
  await sql`
    INSERT INTO favorites (share_token, photo_id, viewer_id)
    VALUES (${token}, ${photoId}, ${viewerId})
  `;
  await logViewEvent(token, viewerId, 'favorite_add', photoId);
  return { state: 'added' };
}

export async function listFavoritePhotoIds(token: string, viewerId: string): Promise<string[]> {
  // F38: scope to photos that actually belong to the token's album by
  // joining through share_links. Without this, a favorite injected for a
  // foreign photo id (see F27) would surface here. The token→album_id
  // mapping is 1:1, so this also self-heals any legacy polluted rows.
  const rows = await sql<{ photo_id: string }[]>`
    SELECT f.photo_id
    FROM favorites f
    JOIN share_links sl ON sl.token = f.share_token
    JOIN photos p ON p.id = f.photo_id AND p.album_id = sl.album_id
    WHERE f.share_token = ${token} AND f.viewer_id = ${viewerId}
    ORDER BY p.sort_order ASC, p.created_at ASC
  `;
  return rows.map(r => r.photo_id);
}

export async function favoriteCountsByPhoto(token: string): Promise<Map<string, number>> {
  const rows = await sql<{ photo_id: string; n: string }[]>`
    SELECT photo_id, COUNT(*)::text AS n
    FROM favorites
    WHERE share_token = ${token}
    GROUP BY photo_id
  `;
  return new Map(rows.map(r => [r.photo_id, Number(r.n)]));
}

export async function listFavoritesByViewer(token: string): Promise<
  Map<string, { viewerId: string; photoIds: string[]; lastAt: Date }>
> {
  const rows = await sql<{ viewer_id: string; photo_id: string; created_at: Date }[]>`
    SELECT viewer_id, photo_id, created_at
    FROM favorites
    WHERE share_token = ${token}
    ORDER BY created_at DESC
  `;
  const out = new Map<string, { viewerId: string; photoIds: string[]; lastAt: Date }>();
  for (const r of rows) {
    const cur = out.get(r.viewer_id) ?? { viewerId: r.viewer_id, photoIds: [], lastAt: r.created_at };
    cur.photoIds.push(r.photo_id);
    if (r.created_at > cur.lastAt) cur.lastAt = r.created_at;
    out.set(r.viewer_id, cur);
  }
  return out;
}
