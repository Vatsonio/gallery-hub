/**
 * Server-side helpers for the ThumbHash placeholder pipeline. ThumbHash
 * compresses an image into roughly 20–30 bytes of RGBA + DCT
 * coefficients — small enough to inline as base64 in HTML and decode
 * into a blurry preview that lands instantly while the real photo
 * loads.
 *
 * `computeThumbhash` runs at derivative-generation time (sharp
 * downscales the original to ≤100×100 RGBA, then thumbhash encodes).
 * `thumbhashToDataUrl` runs at render time on the server so the
 * placeholder ships as a <data:> URL and the browser never has to
 * download the thumbhash decoder.
 */
import sharp from "sharp";
import {
  rgbaToThumbHash,
  thumbHashToDataURL,
} from "thumbhash";

const MAX_SIDE = 100;

/**
 * Compute a thumbhash for the given source image. Returns a base64
 * string so it can live in a TEXT column and round-trip through JSON
 * cleanly.
 */
export async function computeThumbhash(input: Buffer): Promise<string> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize({
      width: MAX_SIDE,
      height: MAX_SIDE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hash = rgbaToThumbHash(info.width, info.height, data);
  return Buffer.from(hash).toString("base64");
}

/**
 * Decode a base64-encoded thumbhash to a PNG data URL. Safe to call on
 * the server; returns null on malformed input so callers can fall back
 * to a plain placeholder.
 */
export function thumbhashToDataUrl(hashBase64: string | null | undefined): string | null {
  if (!hashBase64) return null;
  try {
    const bytes = Buffer.from(hashBase64, "base64");
    if (bytes.length === 0) return null;
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}
