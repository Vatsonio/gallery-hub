import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb, resetTestDb } from "./_helpers";
import { sql } from "@/lib/db";
import { createAlbum, insertPhoto, getAlbumById } from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
}, 60_000);

beforeEach(async () => { await resetTestDb(); });

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

describe.skipIf(dockerOff)("cover picker server flow", () => {
  it("setCoverAction persists cover_photo_id on the album", async () => {
    const { setCoverAction } = await import("@/app/admin/albums/actions");
    const album = await createAlbum({ title: "CoverTest", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const pid = randomUUID();
    await insertPhoto({
      id: pid, album_id: album.id, filename: "c.jpg",
      width: 100, height: 100, orig_bytes: 1, taken_at: null,
    });
    // Move it to ready so it would show up in the picker grid.
    await sql`UPDATE photos SET status = 'ready' WHERE id = ${pid}`;

    await setCoverAction(album.id, pid);
    const reread = await getAlbumById(album.id);
    expect(reread?.cover_photo_id).toBe(pid);
  });

  it("can switch cover from one photo to another", async () => {
    const { setCoverAction } = await import("@/app/admin/albums/actions");
    const album = await createAlbum({ title: "Switch", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const p1 = randomUUID();
    const p2 = randomUUID();
    for (const pid of [p1, p2]) {
      await insertPhoto({
        id: pid, album_id: album.id, filename: `${pid}.jpg`,
        width: 100, height: 100, orig_bytes: 1, taken_at: null,
      });
    }
    await sql`UPDATE photos SET status = 'ready' WHERE album_id = ${album.id}`;

    await setCoverAction(album.id, p1);
    expect((await getAlbumById(album.id))?.cover_photo_id).toBe(p1);
    await setCoverAction(album.id, p2);
    expect((await getAlbumById(album.id))?.cover_photo_id).toBe(p2);
  });
});
