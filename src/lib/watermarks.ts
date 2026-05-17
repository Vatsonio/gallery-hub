/**
 * Watermark PNG storage helpers.
 *
 * In the imgproxy era, watermark composition happens lazily at request
 * time — imgproxy's `watermark` + `wm_url` processing steps composite a
 * small transparent PNG onto every resized variant. The PNG itself is
 * generated once per album by `ensureWatermarkPng()` (composeWatermarkPng
 * from src/lib/images.ts → s3 PutObject) and stored under a deterministic
 * key here so the URL builder can reference it without an extra round-trip.
 */
import sharp from "sharp";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client, BUCKET } from "@/lib/minio";
import { DEFAULT_WATERMARK_TEXT } from "@/lib/images";

/** Object key for the per-album watermark PNG. */
export function watermarkKey(albumId: string): string {
  return `watermarks/${albumId}.png`;
}

/**
 * Render an SVG wordmark to a transparent 1024-wide PNG so imgproxy can
 * composite it. The PNG is rasterized once per album-text combination and
 * cached in MinIO under watermarks/{albumId}.png; subsequent renders
 * skip the re-encode because HeadObject returns 200.
 *
 * Width=1024 is large enough that imgproxy's `wm_scale:0.25` (25% of the
 * canvas longest edge) still anti-aliases cleanly even on 2400×... large
 * variants without bloating the PNG. The PNG itself is ~6 KB compressed.
 */
const WIDTH = 1024;
const HEIGHT = 256;

function watermarkSvg(text: string): Buffer {
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">
    <text x="${WIDTH - 20}" y="${HEIGHT - 32}"
          font-family="ui-sans-serif, system-ui, sans-serif"
          font-size="56" font-weight="500"
          fill="white" fill-opacity="0.9"
          text-anchor="end">${safe}</text>
  </svg>`;
  return Buffer.from(svg);
}

export async function composeWatermarkPng(text: string): Promise<Buffer> {
  // Empty / whitespace text falls back to the default wordmark so toggling
  // on a fresh album without populating watermark_text doesn't ship a
  // blank PNG.
  const wordmark = text.trim() || DEFAULT_WATERMARK_TEXT;
  return sharp(watermarkSvg(wordmark), { density: 192 }).png().toBuffer();
}

/**
 * Ensure the album's watermark PNG exists in MinIO; render + upload if
 * missing. Returns the storage key so callers can pass it straight to
 * buildImgproxyUrl's watermark option.
 */
export async function ensureWatermarkPng(albumId: string, text: string): Promise<string> {
  const key = watermarkKey(albumId);
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return key;
  } catch {
    const png = await composeWatermarkPng(text);
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: png,
        ContentType: "image/png",
      }),
    );
    return key;
  }
}

/**
 * Refresh the watermark PNG unconditionally — invoked when an admin
 * mutates `watermark_text`. Bumps the bytes in place so existing imgproxy
 * cache entries that reference watermarks/{albumId}.png will revalidate
 * via ETag; new URLs will start hitting the new content immediately.
 */
export async function rewriteWatermarkPng(albumId: string, text: string): Promise<string> {
  const key = watermarkKey(albumId);
  const png = await composeWatermarkPng(text);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: png,
      ContentType: "image/png",
    }),
  );
  return key;
}
