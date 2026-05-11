import sharp from "sharp";

export async function createSampleJpeg(width = 2000, height = 1500): Promise<Buffer> {
  // Generate a gradient JPEG with EXIF DateTimeOriginal for tests.
  const raw = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 40, g: 60, b: 90 },
    },
  })
    .jpeg({ quality: 80 })
    .withMetadata({
      exif: {
        IFD0: { Software: "gallery-hub-test" },
      },
    })
    .toBuffer();
  return raw;
}
