import { describe, it, expect } from "vitest";
import { deriveOriginalExt, resolveOriginalExt } from "@/lib/photoExt";

describe("deriveOriginalExt", () => {
  it("recovers ext from a typical phone filename", () => {
    expect(deriveOriginalExt("IMG_0001.jpg")).toBe("jpg");
    expect(deriveOriginalExt("IMG_0001.JPG")).toBe("jpg");
    expect(deriveOriginalExt("IMG_0001.jpeg")).toBe("jpg");
    expect(deriveOriginalExt("flower.png")).toBe("png");
    expect(deriveOriginalExt("portrait.webp")).toBe("webp");
  });

  it("falls back to 'jpg' on missing or unknown ext", () => {
    expect(deriveOriginalExt(null)).toBe("jpg");
    expect(deriveOriginalExt(undefined)).toBe("jpg");
    expect(deriveOriginalExt("")).toBe("jpg");
    expect(deriveOriginalExt("no-ext-here")).toBe("jpg");
    expect(deriveOriginalExt("oddball.heic")).toBe("jpg");
    expect(deriveOriginalExt("script.pdf")).toBe("jpg");
  });

  it("is exposed under the resolveOriginalExt alias for renderer call sites", () => {
    expect(resolveOriginalExt).toBe(deriveOriginalExt);
  });
});
