import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-s3", () => {
  const send = vi.fn();
  class S3Client {
    send = send;
  }
  class HeadBucketCommand {
    constructor(public input: unknown) {}
  }
  class CreateBucketCommand {
    constructor(public input: unknown) {}
  }
  return {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    __send: send
  };
});

import * as s3 from "@aws-sdk/client-s3";
import { ensureBucket, s3Client, BUCKET } from "@/lib/minio";

const send = (s3 as unknown as { __send: ReturnType<typeof vi.fn> }).__send;

afterEach(() => {
  send.mockReset();
});

describe("ensureBucket", () => {
  it("is a no-op when the bucket already exists", async () => {
    send.mockResolvedValueOnce({});
    await ensureBucket();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(s3.HeadBucketCommand);
  });

  it("creates the bucket when HeadBucket fails", async () => {
    send.mockRejectedValueOnce(Object.assign(new Error("not found"), { name: "NotFound" }));
    send.mockResolvedValueOnce({});
    await ensureBucket();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(s3.CreateBucketCommand);
  });

  it("exports a client and a bucket name from env", () => {
    expect(s3Client).toBeDefined();
    expect(BUCKET).toBe(process.env.MINIO_BUCKET ?? "gallery");
  });
});
