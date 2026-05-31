import { sql } from "@/lib/db";
import { headObject } from "@/lib/minio";
import { originalKey } from "@/lib/keys";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";

/**
 * F7 — reconciliation sweep for photos stuck in status='processing'.
 *
 * Photos insert as 'processing' and only flip to 'ready' when their
 * derivative job succeeds. If that job is lost (worker crash between
 * fetch and complete, transient MinIO outage outliving the in-handler
 * retries — see F6), the photo is invisible to viewers and exports
 * (which select status='ready') and sits 'processing' forever with no
 * dead-letter and nothing to re-drive it.
 *
 * This sweep re-enqueues a fresh derivative job for photos that have been
 * 'processing' longer than STUCK_AFTER. Bounds:
 *   - Younger than STUCK_AFTER: still legitimately in flight — skip.
 *   - Older than GIVE_UP_AFTER: presumed permanently dead (genuinely
 *     corrupt original); we stop re-driving so a poison image can't be
 *     retried indefinitely. It stays visibly 'processing' in the admin
 *     tracker rather than being silently lost.
 *   - No backing object (phantom row, see F41): skipped — it ages out.
 */
const STUCK_AFTER = "15 minutes";
const GIVE_UP_AFTER = "24 hours";
const EXT_CANDIDATES = ["jpg", "png", "webp"] as const;

export interface ReconcileResult {
  scanned: number;
  requeued: number;
  skipped_no_object: number;
}

export async function reconcileStuckProcessing(): Promise<ReconcileResult> {
  // Cast string params to interval (postgres.js sends them as bound
  // parameters; the ::interval cast does the rest).
  const rows = await sql<{ id: string; album_id: string }[]>`
    SELECT id, album_id
      FROM photos
     WHERE status = 'processing'
       AND created_at < now() - ${STUCK_AFTER}::interval
       AND created_at > now() - ${GIVE_UP_AFTER}::interval
     LIMIT 500
  `;
  if (rows.length === 0) return { scanned: 0, requeued: 0, skipped_no_object: 0 };

  const boss = await getBoss();
  let requeued = 0;
  let skippedNoObject = 0;

  for (const r of rows) {
    // The original's extension isn't stored on the row; HEAD each candidate.
    let key: string | null = null;
    for (const ext of EXT_CANDIDATES) {
      const candidate = originalKey(r.album_id, r.id, ext);
      try {
        await headObject(candidate);
        key = candidate;
        break;
      } catch {
        // not this extension — try the next
      }
    }
    if (!key) {
      skippedNoObject += 1;
      continue;
    }
    await boss.send(
      GENERATE_DERIVATIVES_QUEUE,
      { album_id: r.album_id, photo_id: r.id, key, attempt: 1 },
      { retryLimit: 0 },
    );
    requeued += 1;
  }

  return { scanned: rows.length, requeued, skipped_no_object: skippedNoObject };
}
