import { afterEach, describe, expect, it, vi } from "vitest";
import { isSameOrigin, expectedOrigin } from "@/lib/same-origin";

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://example.test/api/x", {
    method: "POST",
    headers,
  });
}

describe("isSameOrigin — F3 CSRF defense", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts requests whose Origin matches PUBLIC_BASE_URL", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(isSameOrigin(reqWith({ origin: "http://localhost:3000" }))).toBe(true);
  });

  it("rejects requests from a different origin", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(isSameOrigin(reqWith({ origin: "http://evil.example.com" }))).toBe(false);
  });

  it("rejects requests missing both Origin and Referer", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(isSameOrigin(reqWith({}))).toBe(false);
  });

  it("falls back to Referer URL when Origin is absent", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(
      isSameOrigin(reqWith({ referer: "http://localhost:3000/admin/albums" })),
    ).toBe(true);
  });

  it("rejects when Referer is from a different host", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(
      isSameOrigin(reqWith({ referer: "http://evil.example.com/x" })),
    ).toBe(false);
  });

  it("rejects when PUBLIC_BASE_URL is unset (fail-closed)", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    expect(isSameOrigin(reqWith({ origin: "http://anywhere" }))).toBe(false);
  });

  it("ignores port mismatch", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    expect(isSameOrigin(reqWith({ origin: "http://localhost:9999" }))).toBe(false);
  });

  it("bypasses for test admins (NODE_ENV=test + x-test-admin: 1)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
    const r = reqWith({ origin: "http://evil.example.com", "x-test-admin": "1" });
    expect(isSameOrigin(r)).toBe(true);
  });

  it("expectedOrigin extracts protocol+host from PUBLIC_BASE_URL", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://gallery.divass.space/admin");
    expect(expectedOrigin()).toBe("https://gallery.divass.space");
  });
});
