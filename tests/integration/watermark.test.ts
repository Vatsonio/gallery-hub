import { describe, it, expect, beforeAll } from "vitest";
import sharp from "sharp";
import { generateVariants, DEFAULT_WATERMARK_TEXT } from "@/lib/images";
import { createSampleJpeg } from "../fixtures/createSampleJpeg";
import { setupTestDb } from "./_helpers";

beforeAll(async () => {
  process.env.GH_TEST_BYPASS_AUTH = "1";
  await setupTestDb();
}, 60_000);

const dockerOff = process.env.SKIP_TESTCONTAINERS === "1";

describe.skipIf(dockerOff)("watermark pipeline", () => {
  it("produces variants whose pixel content differs when watermark is applied", async () => {
    const buf = await createSampleJpeg(1600, 1066);

    const clean = await generateVariants(buf);
    const stamped = await generateVariants(buf, { text: "TEST WORDMARK" });

    // Same shape — thumb is identical (no stamp on thumbs).
    expect(stamped.thumb.length).toBeGreaterThan(0);
    // Web/large bytes differ because of the composited overlay.
    expect(stamped.web.equals(clean.web)).toBe(false);
    expect(stamped.large.equals(clean.large)).toBe(false);

    // Sampling the bottom-right corner of the stamped `web` shows a
    // non-zero deviation from the clean variant — the overlay is
    // intentionally subtle (~6% opacity) so we only assert *some*
    // pixel divergence in the watermark region rather than chasing a
    // specific value.
    const cleanRaw = await sharp(clean.web).raw().toBuffer({ resolveWithObject: true });
    const stampedRaw = await sharp(stamped.web).raw().toBuffer({ resolveWithObject: true });
    expect(cleanRaw.info.width).toBe(stampedRaw.info.width);

    // Look at the bottom-right 20% of the image.
    const { width, height, channels } = stampedRaw.info;
    const startY = Math.floor(height * 0.8);
    const startX = Math.floor(width * 0.8);
    let totalDiff = 0;
    let sampleCount = 0;
    for (let y = startY; y < height; y += 4) {
      for (let x = startX; x < width; x += 4) {
        const idx = (y * width + x) * channels;
        for (let c = 0; c < Math.min(3, channels); c++) {
          totalDiff += Math.abs(cleanRaw.data[idx + c] - stampedRaw.data[idx + c]);
          sampleCount++;
        }
      }
    }
    expect(sampleCount).toBeGreaterThan(0);
    // Any divergence at all in the corner region proves the overlay
    // was composited; absent the watermark, both buffers are identical.
    expect(totalDiff).toBeGreaterThan(0);
  }, 60_000);

  it("falls back to DEFAULT_WATERMARK_TEXT when text is empty", async () => {
    const buf = await createSampleJpeg(800, 600);
    const stamped = await generateVariants(buf, { text: "" });
    const stampedDefault = await generateVariants(buf, { text: DEFAULT_WATERMARK_TEXT });
    // Same fallback text → identical encoded bytes (deterministic encoder).
    expect(stamped.web.equals(stampedDefault.web)).toBe(true);
  }, 60_000);
});
