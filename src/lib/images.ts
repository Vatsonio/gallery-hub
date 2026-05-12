import sharp from "sharp";
import exifr from "exifr";

export interface Variants {
  thumb: Buffer; // 400px max (WEBP only — AVIF encode cost not worth it on tiny tiles)
  web: Buffer;   // 1600px max, WEBP
  large: Buffer; // 2400px max, WEBP
  /**
   * AVIF mirror of the web variant. Quality 60 in AVIF is perceptually
   * equivalent to WEBP q82 but roughly half the bytes — at the cost of
   * a ~2× longer encode.
   */
  webAvif: Buffer;
  /** AVIF mirror of the large variant. */
  largeAvif: Buffer;
}

async function resizeWebp(input: Buffer, maxSide: number, quality: number): Promise<Buffer> {
  return sharp(input)
    .rotate() // honor EXIF orientation before stripping
    .resize({
      width: maxSide,
      height: maxSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality })
    .toBuffer();
}

async function resizeAvif(input: Buffer, maxSide: number, quality: number): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({
      width: maxSide,
      height: maxSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    // effort: 4 keeps encode time tolerable; default (4) and 9 differ by
    // <5% size at a >5× wall-clock cost.
    .avif({ quality, effort: 4 })
    .toBuffer();
}

export async function generateVariants(input: Buffer): Promise<Variants> {
  const [thumb, web, large, webAvif, largeAvif] = await Promise.all([
    resizeWebp(input, 400, 75),
    resizeWebp(input, 1600, 82),
    resizeWebp(input, 2400, 86),
    resizeAvif(input, 1600, 60),
    resizeAvif(input, 2400, 64),
  ]);
  return { thumb, web, large, webAvif, largeAvif };
}

export async function readTakenAt(input: Buffer): Promise<Date | null> {
  try {
    const meta = await exifr.parse(input, { pick: ["DateTimeOriginal", "CreateDate"] });
    const d = meta?.DateTimeOriginal ?? meta?.CreateDate;
    if (d instanceof Date && !isNaN(d.getTime())) return d;
    return null;
  } catch {
    return null;
  }
}
