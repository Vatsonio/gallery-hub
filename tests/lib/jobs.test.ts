import { describe, it, expect, afterAll } from "vitest";
import { getBoss, GENERATE_DERIVATIVES_QUEUE } from "@/lib/jobs";

describe("jobs", () => {
  afterAll(async () => {
    const boss = await getBoss();
    await boss.stop({ graceful: true, wait: false });
  });

  it("enqueues and dequeues a job", async () => {
    const boss = await getBoss();
    const id = await boss.send(GENERATE_DERIVATIVES_QUEUE, { album_id: "a", photo_id: "p", key: "k" });
    expect(typeof id).toBe("string");
    // pg-boss v10: fetch() returns Job[] (array), not a single Job.
    const jobs = await boss.fetch(GENERATE_DERIVATIVES_QUEUE);
    const job = Array.isArray(jobs) ? jobs[0] : jobs;
    expect(job?.data).toMatchObject({ album_id: "a", photo_id: "p", key: "k" });
    if (job) await boss.complete(GENERATE_DERIVATIVES_QUEUE, job.id);
  });
});
