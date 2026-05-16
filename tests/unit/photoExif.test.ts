import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
// readPhotoExif is imported dynamically per test so vi.doMock("exifr") can
// be set up before each module evaluation. The top-of-file static import
// would freeze the (real) exifr binding for every test.

/**
 * Build a small JPEG with no EXIF block. sharp.withMetadata's `exif` field
 * accepts the IFD shape but doesn't roundtrip through exifr in a way we can
 * rely on for assertions — it's primarily a passthrough for already-tagged
 * input. So instead we exercise readPhotoExif against:
 *   * a no-EXIF JPEG (negative path)
 *   * a mocked exifr parser (deterministic EXIF inputs)
 * The mocked path is the load-bearing one: it pins the field-mapping logic
 * (camera dedup, shutter formatter, aperture rounding) which is what we
 * actually own.
 */
async function makePlainJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).jpeg().toBuffer();
}

describe("readPhotoExif", () => {
  it("returns null when the buffer has no recoverable fields", async () => {
    const { readPhotoExif } = await import("@/lib/images");
    const buf = await makePlainJpeg();
    const exif = await readPhotoExif(buf);
    expect(exif).toBeNull();
  });

  it("returns null on parser errors (corrupt buffer)", async () => {
    const { readPhotoExif } = await import("@/lib/images");
    // Force an exifr throw with a non-image payload.
    const exif = await readPhotoExif(Buffer.from("not an image"));
    expect(exif).toBeNull();
  });
});

describe("readPhotoExif field mapping", () => {
  // Mock exifr inline so we can hand-feed the parsed EXIF blob and assert
  // the mapping logic without depending on sharp's EXIF writer.

  async function callWith(parsedExif: Record<string, unknown> | null) {
    vi.resetModules();
    vi.doMock("exifr", () => ({
      default: {
        parse: vi.fn(async () => parsedExif),
      },
    }));
    const { readPhotoExif: load } = await import("@/lib/images");
    const buf = await makePlainJpeg();
    const result = await load(buf);
    vi.doUnmock("exifr");
    return result;
  }

  it("joins Make + Model when distinct", async () => {
    const exif = await callWith({ Make: "Canon", Model: "EOS R5" });
    expect(exif?.camera).toBe("Canon EOS R5");
  });

  it("does not duplicate manufacturer when Model already includes it", async () => {
    const exif = await callWith({ Make: "Sony", Model: "Sony A7M3" });
    expect(exif?.camera).toBe("Sony A7M3");
  });

  it("falls back to Model when Make is absent", async () => {
    const exif = await callWith({ Model: "iPhone 14 Pro" });
    expect(exif?.camera).toBe("iPhone 14 Pro");
  });

  it("formats fast shutter as 1/N", async () => {
    const exif = await callWith({ ExposureTime: 1 / 200 });
    expect(exif?.shutter).toBe("1/200");
  });

  it("formats slow shutter as decimal seconds", async () => {
    const exif = await callWith({ ExposureTime: 2.5 });
    expect(exif?.shutter).toBe("2.5s");
  });

  it("rounds aperture to two decimal places", async () => {
    const exif = await callWith({ FNumber: 1.8 });
    expect(exif?.aperture).toBe(1.8);
  });

  it("propagates ISO and focal length as integers", async () => {
    const exif = await callWith({ ISO: 200, FocalLength: 35 });
    expect(exif?.iso).toBe(200);
    expect(exif?.focal_mm).toBe(35);
  });

  it("collapses placeholder LensModel into a fallback or null", async () => {
    const noisy = await callWith({ LensModel: "----", LensMake: "Sigma" });
    expect(noisy?.lens).toBe("Sigma");
    const clean = await callWith({ LensModel: "Sigma 35mm f/1.4 DG DN" });
    expect(clean?.lens).toBe("Sigma 35mm f/1.4 DG DN");
  });

  it("emits taken_at as ISO when DateTimeOriginal is set", async () => {
    const when = new Date("2026-09-12T14:23:00Z");
    const exif = await callWith({ DateTimeOriginal: when });
    expect(exif?.taken_at).toBe("2026-09-12T14:23:00.000Z");
  });

  it("returns null when every recovered field is empty", async () => {
    const exif = await callWith({});
    expect(exif).toBeNull();
  });
});
