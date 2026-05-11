/**
 * Group raw `favorite_add` view_events into time-bounded selection bursts.
 *
 * A "selection" is a run of favorite_add events from the same (share_token,
 * viewer_id) where consecutive events are within WINDOW_MS of each other.
 * The widget surfaces these as `+N items selected in {album}` rows, so a
 * viewer hearting 10 photos in 30 seconds collapses to a single row.
 */
export interface RawFavoriteEvent {
  share_token: string;
  viewer_id: string;
  created_at: Date;
  album_title: string;
}

export interface GroupedSelection {
  album_title: string;
  added_count: number;
  viewer_id_short: string;
  at: string;
}

const WINDOW_MS = 5 * 60 * 1000;

export function groupFavoriteEvents(events: RawFavoriteEvent[]): GroupedSelection[] {
  // Bucket by (share_token, viewer_id) so each viewer's run-length grouping
  // is independent. Different viewers selecting in the same album in the
  // same minute should produce separate rows.
  const byKey = new Map<string, RawFavoriteEvent[]>();
  for (const e of events) {
    const k = `${e.share_token}|${e.viewer_id}`;
    const list = byKey.get(k) ?? [];
    list.push(e);
    byKey.set(k, list);
  }

  const groups: GroupedSelection[] = [];
  for (const list of byKey.values()) {
    // Ascending so the "previous" comparison is well-defined for run-length.
    list.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    let bucket: RawFavoriteEvent[] = [];
    const flush = (): void => {
      if (bucket.length === 0) return;
      const last = bucket[bucket.length - 1];
      groups.push({
        album_title: last.album_title,
        added_count: bucket.length,
        viewer_id_short: last.viewer_id.slice(0, 8),
        at: last.created_at.toISOString(),
      });
      bucket = [];
    };
    for (const e of list) {
      if (bucket.length === 0) {
        bucket.push(e);
        continue;
      }
      const prev = bucket[bucket.length - 1];
      if (e.created_at.getTime() - prev.created_at.getTime() <= WINDOW_MS) {
        bucket.push(e);
      } else {
        flush();
        bucket.push(e);
      }
    }
    flush();
  }

  return groups.sort((a, b) => b.at.localeCompare(a.at));
}
