import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the S3 SDK BEFORE importing the module under test — the lib captures
// `s3Client.send` at import-evaluation time via the lazy proxy.
vi.mock("@aws-sdk/client-s3", () => {
  const send = vi.fn();
  class S3Client {
    send = send;
  }
  class ListObjectsV2Command {
    constructor(public input: unknown) {}
  }
  class HeadBucketCommand {
    constructor(public input: unknown) {}
  }
  class CreateBucketCommand {
    constructor(public input: unknown) {}
  }
  class HeadObjectCommand {
    constructor(public input: unknown) {}
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
  }
  return {
    S3Client,
    ListObjectsV2Command,
    HeadBucketCommand,
    CreateBucketCommand,
    HeadObjectCommand,
    GetObjectCommand,
    __send: send,
  };
});

// Mock the sql tag template to return the fixed row our test wants. The
// real lib reaches into postgres.js; tagged-template support is what we
// need to imitate.
vi.mock("@/lib/db", () => {
  return {
    sql: vi.fn(async () => [
      {
        pg_db_size_bytes: "12345678",
        photos_orig_bytes_sum: "8765432",
      },
    ]),
  };
});

vi.mock("@/lib/analytics", () => {
  return {
    safeCapture: vi.fn(),
  };
});

import * as s3 from "@aws-sdk/client-s3";
import * as analytics from "@/lib/analytics";
import {
  evaluateQuota,
  getStorageUsage,
  checkStorageQuota,
  STORAGE_CRITICAL_PCT,
} from "@/lib/storage-monitor";

const send = (s3 as unknown as { __send: ReturnType<typeof vi.fn> }).__send;
const safeCapture = analytics.safeCapture as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  send.mockReset();
  safeCapture.mockReset();
});

afterEach(() => {
  delete process.env.STORAGE_QUOTA_BYTES;
  delete process.env.BACKUP_MANIFEST_DIR;
});

describe("evaluateQuota (pure)", () => {
  it("emits when usage >= 85% of quota", () => {
    const r = evaluateQuota(85, 100);
    expect(r.skipped).toBe(false);
    expect(r.emitted).toBe(true);
    expect(r.used_pct).toBe(85);
  });

  it("does NOT emit at 84%", () => {
    const r = evaluateQuota(84, 100);
    expect(r.emitted).toBe(false);
    expect(r.used_pct).toBe(84);
  });

  it("is skipped when quota is null", () => {
    const r = evaluateQuota(999, null);
    expect(r.skipped).toBe(true);
    expect(r.emitted).toBe(false);
    expect(r.used_pct).toBeNull();
  });

  it("is skipped when quota is 0 or negative", () => {
    expect(evaluateQuota(10, 0).skipped).toBe(true);
    expect(evaluateQuota(10, -5).skipped).toBe(true);
  });

  it("emits exactly at the threshold boundary", () => {
    const r = evaluateQuota(STORAGE_CRITICAL_PCT, 100);
    expect(r.emitted).toBe(true);
  });
});

describe("getStorageUsage", () => {
  it("returns the shape /chikaq expects, paginating the bucket walk", async () => {
    // Page 1 — truncated.
    send.mockResolvedValueOnce({
      Contents: [
        { Key: "a", Size: 1000 },
        { Key: "b", Size: 2000 },
      ],
      IsTruncated: true,
      NextContinuationToken: "tok",
    });
    // Page 2 — final.
    send.mockResolvedValueOnce({
      Contents: [{ Key: "c", Size: 500 }],
      IsTruncated: false,
    });

    const usage = await getStorageUsage();
    expect(usage.minio_bytes).toBe(3500);
    expect(usage.minio_objects).toBe(3);
    expect(usage.postgres_db_size_bytes).toBe(12345678);
    expect(usage.photos_orig_bytes_sum).toBe(8765432);
    expect(usage.last_backup_at).toBeNull();
    expect(usage.last_mirror_at).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(s3.ListObjectsV2Command);
  });

  it("tolerates a bucket with no objects", async () => {
    send.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });
    const usage = await getStorageUsage();
    expect(usage.minio_bytes).toBe(0);
    expect(usage.minio_objects).toBe(0);
  });
});

describe("checkStorageQuota", () => {
  it("skips silently when STORAGE_QUOTA_BYTES is unset", async () => {
    send.mockResolvedValueOnce({
      Contents: [{ Key: "a", Size: 1000 }],
      IsTruncated: false,
    });
    const r = await checkStorageQuota();
    expect(r.skipped).toBe(true);
    expect(r.emitted).toBe(false);
    expect(safeCapture).not.toHaveBeenCalled();
  });

  it("emits a storage_critical PostHog event at 85%", async () => {
    process.env.STORAGE_QUOTA_BYTES = "1000";
    send.mockResolvedValueOnce({
      Contents: [{ Key: "a", Size: 900 }], // 90%
      IsTruncated: false,
    });
    const r = await checkStorageQuota();
    expect(r.emitted).toBe(true);
    expect(r.used_pct).toBe(90);
    expect(safeCapture).toHaveBeenCalledOnce();
    const call = safeCapture.mock.calls[0][0] as {
      event: string;
      properties: { used_bytes: number; quota_bytes: number };
    };
    expect(call.event).toBe("storage_critical");
    expect(call.properties.used_bytes).toBe(900);
    expect(call.properties.quota_bytes).toBe(1000);
  });

  it("does not emit at 84%", async () => {
    process.env.STORAGE_QUOTA_BYTES = "1000";
    send.mockResolvedValueOnce({
      Contents: [{ Key: "a", Size: 840 }],
      IsTruncated: false,
    });
    const r = await checkStorageQuota();
    expect(r.emitted).toBe(false);
    expect(safeCapture).not.toHaveBeenCalled();
  });

  it("treats malformed STORAGE_QUOTA_BYTES as unset", async () => {
    process.env.STORAGE_QUOTA_BYTES = "not-a-number";
    send.mockResolvedValueOnce({
      Contents: [{ Key: "a", Size: 1000 }],
      IsTruncated: false,
    });
    const r = await checkStorageQuota();
    expect(r.skipped).toBe(true);
    expect(safeCapture).not.toHaveBeenCalled();
  });
});
