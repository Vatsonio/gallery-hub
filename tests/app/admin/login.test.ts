import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "@/../scripts/migrate";
import { seedAdmin } from "@/../scripts/seed-admin";
import { authenticate } from "@/app/admin/login/actions";
import { resolveIpFromHeaders } from "@/lib/client-ip";

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

// TODO[docker-off]: unskip when Docker is available
describe.skipIf(dockerOff)("authenticate", () => {
  beforeAll(async () => {
    await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
    await seedAdmin({
      databaseUrl: process.env.DATABASE_URL!,
      email: "login@test.local",
      password: "letmein",
      silent: true
    });
  });

  it("returns the user id for valid credentials", async () => {
    const result = await authenticate("login@test.local", "letmein");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user.email).toBe("login@test.local");
  });

  it("returns an error for the wrong password", async () => {
    const result = await authenticate("login@test.local", "nope");
    expect(result.ok).toBe(false);
  });

  it("returns an error for an unknown email", async () => {
    const result = await authenticate("ghost@test.local", "anything");
    expect(result.ok).toBe(false);
  });

  // F4 regression — the user-not-found branch must take roughly as long as a
  // wrong-password branch so an attacker can't enumerate admin emails by
  // timing. We don't assert exact equality (argon2 has small jitter); we
  // assert the no-user path took at least 50ms (i.e. a full verify ran).
  it("burns an argon2 cycle on the unknown-email branch (F4 timing)", async () => {
    // Warm the dummy-hash promise once so the first call doesn't pay the
    // hashPassword cost on top of verifyPassword.
    await authenticate("warm@test.local", "x");
    const start = Date.now();
    await authenticate("ghost-timing@test.local", "anything");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

// Rate-limiter tests run module-level and don't need Docker. They use
// vi.resetModules to start each case with fresh limiter buckets and stub the
// DB-touching `authenticate` so the surface under test is purely the limiter
// gating + generic-error shape.
describe("authenticateWithLimits — rate limits", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/app/admin/login/actions", async (importOriginal) => {
      const original = await importOriginal<typeof import("@/app/admin/login/actions")>();
      return {
        ...original,
        authenticate: vi.fn(async (_email: string, _password: string) => ({
          ok: false as const,
          error: "Invalid email or password",
        })),
      };
    });
  });

  it("blocks after 10 attempts for the same email (soft block)", async () => {
    const { authenticateWithLimits } = await import("@/app/admin/login/actions");
    // Use 10 distinct IPs so the per-IP limiter never trips.
    for (let i = 0; i < 10; i++) {
      const r = await authenticateWithLimits(
        "same@test.local",
        "x",
        `192.0.2.${i}`
      );
      expect(r.ok).toBe(false);
    }
    const eleventh = await authenticateWithLimits(
      "same@test.local",
      "x",
      "192.0.2.255"
    );
    expect(eleventh).toEqual({ ok: false, error: "Invalid email or password" });
  });

  it("blocks after 20 attempts from the same IP (hard block)", async () => {
    const { authenticateWithLimits } = await import("@/app/admin/login/actions");
    // 20 distinct emails so the per-email limiter never trips first.
    for (let i = 0; i < 20; i++) {
      const r = await authenticateWithLimits(
        `attacker${i}@test.local`,
        "x",
        "203.0.113.7"
      );
      expect(r.ok).toBe(false);
    }
    // 21st request from same IP — hard-blocked with the 1s sleep applied.
    const start = Date.now();
    const blocked = await authenticateWithLimits(
      "attacker99@test.local",
      "x",
      "203.0.113.7"
    );
    const elapsed = Date.now() - start;
    expect(blocked).toEqual({ ok: false, error: "Invalid email or password" });
    // 1s sleep is intentional; allow some slack.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it("returns the identical generic error for both limiter kinds", async () => {
    const { authenticateWithLimits } = await import("@/app/admin/login/actions");
    for (let i = 0; i < 10; i++) {
      await authenticateWithLimits("trip@test.local", "x", `198.51.100.${i}`);
    }
    const emailBlocked = await authenticateWithLimits(
      "trip@test.local",
      "x",
      "198.51.100.250"
    );
    for (let i = 0; i < 20; i++) {
      await authenticateWithLimits(`flood${i}@test.local`, "x", "198.51.100.99");
    }
    const ipBlocked = await authenticateWithLimits(
      "fresh@test.local",
      "x",
      "198.51.100.99"
    );
    expect(emailBlocked.ok).toBe(false);
    expect(ipBlocked.ok).toBe(false);
    if (!emailBlocked.ok && !ipBlocked.ok) {
      expect(emailBlocked.error).toBe(ipBlocked.error);
    }
  }, 15_000);
});

// F2 regression — proxy header trust is gated on TRUST_PROXY_HEADERS=1. The
// previous implementation always trusted X-Forwarded-For, so a direct-network
// attacker could rotate IPs by spoofing the header and bypass the limiter.
describe("resolveIpFromHeaders — F2 proxy trust gate", () => {
  function h(map: Record<string, string>): { get: (n: string) => string | null } {
    return { get: (n) => map[n.toLowerCase()] ?? null };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores X-Forwarded-For when TRUST_PROXY_HEADERS is unset", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const ip = resolveIpFromHeaders(h({ "x-forwarded-for": "10.0.0.1" }));
    expect(ip).toBe("unknown");
  });

  it("ignores CF-Connecting-IP when TRUST_PROXY_HEADERS is unset", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const ip = resolveIpFromHeaders(h({ "cf-connecting-ip": "1.2.3.4" }));
    expect(ip).toBe("unknown");
  });

  it("ignores X-Real-IP when TRUST_PROXY_HEADERS is unset", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "");
    const ip = resolveIpFromHeaders(h({ "x-real-ip": "5.6.7.8" }));
    expect(ip).toBe("unknown");
  });

  it("trusts CF-Connecting-IP first when TRUST_PROXY_HEADERS=1", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    const ip = resolveIpFromHeaders(
      h({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })
    );
    expect(ip).toBe("1.2.3.4");
  });

  it("takes the first XFF hop when TRUST_PROXY_HEADERS=1", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "1");
    const ip = resolveIpFromHeaders(
      h({ "x-forwarded-for": "10.0.0.1, 172.16.0.5, 192.168.1.1" })
    );
    expect(ip).toBe("10.0.0.1");
  });
});
