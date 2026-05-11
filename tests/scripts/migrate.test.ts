import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@/../scripts/migrate";

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

// TODO[docker-off]: unskip when Docker is available
describe.skipIf(dockerOff)("runMigrations", () => {
  it("applies all migrations and records them in _migrations", async () => {
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });

      const applied = await sql<{ name: string }[]>`
        SELECT name FROM _migrations ORDER BY name
      `;
      expect(applied.map((r) => r.name)).toEqual([
        "001_admin_users.sql",
        "002_albums.sql",
        "003_photos.sql",
        "004_share_links.sql",
        "005_favorites.sql",
        "006_view_events.sql"
      ]);

      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `;
      const names = tables.map((t) => t.table_name);
      expect(names).toContain("admin_users");
      expect(names).toContain("albums");
      expect(names).toContain("photos");
      expect(names).toContain("share_links");
      expect(names).toContain("favorites");
      expect(names).toContain("view_events");
    } finally {
      await sql.end();
    }
  });

  it("is idempotent on re-run", async () => {
    await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
    // Should not throw — re-running is a no-op.
    expect(true).toBe(true);
  });
});
