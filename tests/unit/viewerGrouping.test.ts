import { describe, it, expect } from "vitest";
import { groupFavoriteEvents } from "@/lib/viewerGrouping";

const ev = (token: string, viewer: string, at: string) => ({
  share_token: token,
  viewer_id: viewer,
  created_at: new Date(at),
  album_title: "X",
});

describe("groupFavoriteEvents", () => {
  it("merges events within 5 minutes for same (token,viewer)", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T10:00:00Z"),
      ev("t1", "v1", "2026-05-11T10:02:00Z"),
      ev("t1", "v1", "2026-05-11T10:04:30Z"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].added_count).toBe(3);
    expect(out[0].viewer_id_short).toBe("v1");
  });

  it("splits when gap > 5 minutes", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T10:00:00Z"),
      ev("t1", "v1", "2026-05-11T10:06:00Z"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("separates different viewers", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T10:00:00Z"),
      ev("t1", "v2", "2026-05-11T10:01:00Z"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("returns viewer_id_short as first 8 chars", () => {
    const out = groupFavoriteEvents([
      ev("t1", "a4f12345abcdef", "2026-05-11T10:00:00Z"),
    ]);
    expect(out[0].viewer_id_short).toBe("a4f12345");
  });

  it("orders by `at` descending (most recent first)", () => {
    const out = groupFavoriteEvents([
      ev("t1", "v1", "2026-05-11T09:00:00Z"),
      ev("t2", "v2", "2026-05-11T10:00:00Z"),
    ]);
    expect(out[0].album_title).toBe("X");
    expect(out[0].at).toBe("2026-05-11T10:00:00.000Z");
  });
});
