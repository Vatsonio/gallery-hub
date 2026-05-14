/**
 * Payload shape + validation for the photo-edit endpoint.
 *
 * The admin client posts a JSON body describing how the original
 * should be transformed. Rather than depending on a schema lib (zod
 * etc.) we hand-validate so the request path stays lean and the
 * unit tests don't depend on a runtime parser.
 */
export type Rotate = 90 | 180 | 270;

export interface CropBox {
  /** 0..1 normalized x of crop top-left. */
  x: number;
  /** 0..1 normalized y of crop top-left. */
  y: number;
  /** 0..1 normalized width. */
  w: number;
  /** 0..1 normalized height. */
  h: number;
}

export interface PhotoEditPayload {
  rotate?: Rotate;
  crop?: CropBox;
  /** -100..+100 brightness delta. 0 is identity. */
  brightness?: number;
}

export class PhotoEditValidationError extends Error {
  constructor(public field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "PhotoEditValidationError";
  }
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Throws PhotoEditValidationError on bad input; otherwise returns the
 * normalized payload. At least one of rotate/crop/brightness must be
 * present — an empty payload is rejected so the route doesn't waste a
 * sharp pipeline run for nothing.
 */
export function validatePhotoEditPayload(input: unknown): PhotoEditPayload {
  if (!input || typeof input !== "object") {
    throw new PhotoEditValidationError("body", "must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const out: PhotoEditPayload = {};

  if (raw.rotate !== undefined && raw.rotate !== null) {
    if (raw.rotate !== 90 && raw.rotate !== 180 && raw.rotate !== 270) {
      throw new PhotoEditValidationError("rotate", "must be 90, 180, or 270");
    }
    out.rotate = raw.rotate;
  }

  if (raw.crop !== undefined && raw.crop !== null) {
    if (!raw.crop || typeof raw.crop !== "object") {
      throw new PhotoEditValidationError("crop", "must be an object with x/y/w/h");
    }
    const c = raw.crop as Record<string, unknown>;
    for (const k of ["x", "y", "w", "h"] as const) {
      const v = c[k];
      if (!isFiniteNum(v) || v < 0 || v > 1) {
        throw new PhotoEditValidationError(`crop.${k}`, "must be a finite number in [0, 1]");
      }
    }
    const crop: CropBox = {
      x: c.x as number, y: c.y as number, w: c.w as number, h: c.h as number,
    };
    if (crop.w <= 0 || crop.h <= 0) {
      throw new PhotoEditValidationError("crop", "width and height must be > 0");
    }
    if (crop.x + crop.w > 1 + 1e-6 || crop.y + crop.h > 1 + 1e-6) {
      throw new PhotoEditValidationError("crop", "extends past image bounds");
    }
    out.crop = crop;
  }

  if (raw.brightness !== undefined && raw.brightness !== null) {
    if (!isFiniteNum(raw.brightness) || raw.brightness < -100 || raw.brightness > 100) {
      throw new PhotoEditValidationError("brightness", "must be a number in [-100, 100]");
    }
    out.brightness = raw.brightness;
  }

  if (out.rotate === undefined && out.crop === undefined && out.brightness === undefined) {
    throw new PhotoEditValidationError("body", "at least one of rotate, crop, brightness is required");
  }

  return out;
}

/**
 * Convert a brightness slider value (-100..+100) into a sharp
 * multiplicative modulator. 0 -> 1.0 (identity); +100 -> 1.6; -100 -> 0.4.
 * Linear mapping keeps the slider behaviour predictable.
 */
export function brightnessToModulate(delta: number): number {
  return 1 + (delta / 100) * 0.6;
}
