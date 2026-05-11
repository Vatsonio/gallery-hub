import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn()
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { presignPut, presignGet } from "@/lib/presign";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const mocked = vi.mocked(getSignedUrl);

beforeEach(() => {
  mocked.mockReset();
});

describe("presign", () => {
  it("presignPut delegates to getSignedUrl with a PutObjectCommand", async () => {
    mocked.mockResolvedValueOnce("https://example.test/put?X-Amz-Signature=abc");
    const url = await presignPut("albums/a/p/original.jpg", "image/jpeg", 60);
    expect(url).toBe("https://example.test/put?X-Amz-Signature=abc");
    expect(mocked).toHaveBeenCalledTimes(1);
    const cmd = mocked.mock.calls[0][1];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(mocked.mock.calls[0][2]).toEqual({ expiresIn: 60 });
  });

  it("presignGet delegates to getSignedUrl with a GetObjectCommand", async () => {
    mocked.mockResolvedValueOnce("https://example.test/get?X-Amz-Signature=def");
    const url = await presignGet("albums/a/p/web.webp", 30);
    expect(url).toBe("https://example.test/get?X-Amz-Signature=def");
    const cmd = mocked.mock.calls[0][1];
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(mocked.mock.calls[0][2]).toEqual({ expiresIn: 30 });
  });

  it("presignPut and presignGet have sensible default TTLs", async () => {
    mocked.mockResolvedValue("https://example.test/x");
    await presignPut("k.jpg", "image/jpeg");
    await presignGet("k.jpg");
    expect(mocked.mock.calls[0][2]).toEqual({ expiresIn: 900 }); // 15 min default for PUT
    expect(mocked.mock.calls[1][2]).toEqual({ expiresIn: 3600 }); // 1 hour default for GET
  });
});
