import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { setupTestDb, resetTestDb } from "./_helpers";
import { createAlbum, insertPhoto, listPhotos, reorderPhotos } from "@/lib/albums";
import { randomUUID } from "node:crypto";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
}, 60_000);

beforeEach(async () => { await resetTestDb(); });

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

describe.skipIf(dockerOff)("reorderPhotos", () => {
  it("rewrites sort_order to match the supplied id sequence", async () => {
    const album = await createAlbum({ title: "Reorder", subtitle: null, status: "draft" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      await insertPhoto({
        id, album_id: album.id, filename: `p${i}.jpg`,
        width: 10, height: 10, orig_bytes: 1, taken_at: null,
      });
    }
    // Reverse the order.
    const reversed = [...ids].reverse();
    await reorderPhotos(album.id, reversed);
    const rows = await listPhotos(album.id);
    expect(rows.map((r) => r.id)).toEqual(reversed);
    expect(rows.map((r) => r.sort_order)).toEqual([0, 1, 2]);
  });

  it("reorderPhotosAction is gated and updates order", async () => {
    const { reorderPhotosAction } = await import("@/app/admin/albums/actions");
    const album = await createAlbum({ title: "ReorderAct", subtitle: null, status: "draft" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      await insertPhoto({
        id, album_id: album.id, filename: `q${i}.jpg`,
        width: 10, height: 10, orig_bytes: 1, taken_at: null,
      });
    }
    // Swap first and last.
    const swapped = [ids[2], ids[1], ids[0]];
    await reorderPhotosAction(album.id, swapped);
    const rows = await listPhotos(album.id);
    expect(rows.map((r) => r.id)).toEqual(swapped);
  });
});
