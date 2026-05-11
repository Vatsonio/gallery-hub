import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

describe("db", () => {
  // TODO[docker-off]: unskip when Docker is available
  it.skipIf(dockerOff)("connects to Postgres and runs a trivial query", async () => {
    const rows = await sql`SELECT 1 AS n`;
    expect(rows[0].n).toBe(1);
  });
});
