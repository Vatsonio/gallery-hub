import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn()
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  presignPut,
  presignGet,
  contentDispositionAttachment,
  __resetPresignCache,
} from "@/lib/presign";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const mocked = vi.mocked(getSignedUrl);

beforeEach(() => {
  mocked.mockReset();
  __resetPresignCache();
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

  it("presignGet forwards ResponseContentDisposition + ResponseContentType when supplied", async () => {
    mocked.mockResolvedValueOnce("https://example.test/get?cd=1");
    await presignGet("albums/a/p/original.jpg", 120, {
      responseContentDisposition: 'attachment; filename="sunset.jpg"',
      responseContentType: "image/jpeg",
    });
    const cmd = mocked.mock.calls[0][1] as GetObjectCommand;
    expect(cmd.input.ResponseContentDisposition).toBe(
      'attachment; filename="sunset.jpg"',
    );
    expect(cmd.input.ResponseContentType).toBe("image/jpeg");
  });
});

describe("contentDispositionAttachment", () => {
  it("produces an attachment header with quoted ASCII fallback + RFC5987 UTF-8", () => {
    const h = contentDispositionAttachment("sunset.jpg");
    expect(h).toBe(
      `attachment; filename="sunset.jpg"; filename*=UTF-8''sunset.jpg`,
    );
  });

  it("strips control chars and quotes from the ASCII fallback", () => {
    const h = contentDispositionAttachment('bad"name\nfile.jpg');
    expect(h).toContain('filename="badnamefile.jpg"');
    // The UTF-8 form preserves the exact original (URL-encoded).
    expect(h).toContain("filename*=UTF-8''");
  });

  it("falls back to 'download' for entirely-stripped names", () => {
    const h = contentDispositionAttachment('"""');
    expect(h).toContain('filename="download"');
  });
});
