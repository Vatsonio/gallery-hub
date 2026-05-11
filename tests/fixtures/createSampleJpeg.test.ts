import { describe, it, expect } from "vitest";
import { createSampleJpeg } from "./createSampleJpeg";
import sharp from "sharp";

describe("createSampleJpeg", () => {
  it("returns a JPEG buffer with given dimensions", async () => {
    const buf = await createSampleJpeg(800, 600);
    expect(buf.length).toBeGreaterThan(100);
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(600);
  });
});
