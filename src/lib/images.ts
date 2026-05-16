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

export const DEFAULT_WATERMARK_TEXT = "(c) gallery.divass.space";

export interface WatermarkOptions {
  /** Wordmark to stamp; falls back to DEFAULT_WATERMARK_TEXT when blank. */
  text?: string | null;
}

/**
 * Build an SVG overlay sized to the longest edge of the rendered variant.
 * Anchored bottom-right with a small inset; semi-transparent white at ~6%
 * opacity (subtle, just enough to dissuade casual screenshot-and-claim).
 */
function watermarkSvg(width: number, height: number, text: string): Buffer {
  const longEdge = Math.max(width, height);
  const fontSize = Math.max(12, Math.round(longEdge * 0.03));
  const inset = Math.round(longEdge * 0.02);
  // Escape XML-significant chars to keep the SVG well-formed.
  const safe = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <text x="${width - inset}" y="${height - inset}"
          font-family="ui-sans-serif, system-ui, sans-serif"
          font-size="${fontSize}" font-weight="500"
          fill="white" fill-opacity="0.06"
          text-anchor="end">${safe}</text>
  </svg>`;
  return Buffer.from(svg);
}

async function applyWatermark(buffer: Buffer, text: string): Promise<Buffer> {
  const meta = await sharp(buffer).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w === 0 || h === 0) return buffer;
  return sharp(buffer)
    .composite([{ input: watermarkSvg(w, h, text), top: 0, left: 0 }])
    .toBuffer();
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

/**
 * AVIF encode effort. Bench numbers on a 4000×3000 noisy JPEG, downscaled
 * to 1600 (web) and 2400 (large), single sharp.concurrency:
 *
 *   effort: 4  →  web 7.06 s / 270 kB,  large 11.37 s / 886 kB
 *   effort: 2  →  web 0.78 s / 267 kB,  large  1.34 s / 886 kB
 *
 * 9× faster at effort=2 with essentially identical output size (<2%
 * delta). The historical comment in this file claimed effort=4 was a
 * "5× cost" trade-off vs effort=9 — that's roughly right for the high
 * end of the curve, but at the low end the cost ratio is ~10× per step.
 * Capping at effort=2 is the largest single per-photo win in this pass.
 */
const AVIF_EFFORT = 2;

async function resizeAvif(input: Buffer, maxSide: number, quality: number): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({
      width: maxSide,
      height: maxSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    .avif({ quality, effort: AVIF_EFFORT })
    .toBuffer();
}

async function reencodeWebp(input: Buffer, quality: number): Promise<Buffer> {
  return sharp(input).webp({ quality }).toBuffer();
}

async function reencodeAvif(input: Buffer, quality: number): Promise<Buffer> {
  return sharp(input).avif({ quality, effort: AVIF_EFFORT }).toBuffer();
}

export async function generateVariants(
  input: Buffer,
  watermark?: WatermarkOptions | null,
): Promise<Variants> {
  const [thumb, web, large, webAvif, largeAvif] = await Promise.all([
    resizeWebp(input, 400, 75),
    resizeWebp(input, 1600, 82),
    resizeWebp(input, 2400, 86),
    resizeAvif(input, 1600, 60),
    resizeAvif(input, 2400, 64),
  ]);
  if (!watermark) {
    return { thumb, web, large, webAvif, largeAvif };
  }
  // Watermark only the `web` and `large` variants (and their AVIF mirrors).
  // Thumbs are too small for legible text, and originals stay untouched.
  const text = (watermark.text ?? "").trim() || DEFAULT_WATERMARK_TEXT;
  const webStamped = await applyWatermark(web, text);
  const largeStamped = await applyWatermark(large, text);
  // Re-encode the AVIF mirrors from the stamped WEBPs so both formats show
  // the same overlay. AVIF re-encode from WEBP is loss-on-loss but the
  // overlay is the user-visible signal we care about, not pixel fidelity.
  const [webAvifStamped, largeAvifStamped] = await Promise.all([
    reencodeAvif(webStamped, 60),
    reencodeAvif(largeStamped, 64),
  ]);
  // Silence unused warnings; we keep reencodeWebp for future callers.
  void reencodeWebp;
  return {
    thumb,
    web: webStamped,
    large: largeStamped,
    webAvif: webAvifStamped,
    largeAvif: largeAvifStamped,
  };
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
