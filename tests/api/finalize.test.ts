import { describe, it, expect, beforeAll, vi } from "vitest";
import { POST } from "@/app/api/upload/finalize/route";
import { createAlbum, listPhotos } from "@/lib/albums";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";
import { runMigrations } from "@/../scripts/migrate";

function mockReq(body: unknown): Request {
  return new Request("http://t/api/upload/finalize", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-admin": "1" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await runMigrations({ databaseUrl: process.env.DATABASE_URL!, silent: true });
});

describe("POST /api/upload/finalize", () => {
  it("inserts photos at status=processing and enqueues jobs", async () => {
    const a = await createAlbum({ title: "Fin", subtitle: null, status: "draft" });
    const photo_id_1 = crypto.randomUUID();
    const photo_id_2 = crypto.randomUUID();
    const res = await POST(mockReq({
      album_id: a.id,
      photos: [
        { photo_id: photo_id_1, filename: "a.jpg", width: 4000, height: 3000, size: 12345 },
        { photo_id: photo_id_2, filename: "b.jpg", width: 1000, height: 800, size: 5000 },
      ],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.inserted).toBe(2);

    const photos = await listPhotos(a.id);
    expect(photos).toHaveLength(2);
    expect(photos.every((p) => p.status === "processing")).toBe(true);

    const boss = await getBoss();
    const jobs = await boss.fetch(GENERATE_DERIVATIVES_QUEUE);
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    expect(job).toBeTruthy();
    expect(job?.data).toMatchObject({ album_id: a.id });
    if (job) await boss.complete(GENERATE_DERIVATIVES_QUEUE, job.id);
  });
});
