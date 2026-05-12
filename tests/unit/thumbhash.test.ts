import { describe, it, expect } from "vitest";
import { computeThumbhash, thumbhashToDataUrl } from "@/lib/thumbhash";
import { createSampleJpeg } from "../fixtures/createSampleJpeg";

describe("thumbhash", () => {
  it("computes a small base64 string for a real image", async () => {
    const jpeg = await createSampleJpeg(800, 600);
    const hash = await computeThumbhash(jpeg);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    // ThumbHash payloads are ~20–30 bytes; base64 inflates by 4/3 plus padding.
    // Cap at 80 chars to lock in the "small enough to inline" guarantee.
    expect(hash.length).toBeLessThan(80);
  });

  it("round-trips: compute → decode produces a non-empty data URL", async () => {
    const jpeg = await createSampleJpeg(640, 480);
    const hash = await computeThumbhash(jpeg);
    const url = thumbhashToDataUrl(hash);
    expect(url).not.toBeNull();
    expect(url!.startsWith("data:image/png;base64,")).toBe(true);
    // Decoded preview should be more than a few bytes of header.
    expect(url!.length).toBeGreaterThan(200);
  });

  it("returns null on null / empty input", () => {
    expect(thumbhashToDataUrl(null)).toBeNull();
    expect(thumbhashToDataUrl(undefined)).toBeNull();
    expect(thumbhashToDataUrl("")).toBeNull();
  });

  it("returns null on malformed base64 without throwing", () => {
    expect(thumbhashToDataUrl("@@@not-base64@@@")).toBeNull();
  });
});
