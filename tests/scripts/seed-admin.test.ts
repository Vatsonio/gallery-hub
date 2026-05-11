import { describe, expect, it, beforeAll } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@/../scripts/migrate";
import { seedAdmin } from "@/../scripts/seed-admin";
import { verifyPassword } from "@/lib/passwords";

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";
const url = () => process.env.DATABASE_URL!;

// TODO[docker-off]: unskip when Docker is available
describe.skipIf(dockerOff)("seedAdmin", () => {
  beforeAll(async () => {
    await runMigrations({ databaseUrl: url(), silent: true });
  });

  it("inserts a new admin when none exists", async () => {
    const sql = postgres(url(), { max: 1 });
    try {
      await sql`DELETE FROM admin_users WHERE email = 'seed@example.com'`;
      await seedAdmin({
        databaseUrl: url(),
        email: "seed@example.com",
        password: "first-pass",
        silent: true
      });
      const rows = await sql<{ email: string; password_hash: string }[]>`
        SELECT email, password_hash FROM admin_users WHERE email = 'seed@example.com'
      `;
      expect(rows.length).toBe(1);
      expect(await verifyPassword(rows[0].password_hash, "first-pass")).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it("updates the password when the admin already exists", async () => {
    await seedAdmin({
      databaseUrl: url(),
      email: "seed@example.com",
      password: "second-pass",
      silent: true
    });
    const sql = postgres(url(), { max: 1 });
    try {
      const rows = await sql<{ password_hash: string }[]>`
        SELECT password_hash FROM admin_users WHERE email = 'seed@example.com'
      `;
      expect(await verifyPassword(rows[0].password_hash, "second-pass")).toBe(true);
      expect(await verifyPassword(rows[0].password_hash, "first-pass")).toBe(false);
    } finally {
      await sql.end();
    }
  });
});
