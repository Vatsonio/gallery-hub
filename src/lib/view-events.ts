import { sql } from '@/lib/db';
import { ADMIN_PREVIEW_VIEWER_ID } from '@/lib/viewer';

export type ViewEventType =
  | 'page_view'
  | 'photo_view'
  | 'download'
  | 'favorite_add'
  | 'favorite_remove';

export async function logViewEvent(
  token: string,
  viewerId: string,
  eventType: ViewEventType,
  photoId: string | null = null,
): Promise<void> {
  if (viewerId === ADMIN_PREVIEW_VIEWER_ID) return;
  await sql`
    INSERT INTO view_events (share_token, viewer_id, event_type, photo_id)
    VALUES (${token}, ${viewerId}, ${eventType}, ${photoId})
  `;
}
