import sharp from "sharp";
import exifr from "exifr";

export interface Variants {
  thumb: Buffer; // 400px max
  web: Buffer;   // 1600px max
  large: Buffer; // 2400px max
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

export async function generateVariants(input: Buffer): Promise<Variants> {
  const [thumb, web, large] = await Promise.all([
    resizeWebp(input, 400, 75),
    resizeWebp(input, 1600, 82),
    resizeWebp(input, 2400, 86),
  ]);
  return { thumb, web, large };
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
