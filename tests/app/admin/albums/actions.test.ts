import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return {
    ...actual,
    requireAdminSessionFromCookies: vi.fn().mockResolvedValue({ ok: true, userId: "t", email: "t@t" }),
  };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  createAlbumAction, updateAlbumAction, softDeleteAlbumAction,
  setCoverAction, reorderPhotosAction, deletePhotoAction
} from "@/app/admin/albums/actions";
import { getAlbumBySlug, insertPhoto, listPhotos } from "@/lib/albums";
import { runMigrations } from "@/../scripts/migrate";

beforeAll(async () => {
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
});

describe("album server actions", () => {
  it("createAlbumAction returns slug and persists row", async () => {
    const slug = await createAlbumAction({ title: "ActionA", subtitle: "sub", status: "draft" });
    expect(typeof slug).toBe("string");
    const got = await getAlbumBySlug(slug);
    expect(got?.title).toBe("ActionA");
  });

  it("updateAlbumAction updates title", async () => {
    const slug = await createAlbumAction({ title: "Before", subtitle: null, status: "draft" });
    const a = await getAlbumBySlug(slug); expect(a).not.toBeNull();
    await updateAlbumAction(a!.id, { title: "After" });
    const a2 = await getAlbumBySlug(slug);
    expect(a2?.title).toBe("After");
  });

  it("softDeleteAlbumAction hides from listing", async () => {
    const slug = await createAlbumAction({ title: "Doomed", subtitle: null, status: "draft" });
    const a = await getAlbumBySlug(slug);
    await softDeleteAlbumAction(a!.id);
    expect(await getAlbumBySlug(slug)).toBeNull();
  });

  it("setCover/reorder/delete photo work", async () => {
    const slug = await createAlbumAction({ title: "Acts", subtitle: null, status: "draft" });
    const a = await getAlbumBySlug(slug); expect(a).not.toBeNull();
    const pa = crypto.randomUUID(), pb = crypto.randomUUID();
    await insertPhoto({ id: pa, album_id: a!.id, filename: "a.jpg", width: 1, height: 1, orig_bytes: 1, taken_at: null });
    await insertPhoto({ id: pb, album_id: a!.id, filename: "b.jpg", width: 1, height: 1, orig_bytes: 1, taken_at: null });

    await setCoverAction(a!.id, pb);
    const a2 = await getAlbumBySlug(slug);
    expect(a2?.cover_photo_id).toBe(pb);

    await reorderPhotosAction(a!.id, [pb, pa]);
    const ordered = await listPhotos(a!.id);
    expect(ordered.map((p) => p.id)).toEqual([pb, pa]);

    await deletePhotoAction(pa);
    const after = await listPhotos(a!.id);
    expect(after).toHaveLength(1);
  });
});
