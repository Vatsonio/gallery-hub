import { beforeAll, describe, expect, it } from "vitest";
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
