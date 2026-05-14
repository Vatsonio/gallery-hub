import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/minio", () => ({
  s3Client: { send: vi.fn().mockResolvedValue({}) },
  ensureBucket: vi.fn().mockResolvedValue(undefined),
  BUCKET: "gallery"
}));

import { runMigrations } from "@/../scripts/migrate";
import { GET } from "@/app/api/health/route";

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

// TODO[docker-off]: unskip when Docker is available
describe.skipIf(dockerOff)("GET /api/health", () => {
  beforeAll(async () => {
    await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
  });

  it("returns ok statuses when db and minio respond", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.db).toBe("ok");
    expect(body.minio).toBe("ok");
    expect(res.status).toBe(200);
  });

  it("returns the documented response shape with uptime_s and version", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        db: expect.any(String),
        minio: expect.any(String),
        uptime_s: expect.any(Number),
        version: expect.any(String)
      })
    );
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
    expect(["ok", "fail"]).toContain(body.db);
    expect(["ok", "fail"]).toContain(body.minio);
  });
});
