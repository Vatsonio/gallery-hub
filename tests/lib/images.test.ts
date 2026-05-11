import { describe, it, expect } from "vitest";
import { generateVariants, readTakenAt } from "@/lib/images";
import { createSampleJpeg } from "../fixtures/createSampleJpeg";
import sharp from "sharp";

describe("generateVariants", () => {
  it("produces thumb/web/large webp with correct max dimensions", async () => {
    const input = await createSampleJpeg(4000, 3000);
    const out = await generateVariants(input);
    expect(out.thumb).toBeInstanceOf(Buffer);
    expect(out.web).toBeInstanceOf(Buffer);
    expect(out.large).toBeInstanceOf(Buffer);

    const tm = await sharp(out.thumb).metadata();
    expect(tm.format).toBe("webp");
    expect(Math.max(tm.width!, tm.height!)).toBeLessThanOrEqual(400);

    const wm = await sharp(out.web).metadata();
    expect(Math.max(wm.width!, wm.height!)).toBeLessThanOrEqual(1600);

    const lm = await sharp(out.large).metadata();
    expect(Math.max(lm.width!, lm.height!)).toBeLessThanOrEqual(2400);
  });

  it("does not upscale: a small source stays small", async () => {
    const input = await createSampleJpeg(300, 200);
    const out = await generateVariants(input);
    const lm = await sharp(out.large).metadata();
    expect(Math.max(lm.width!, lm.height!)).toBe(300);
  });

  it("strips EXIF from derivatives", async () => {
    const input = await createSampleJpeg(2000, 1500);
    const out = await generateVariants(input);
    const wm = await sharp(out.web).metadata();
    expect(wm.exif).toBeUndefined();
  });
});

describe("readTakenAt", () => {
  it("returns null when no EXIF date present", async () => {
    const input = await createSampleJpeg(800, 600);
    const taken = await readTakenAt(input);
    expect(taken).toBeNull();
  });
});
