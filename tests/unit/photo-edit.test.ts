import { describe, it, expect } from "vitest";
import {
  validatePhotoEditPayload,
  brightnessToModulate,
  PhotoEditValidationError,
} from "@/lib/photo-edit";

describe("validatePhotoEditPayload", () => {
  it("rejects non-object bodies", () => {
    expect(() => validatePhotoEditPayload(null)).toThrow(PhotoEditValidationError);
    expect(() => validatePhotoEditPayload("hi")).toThrow(PhotoEditValidationError);
    expect(() => validatePhotoEditPayload(42)).toThrow(PhotoEditValidationError);
  });

  it("rejects empty bodies (no transforms supplied)", () => {
    expect(() => validatePhotoEditPayload({})).toThrow(/at least one of/);
  });

  it("accepts a 90/180/270 rotate", () => {
    expect(validatePhotoEditPayload({ rotate: 90 }).rotate).toBe(90);
    expect(validatePhotoEditPayload({ rotate: 180 }).rotate).toBe(180);
    expect(validatePhotoEditPayload({ rotate: 270 }).rotate).toBe(270);
  });

  it("rejects bogus rotate values", () => {
    expect(() => validatePhotoEditPayload({ rotate: 45 })).toThrow(/rotate/);
    expect(() => validatePhotoEditPayload({ rotate: 360 })).toThrow(/rotate/);
    expect(() => validatePhotoEditPayload({ rotate: "90" })).toThrow(/rotate/);
  });

  it("accepts a normalized crop box", () => {
    const r = validatePhotoEditPayload({ crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } });
    expect(r.crop).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
  });

  it("rejects crops outside [0,1]", () => {
    expect(() => validatePhotoEditPayload({ crop: { x: -0.1, y: 0, w: 0.5, h: 0.5 } }))
      .toThrow(/crop.x/);
    expect(() => validatePhotoEditPayload({ crop: { x: 0, y: 1.5, w: 0.5, h: 0.5 } }))
      .toThrow(/crop.y/);
  });

  it("rejects zero-area crops", () => {
    expect(() => validatePhotoEditPayload({ crop: { x: 0, y: 0, w: 0, h: 0.5 } }))
      .toThrow(/width and height/);
  });

  it("rejects crops that extend past image bounds", () => {
    expect(() => validatePhotoEditPayload({ crop: { x: 0.6, y: 0.6, w: 0.5, h: 0.5 } }))
      .toThrow(/extends past/);
  });

  it("accepts brightness in [-100, 100]", () => {
    expect(validatePhotoEditPayload({ brightness: 0 }).brightness).toBe(0);
    expect(validatePhotoEditPayload({ brightness: -100 }).brightness).toBe(-100);
    expect(validatePhotoEditPayload({ brightness: 100 }).brightness).toBe(100);
  });

  it("rejects brightness outside the slider range", () => {
    expect(() => validatePhotoEditPayload({ brightness: -101 })).toThrow(/brightness/);
    expect(() => validatePhotoEditPayload({ brightness: 101 })).toThrow(/brightness/);
    expect(() => validatePhotoEditPayload({ brightness: Number.NaN })).toThrow(/brightness/);
    expect(() => validatePhotoEditPayload({ brightness: "10" })).toThrow(/brightness/);
  });

  it("accepts a multi-transform payload", () => {
    const r = validatePhotoEditPayload({
      rotate: 180,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      brightness: 25,
    });
    expect(r.rotate).toBe(180);
    expect(r.crop?.w).toBe(1);
    expect(r.brightness).toBe(25);
  });
});

describe("brightnessToModulate", () => {
  it("maps 0 to identity (1.0)", () => {
    expect(brightnessToModulate(0)).toBeCloseTo(1.0, 5);
  });
  it("maps +100 to 1.6", () => {
    expect(brightnessToModulate(100)).toBeCloseTo(1.6, 5);
  });
  it("maps -100 to 0.4", () => {
    expect(brightnessToModulate(-100)).toBeCloseTo(0.4, 5);
  });
  it("is symmetric around 0", () => {
    expect(brightnessToModulate(50) + brightnessToModulate(-50)).toBeCloseTo(2.0, 5);
  });
});
