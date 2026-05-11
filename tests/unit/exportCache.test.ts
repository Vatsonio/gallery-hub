import { describe, it, expect } from "vitest";
import { buildCacheKey, favoritesSignature } from "@/lib/exportCache";

describe("buildCacheKey", () => {
  it("formats key as exports/{token}/{scope}-{variant}-{YYYY-MM-DD}.zip", () => {
    const d = new Date("2026-05-11T08:33:00Z");
    expect(buildCacheKey("Hk7eRq8x", "all", "web", d)).toBe(
      "exports/Hk7eRq8x/all-web-2026-05-11.zip",
    );
    expect(buildCacheKey("Hk7eRq8x", "favorites", "original", d)).toBe(
      "exports/Hk7eRq8x/favorites-original-2026-05-11.zip",
    );
  });
});

describe("favoritesSignature", () => {
  it("is order-independent and stable", () => {
    const a = favoritesSignature(["p3", "p1", "p2"]);
    const b = favoritesSignature(["p1", "p2", "p3"]);
    expect(a).toBe(b);
    expect(a).toHaveLength(64); // sha256 hex
  });

  it("changes when set changes", () => {
    const a = favoritesSignature(["p1", "p2"]);
    const c = favoritesSignature(["p1", "p2", "p3"]);
    expect(a).not.toBe(c);
  });

  it("returns 'empty' marker for empty array", () => {
    expect(favoritesSignature([])).toBe("empty");
  });
});
