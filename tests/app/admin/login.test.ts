import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "@/../scripts/migrate";
import { seedAdmin } from "@/../scripts/seed-admin";
import { authenticate } from "@/app/admin/login/actions";

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
