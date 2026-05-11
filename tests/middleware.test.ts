import { describe, expect, it } from "vitest";
import { shouldProtect } from "@/middleware";

describe("shouldProtect", () => {
  it("protects /admin and nested admin routes", () => {
    expect(shouldProtect("/admin")).toBe(true);
    expect(shouldProtect("/admin/albums")).toBe(true);
    expect(shouldProtect("/admin/albums/123")).toBe(true);
  });

  it("does NOT protect the login page", () => {
    expect(shouldProtect("/admin/login")).toBe(false);
  });

  it("ignores non-admin routes", () => {
    expect(shouldProtect("/")).toBe(false);
    expect(shouldProtect("/a/abc123")).toBe(false);
    expect(shouldProtect("/api/health")).toBe(false);
  });
});
