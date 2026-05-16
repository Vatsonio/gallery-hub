import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("SESSION_PASSWORD production guard", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws when production + SESSION_PASSWORD missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_PASSWORD", "");
    await expect(import("@/lib/session")).rejects.toThrow(
      /SESSION_PASSWORD env var is required in production/
    );
  });

  it("returns the dev fallback when not production + SESSION_PASSWORD missing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_PASSWORD", "");
    const { sessionOptions: fresh } = await import("@/lib/session");
    expect(fresh.password).toBe(
      "dev-only-insecure-password-please-override-in-production-env"
    );
  });

  it("accepts SESSION_PASSWORD in production when set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_PASSWORD", "p".repeat(40));
    const { sessionOptions: fresh } = await import("@/lib/session");
    expect(fresh.password).toBe("p".repeat(40));
  });

  // F1 regression — placeholder secrets must be rejected in production. The
  // dev.bat-committed value `dev-demo-secret-thirty-two-chars-long-pls`
  // satisfies the documented "32+ chars" rule, so an operator could paste it
  // into a prod env file by accident and have a forgeable admin cookie.
  it("rejects the known dev.bat placeholder in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_PASSWORD", "dev-demo-secret-thirty-two-chars-long-pls");
    await expect(import("@/lib/session")).rejects.toThrow(
      /known placeholder value/
    );
  });

  it("rejects the .env.example placeholder in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_PASSWORD", "replace-me-with-a-32-plus-character-secret");
    await expect(import("@/lib/session")).rejects.toThrow(
      /known placeholder value/
    );
  });

  it("rejects the in-source dev fallback in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "SESSION_PASSWORD",
      "dev-only-insecure-password-please-override-in-production-env"
    );
    await expect(import("@/lib/session")).rejects.toThrow(
      /known placeholder value/
    );
  });

  it("tolerates placeholder secrets in dev (warning-only)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SESSION_PASSWORD", "dev-demo-secret-thirty-two-chars-long-pls");
    const { sessionOptions: fresh, isPlaceholderSessionPassword } = await import(
      "@/lib/session"
    );
    expect(fresh.password).toBe("dev-demo-secret-thirty-two-chars-long-pls");
    expect(isPlaceholderSessionPassword(fresh.password as string)).toBe(true);
  });
});
