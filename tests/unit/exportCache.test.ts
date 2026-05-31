import { describe, it, expect } from "vitest";
import { buildCacheKey, favoritesSignature, contentSignature } from "@/lib/exportCache";

describe("buildCacheKey", () => {
  it("formats key as exports/{token}/{scope}-{variant}-{sig16}-{YYYY-MM-DD}.zip", () => {
    const d = new Date("2026-05-11T08:33:00Z");
    const sig = "0123456789abcdef0123456789abcdef"; // 32 hex; key uses first 16
    expect(buildCacheKey("Hk7eRq8x", "all", "web", sig, d)).toBe(
      "exports/Hk7eRq8x/all-web-0123456789abcdef-2026-05-11.zip",
    );
    expect(buildCacheKey("Hk7eRq8x", "favorites", "original", sig, d)).toBe(
      "exports/Hk7eRq8x/favorites-original-0123456789abcdef-2026-05-11.zip",
    );
  });

  it("different signatures yield different keys (F20/F50: content-addressed)", () => {
    const d = new Date("2026-05-11T08:33:00Z");
    const a = buildCacheKey("t", "all", "web", contentSignature([{ id: "p1", updated_at: "u1" }]), d);
    const b = buildCacheKey("t", "all", "web", contentSignature([{ id: "p1", updated_at: "u2" }]), d);
    expect(a).not.toBe(b);
  });
});

describe("contentSignature", () => {
  it("is order-independent and edit-sensitive", () => {
    const a = contentSignature([{ id: "p2", updated_at: "u2" }, { id: "p1", updated_at: "u1" }]);
    const b = contentSignature([{ id: "p1", updated_at: "u1" }, { id: "p2", updated_at: "u2" }]);
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    // An edit (updated_at change) flips the signature.
    const c = contentSignature([{ id: "p1", updated_at: "u1b" }, { id: "p2", updated_at: "u2" }]);
    expect(c).not.toBe(a);
  });

  it("returns 'empty' marker for empty array", () => {
    expect(contentSignature([])).toBe("empty");
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
