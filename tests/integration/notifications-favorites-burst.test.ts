import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { setupTestDb, teardownTestDb, resetTestDb, seedAlbumWithPhotos } from "./_helpers";
import { sql } from "@/lib/db";
import { toggleFavoriteForViewer } from "@/lib/favorites";
import { notifyFavoritesBurst } from "@/lib/notifications";
import { getBoss } from "@/lib/jobs";

let token: string;
let photoIds: string[];

beforeAll(async () => {
  await setupTestDb();
  process.env.TELEGRAM_CHAT_ID = "chat-burst-test";
});
afterAll(async () => {
  const boss = await getBoss().catch(() => null);
  if (boss) await boss.stop({ graceful: true, wait: false }).catch(() => undefined);
  await teardownTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  await sql`UPDATE notification_rules SET enabled = TRUE`;
  ({ token, photoIds } = await seedAlbumWithPhotos({ count: 6 }));
});

/**
 * The contract: many favorite_add events within an hour from the same
 * (token, viewer) pair produce exactly ONE notification_log row — the
 * dedup_key collapses them. The single row's payload reflects the burst
 * count at the moment it crossed the threshold.
 */
describe("favorites burst notification", () => {
  async function favCountFor(viewerId: string): Promise<number> {
    const r = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n
        FROM favorites
       WHERE share_token = ${token}
         AND viewer_id = ${viewerId}
         AND created_at > NOW() - INTERVAL '1 hour'
    `;
    return Number(r[0]?.n ?? "0");
  }

  it("collapses 5 likes from one viewer into one notification_log row", async () => {
    const viewer = "viewer-burst-1";
    for (let i = 0; i < 5; i++) {
      await toggleFavoriteForViewer(token, photoIds[i], viewer);
      await notifyFavoritesBurst({
        album_title: "Test Album",
        share_token: token,
        viewer_id: viewer,
        count: await favCountFor(viewer),
      });
    }
    const rows = await sql<{ id: string; payload: { count?: number } }[]>`
      SELECT id, payload FROM notification_log
       WHERE event_type = 'favorites_burst'
    `;
    // Exactly one row — the unique (event_type, dedup_key, chat_id) index
    // collapsed the four follow-ups.
    expect(rows.length).toBe(1);
  });

  it("does NOT fire below the threshold (default min_count=3)", async () => {
    const viewer = "viewer-low";
    await toggleFavoriteForViewer(token, photoIds[0], viewer);
    await notifyFavoritesBurst({
      album_title: "Test Album",
      share_token: token,
      viewer_id: viewer,
      count: 1,
    });
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM notification_log WHERE event_type = 'favorites_burst'
    `;
    expect(rows.length).toBe(0);
  });

  it("fires once the threshold is met then stays silent for the bucket", async () => {
    const viewer = "viewer-cross-thresh";
    // First two — below threshold of 3.
    for (let i = 0; i < 2; i++) {
      await toggleFavoriteForViewer(token, photoIds[i], viewer);
      await notifyFavoritesBurst({
        album_title: "Test Album",
        share_token: token,
        viewer_id: viewer,
        count: await favCountFor(viewer),
      });
    }
    expect(
      (await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM notification_log`)[0].n,
    ).toBe("0");

    // Third — crosses threshold.
    await toggleFavoriteForViewer(token, photoIds[2], viewer);
    await notifyFavoritesBurst({
      album_title: "Test Album",
      share_token: token,
      viewer_id: viewer,
      count: await favCountFor(viewer),
    });
    expect(
      (await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM notification_log`)[0].n,
    ).toBe("1");

    // Fourth — same hour bucket, dedup collapses.
    await toggleFavoriteForViewer(token, photoIds[3], viewer);
    await notifyFavoritesBurst({
      album_title: "Test Album",
      share_token: token,
      viewer_id: viewer,
      count: await favCountFor(viewer),
    });
    expect(
      (await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM notification_log`)[0].n,
    ).toBe("1");
  });

  it("produces SEPARATE notifications for different viewers", async () => {
    for (const v of ["va", "vb"]) {
      for (let i = 0; i < 3; i++) {
        await toggleFavoriteForViewer(token, photoIds[i], v);
        await notifyFavoritesBurst({
          album_title: "Test Album",
          share_token: token,
          viewer_id: v,
          count: await favCountFor(v),
        });
      }
    }
    const rows = await sql<{ id: string; dedup_key: string }[]>`
      SELECT id, dedup_key FROM notification_log
       WHERE event_type = 'favorites_burst'
    `;
    expect(rows.length).toBe(2);
    // Both dedup keys contain a viewer id slice — they should differ.
    expect(rows[0].dedup_key).not.toBe(rows[1].dedup_key);
  });
});
