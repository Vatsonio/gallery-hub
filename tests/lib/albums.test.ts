import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "@/lib/db";
import {
  createAlbum, getAlbumBySlug, listAlbums, updateAlbum,
  softDeleteAlbum, listPhotos, insertPhoto, insertPhotosBatch, setCover,
  reorderPhotos, deletePhoto, markPhotoReady
} from "@/lib/albums";
import { ensureTestAdminUser, TEST_ADMIN_USER_ID } from "@/lib/test-admin";
import { runMigrations } from "@/../scripts/migrate";

beforeAll(async () => {
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  await ensureTestAdminUser();
  await sql`DELETE FROM photos`;
  await sql`DELETE FROM albums`;
});

describe("albums repo", () => {
  it("creates and reads an album", async () => {
    const a = await createAlbum({ title: "Anna & Oleh", subtitle: "Wedding", status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    expect(a.slug).toMatch(/^anna-oleh/);
    const got = await getAlbumBySlug(a.slug, { userId: TEST_ADMIN_USER_ID, role: "owner" });
    expect(got?.id).toBe(a.id);
  });

  it("lists albums excluding soft-deleted", async () => {
    const a = await createAlbum({ title: "ToDelete", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    await softDeleteAlbum(a.id);
    const all = await listAlbums({ userId: TEST_ADMIN_USER_ID, role: "owner" });
    expect(all.find((x) => x.id === a.id)).toBeUndefined();
  });

  it("inserts photo with status processing, lists, updates, reorders", async () => {
    const a = await createAlbum({ title: "Photos", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    const p1 = await insertPhoto({ id: crypto.randomUUID(), album_id: a.id, filename: "a.jpg", width: 100, height: 80, orig_bytes: 1234, taken_at: null });
    const p2 = await insertPhoto({ id: crypto.randomUUID(), album_id: a.id, filename: "b.jpg", width: 100, height: 80, orig_bytes: 1234, taken_at: null });
    const photos = await listPhotos(a.id);
    expect(photos.length).toBe(2);
    expect(photos[0].status).toBe("processing");

    await setCover(a.id, p2.id);
    const a2 = await getAlbumBySlug(a.slug, { userId: TEST_ADMIN_USER_ID, role: "owner" });
    expect(a2?.cover_photo_id).toBe(p2.id);

    await reorderPhotos(a.id, [p2.id, p1.id]);
    const reordered = await listPhotos(a.id);
    expect(reordered.map((x) => x.id)).toEqual([p2.id, p1.id]);

    await markPhotoReady(p1.id);
    const r = await listPhotos(a.id);
    expect(r.find((x) => x.id === p1.id)?.status).toBe("ready");

    await deletePhoto(p1.id);
    const after = await listPhotos(a.id);
    expect(after.length).toBe(1);
  });

  it("insertPhotosBatch writes N rows in one round-trip with monotonic sort_order", async () => {
    const a = await createAlbum({ title: "Batch", subtitle: null, status: "draft", ownerUserId: TEST_ADMIN_USER_ID });
    // Pre-seed one photo so we can verify base = MAX(sort_order)+1.
    const seed = await insertPhoto({
      id: crypto.randomUUID(),
      album_id: a.id,
      filename: "seed.jpg",
      width: 10,
      height: 10,
      orig_bytes: 1,
      taken_at: null,
    });
    const batch = Array.from({ length: 5 }, (_v, i) => ({
      id: crypto.randomUUID(),
      album_id: a.id,
      filename: `batch-${i}.jpg`,
      width: 100,
      height: 80,
      orig_bytes: 9000 + i,
      taken_at: null,
    }));
    const inserted = await insertPhotosBatch(batch);
    expect(inserted.length).toBe(5);
    expect(inserted.every((p) => p.status === "processing")).toBe(true);
    // Sort order must continue from seed's sort_order.
    const all = await listPhotos(a.id);
    expect(all[0].id).toBe(seed.id);
    expect(all.slice(1).map((p) => p.filename)).toEqual(["batch-0.jpg", "batch-1.jpg", "batch-2.jpg", "batch-3.jpg", "batch-4.jpg"]);
  });

  it("insertPhotosBatch is a no-op on empty input", async () => {
    const out = await insertPhotosBatch([]);
    expect(out).toEqual([]);
  });
});
