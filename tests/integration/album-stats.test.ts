import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { setupTestDb, resetTestDb } from "./_helpers";
import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { loadAlbumStats } from "@/lib/albumStats";

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
}, 60_000);

beforeEach(async () => {
  await resetTestDb();
});

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

async function album(slug: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO albums (id, slug, title, status)
    VALUES (${id}, ${slug}, ${"T-" + slug}, 'draft')
  `;
  return id;
}

interface PhotoSeed {
  taken_at?: Date | null;
  orig_bytes?: number;
  exif?: { camera?: string; lens?: string } | null;
}

async function photo(albumId: string, seed: PhotoSeed = {}): Promise<string> {
  const id = randomUUID();
  // postgres.js needs the sql.json helper to coerce JS objects into a
  // JSONB-typed parameter; a raw JSON.stringify lands as a string and
  // the `->>` operator on a string column returns null.
  await sql`
    INSERT INTO photos (id, album_id, filename, width, height, orig_bytes, sort_order, status, taken_at, exif)
    VALUES (
      ${id}, ${albumId}, ${id + ".jpg"}, 100, 100,
      ${seed.orig_bytes ?? 1_000_000}, 0, 'ready',
      ${seed.taken_at ?? null},
      ${seed.exif ? sql.json(seed.exif) : null}
    )
  `;
  return id;
}

describe.skipIf(dockerOff)("loadAlbumStats", () => {
  it("returns zero-state shape for an empty album", async () => {
    const id = await album("empty");
    const s = await loadAlbumStats(id);
    expect(s).toEqual({
      storage_bytes: 0,
      shot_from: null,
      shot_to: null,
      top_camera: null,
      top_camera_pct: null,
      library_bytes: 0,
    });
  });

  it("sums storage bytes across photos and reports library total", async () => {
    const a = await album("storage-a");
    const b = await album("storage-b");
    await photo(a, { orig_bytes: 2_000_000 });
    await photo(a, { orig_bytes: 3_000_000 });
    await photo(b, { orig_bytes: 500_000 });
    const s = await loadAlbumStats(a);
    expect(s.storage_bytes).toBe(5_000_000);
    expect(s.library_bytes).toBe(5_500_000);
  });

  it("computes the shot date range from taken_at", async () => {
    const id = await album("dates");
    await photo(id, { taken_at: new Date("2026-09-12T10:00:00Z") });
    await photo(id, { taken_at: new Date("2026-09-14T18:30:00Z") });
    await photo(id, { taken_at: null });
    const s = await loadAlbumStats(id);
    expect(s.shot_from).toBe("2026-09-12T10:00:00.000Z");
    expect(s.shot_to).toBe("2026-09-14T18:30:00.000Z");
  });

  it("derives the top camera and percentage from EXIF", async () => {
    const id = await album("cameras");
    await photo(id, { exif: { camera: "Sony A7M3" } });
    await photo(id, { exif: { camera: "Sony A7M3" } });
    await photo(id, { exif: { camera: "Sony A7M3" } });
    await photo(id, { exif: { camera: "Canon R5" } });
    await photo(id, {}); // no exif — excluded from percentage
    const s = await loadAlbumStats(id);
    expect(s.top_camera).toBe("Sony A7M3");
    // 3 of 4 EXIF-tagged photos used the A7M3.
    expect(s.top_camera_pct).toBe(75);
  });

  it("returns null camera when no photo has EXIF", async () => {
    const id = await album("no-exif");
    await photo(id);
    await photo(id);
    const s = await loadAlbumStats(id);
    expect(s.top_camera).toBeNull();
    expect(s.top_camera_pct).toBeNull();
  });
});
