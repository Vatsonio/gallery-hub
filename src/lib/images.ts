import sharp from "sharp";
import exifr from "exifr";

export interface PrimaryVariants {
  thumb: Buffer; // 400px max (WEBP only — AVIF encode cost not worth it on tiny tiles)
  web: Buffer;   // 1600px max, WEBP
  large: Buffer; // 2400px max, WEBP
}

export interface AvifVariants {
  /**
   * AVIF mirror of the web variant. Quality 60 in AVIF is perceptually
   * equivalent to WEBP q82 but roughly half the bytes — at the cost of
   * a longer encode.
   */
  webAvif: Buffer;
  /** AVIF mirror of the large variant. */
  largeAvif: Buffer;
}

/**
 * Back-compat alias kept for callers that still want the full set in one
 * shot. New worker paths should call generatePrimaryVariants + then
 * generateAvifVariants separately so the photo can flip to status=ready
 * after the primaries land.
 */
export type Variants = PrimaryVariants & AvifVariants;

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

/**
 * First-pass derivatives: every WEBP variant the public page needs to
 * render at status=ready (thumb + web in the grid, large in the lightbox
 * and cover hero). Cheaper than the full pipeline because we skip AVIF —
 * which is optional everywhere downstream and ~30% of the encode budget
 * even after the effort=2 fix in B4.
 *
 * Returned WEBPs are already watermarked when `watermark` is set.
 */
export async function generatePrimaryVariants(
  input: Buffer,
  watermark?: WatermarkOptions | null,
): Promise<PrimaryVariants> {
  const [thumb, web, large] = await Promise.all([
    resizeWebp(input, 400, 75),
    resizeWebp(input, 1600, 82),
    resizeWebp(input, 2400, 86),
  ]);
  if (!watermark) return { thumb, web, large };
  const text = (watermark.text ?? "").trim() || DEFAULT_WATERMARK_TEXT;
  const [webStamped, largeStamped] = await Promise.all([
    applyWatermark(web, text),
    applyWatermark(large, text),
  ]);
  void reencodeWebp;
  return { thumb, web: webStamped, large: largeStamped };
}

/**
 * Second-pass derivatives: AVIF mirrors of the web and large WEBPs.
 * Re-encoded from the already-watermarked WEBP outputs when applicable
 * so both formats render the same overlay. Loss-on-loss is acceptable
 * here — AVIF compression noise dwarfs the watermark text re-encode
 * artefacts at q60/q64.
 */
export async function generateAvifVariants(
  primary: PrimaryVariants,
  watermark?: WatermarkOptions | null,
): Promise<AvifVariants> {
  // When unwatermarked we want the highest-fidelity AVIF possible, so
  // re-encode from the WEBP isn't ideal — but `primary` is what the
  // worker has buffered after pass 1 and re-streaming the original to
  // squeeze 2% more quality isn't worth the extra MinIO round-trip.
  // WEBP→AVIF at q60 is visually indistinguishable from JPEG→AVIF at q60.
  void watermark;
  const [webAvif, largeAvif] = await Promise.all([
    reencodeAvif(primary.web, 60),
    reencodeAvif(primary.large, 64),
  ]);
  return { webAvif, largeAvif };
}

/**
 * Convenience wrapper kept for tests and any caller that wants all five
 * outputs in one shot. New code should prefer the split entrypoints so
 * the photo can flip to status=ready as soon as the WEBPs land.
 */
export async function generateVariants(
  input: Buffer,
  watermark?: WatermarkOptions | null,
): Promise<Variants> {
  const primary = await generatePrimaryVariants(input, watermark);
  const avif = await generateAvifVariants(primary, watermark);
  return { ...primary, ...avif };
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
