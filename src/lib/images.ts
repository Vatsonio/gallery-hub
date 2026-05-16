// LEGACY: this module used to be the heart of the pre-imgproxy derivative
// pipeline — `generateVariants` baked WEBP thumb/web/large + AVIF web/large
// on every upload. Since the imgproxy migration the worker is metadata-only
// and these helpers are unreferenced on the hot path. We keep them here for:
//   * One-shot regeneration scripts (scripts/backfill-*.ts).
//   * Watermark PNG composition (applyWatermark → upload to
//     watermarks/{albumId}.png so imgproxy can composite it on demand).
//   * Possible rollback if imgproxy goes down and we need to fall back to
//     pre-baked variants.
// readTakenAt is still on the hot path (workers/generateDerivatives.ts) and
// genuinely belongs here — it's an EXIF parser, not a sharp pipeline.
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

import type { PhotoExif } from "@/lib/types";

/**
 * Format a shutter time in seconds as a fraction string (e.g. "1/200")
 * for displays. Speeds slower than 0.5s are rendered as the decimal
 * value with a quote suffix ("2.5s"). Returns null for non-finite input.
 */
function formatShutter(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds >= 0.5) return `${seconds.toFixed(1)}s`;
  // Pick the cleanest denominator: shutter speeds are conventionally
  // labelled as "1/N" where N is the integer nearest to 1/seconds.
  const denom = Math.round(1 / seconds);
  return `1/${denom}`;
}

/**
 * Extract the rich EXIF subset the lightbox panel + album stats need.
 * Returns null when no useful fields could be recovered — the photo
 * row's `exif` column stays NULL in that case, which the UI treats as
 * "EXIF unavailable".
 *
 * Field choices:
 *   * Camera body is joined "Make Model" with the make stripped from
 *     the model when redundant (Canon, Nikon and Sony all duplicate the
 *     manufacturer in the Model tag).
 *   * Lens prefers LensModel, falling back to LensMake when LensModel
 *     looks like a placeholder ("----" or empty).
 *   * Aperture (`FNumber`) is captured as a float so the lightbox can
 *     render "f/1.8" with one decimal place.
 *   * Shutter is pre-formatted into a "1/N" or "Ns" string so the UI
 *     doesn't have to know the convention.
 *   * Focal length captures the actual `FocalLength` in millimetres,
 *     not the 35mm-equivalent (the field photographers care about is
 *     the lens marking).
 *   * taken_at duplicates photos.taken_at into the JSONB blob so the
 *     panel can render a "Taken at" line without an extra column read.
 */
export async function readPhotoExif(input: Buffer): Promise<PhotoExif | null> {
  let meta: Record<string, unknown> | null = null;
  try {
    meta = (await exifr.parse(input, {
      pick: [
        "Make", "Model", "LensModel", "LensMake",
        "ISO", "FNumber", "ExposureTime",
        "FocalLength", "DateTimeOriginal", "CreateDate",
      ],
    })) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!meta) return null;

  const make = typeof meta.Make === "string" ? meta.Make.trim() : null;
  const model = typeof meta.Model === "string" ? meta.Model.trim() : null;
  let camera: string | null = null;
  if (model && make && !model.toLowerCase().startsWith(make.toLowerCase())) {
    camera = `${make} ${model}`;
  } else if (model) {
    camera = model;
  } else if (make) {
    camera = make;
  }

  const lensModel = typeof meta.LensModel === "string" ? meta.LensModel.trim() : "";
  const lensMake = typeof meta.LensMake === "string" ? meta.LensMake.trim() : "";
  let lens: string | null = null;
  if (lensModel && lensModel !== "----" && lensModel.length > 0) {
    lens = lensModel;
  } else if (lensMake) {
    lens = lensMake;
  }

  const iso = typeof meta.ISO === "number" && Number.isFinite(meta.ISO) ? Math.round(meta.ISO) : null;
  const aperture = typeof meta.FNumber === "number" && Number.isFinite(meta.FNumber)
    ? Math.round(meta.FNumber * 100) / 100
    : null;
  const shutter = formatShutter(typeof meta.ExposureTime === "number" ? meta.ExposureTime : null);
  const focal = typeof meta.FocalLength === "number" && Number.isFinite(meta.FocalLength)
    ? Math.round(meta.FocalLength)
    : null;
  const takenAtRaw = meta.DateTimeOriginal ?? meta.CreateDate;
  const takenAt = takenAtRaw instanceof Date && !isNaN(takenAtRaw.getTime())
    ? takenAtRaw.toISOString()
    : null;

  // If we recovered nothing useful, bail. This is a cleaner empty state
  // than a JSONB row with every field null.
  if (!camera && !lens && iso === null && aperture === null && !shutter && focal === null && !takenAt) {
    return null;
  }

  return {
    camera,
    lens,
    iso,
    aperture,
    shutter,
    focal_mm: focal,
    taken_at: takenAt,
  };
}
