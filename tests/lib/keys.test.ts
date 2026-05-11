import { describe, it, expect } from "vitest";
import { originalKey, variantKey, extFromContentType } from "@/lib/keys";

describe("keys", () => {
  it("originalKey returns albums/{album}/{photo}/original.{ext}", () => {
    expect(originalKey("a1", "p1", "jpg")).toBe("albums/a1/p1/original.jpg");
  });
  it("variantKey returns albums/{album}/{photo}/{variant}.webp", () => {
    expect(variantKey("a1", "p1", "thumb")).toBe("albums/a1/p1/thumb.webp");
    expect(variantKey("a1", "p1", "web")).toBe("albums/a1/p1/web.webp");
    expect(variantKey("a1", "p1", "large")).toBe("albums/a1/p1/large.webp");
  });
  it("extFromContentType maps jpeg and png", () => {
    expect(extFromContentType("image/jpeg")).toBe("jpg");
    expect(extFromContentType("image/png")).toBe("png");
    expect(extFromContentType("image/webp")).toBe("webp");
  });
  it("extFromContentType throws on unsupported", () => {
    expect(() => extFromContentType("application/pdf")).toThrow();
  });
});
