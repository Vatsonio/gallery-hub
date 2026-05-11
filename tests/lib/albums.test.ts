import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "@/lib/db";
import {
  createAlbum, getAlbumBySlug, listAlbums, updateAlbum,
  softDeleteAlbum, listPhotos, insertPhoto, setCover,
  reorderPhotos, deletePhoto, markPhotoReady
} from "@/lib/albums";
import { runMigrations } from "@/../scripts/migrate";

beforeAll(async () => {
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  await sql`DELETE FROM photos`;
  await sql`DELETE FROM albums`;
});

describe("albums repo", () => {
  it("creates and reads an album", async () => {
    const a = await createAlbum({ title: "Anna & Oleh", subtitle: "Wedding", status: "draft" });
    expect(a.slug).toMatch(/^anna-oleh/);
    const got = await getAlbumBySlug(a.slug);
    expect(got?.id).toBe(a.id);
  });

  it("lists albums excluding soft-deleted", async () => {
    const a = await createAlbum({ title: "ToDelete", subtitle: null, status: "draft" });
    await softDeleteAlbum(a.id);
    const all = await listAlbums();
    expect(all.find((x) => x.id === a.id)).toBeUndefined();
  });

  it("inserts photo with status processing, lists, updates, reorders", async () => {
    const a = await createAlbum({ title: "Photos", subtitle: null, status: "draft" });
    const p1 = await insertPhoto({ id: crypto.randomUUID(), album_id: a.id, filename: "a.jpg", width: 100, height: 80, orig_bytes: 1234, taken_at: null });
    const p2 = await insertPhoto({ id: crypto.randomUUID(), album_id: a.id, filename: "b.jpg", width: 100, height: 80, orig_bytes: 1234, taken_at: null });
    const photos = await listPhotos(a.id);
    expect(photos.length).toBe(2);
    expect(photos[0].status).toBe("processing");

    await setCover(a.id, p2.id);
    const a2 = await getAlbumBySlug(a.slug);
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
});
