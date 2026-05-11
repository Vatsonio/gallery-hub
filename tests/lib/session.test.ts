import { describe, expect, it, vi } from "vitest";
import { sessionOptions } from "@/lib/session";

describe("sessionOptions", () => {
  it("uses the SESSION_PASSWORD env var", () => {
    process.env.SESSION_PASSWORD = "x".repeat(40);
    // Re-import to pick up env change. vi.resetModules() forces vitest to
    // re-evaluate the module so the top-level `process.env.SESSION_PASSWORD`
    // read picks up the value we just assigned (ESM module caching otherwise
    // returns the previously evaluated module).
    vi.resetModules();
    return import("@/lib/session").then(({ sessionOptions: fresh }) => {
      expect(fresh.password).toBe("x".repeat(40));
    });
  });

  it("exposes a fixed cookie name", () => {
    expect(sessionOptions.cookieName).toBe("gh_admin_session");
  });

  it("sets secure cookie defaults", () => {
    expect(sessionOptions.cookieOptions?.httpOnly).toBe(true);
    expect(sessionOptions.cookieOptions?.sameSite).toBe("lax");
    expect(sessionOptions.cookieOptions?.path).toBe("/");
  });
});
