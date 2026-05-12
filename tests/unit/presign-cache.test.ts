import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  presignGet,
  __resetPresignCache,
  __presignCacheSize,
} from "@/lib/presign";

const mocked = vi.mocked(getSignedUrl);

beforeEach(() => {
  mocked.mockReset();
  __resetPresignCache();
});

describe("presign LRU cache", () => {
  it("returns the cached URL on a subsequent call with the same key + opts", async () => {
    mocked.mockResolvedValueOnce("https://signed/one");
    const a = await presignGet("albums/x/y/web.webp", 3600);
    const b = await presignGet("albums/x/y/web.webp", 3600);
    expect(a).toBe("https://signed/one");
    expect(b).toBe("https://signed/one");
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("misses when the key differs", async () => {
    mocked
      .mockResolvedValueOnce("https://signed/one")
      .mockResolvedValueOnce("https://signed/two");
    await presignGet("albums/x/y/web.webp", 3600);
    await presignGet("albums/x/y/large.webp", 3600);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("misses when responseCacheControl differs", async () => {
    mocked
      .mockResolvedValueOnce("https://signed/plain")
      .mockResolvedValueOnce("https://signed/immutable");
    await presignGet("k", 3600);
    await presignGet("k", 3600, {
      responseCacheControl: "public, max-age=31536000, immutable",
    });
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("misses when responseContentDisposition differs", async () => {
    mocked
      .mockResolvedValueOnce("https://signed/a")
      .mockResolvedValueOnce("https://signed/b");
    await presignGet("k", 3600);
    await presignGet("k", 3600, {
      responseContentDisposition: 'attachment; filename="x.jpg"',
    });
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry once the LRU exceeds its cap", async () => {
    // Drive past the 5000 cap; only the LRU semantics matter, not the
    // exact eviction order beyond "size never exceeds cap".
    mocked.mockImplementation(() => Promise.resolve("u"));
    for (let i = 0; i < 5050; i++) {
      await presignGet(`k${i}`, 3600);
    }
    expect(__presignCacheSize()).toBeLessThanOrEqual(5000);
  });
});
