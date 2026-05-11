export type Variant = "thumb" | "web" | "large";

export function originalKey(albumId: string, photoId: string, ext: string): string {
  return `albums/${albumId}/${photoId}/original.${ext}`;
}

export function variantKey(albumId: string, photoId: string, variant: Variant): string {
  return `albums/${albumId}/${photoId}/${variant}.webp`;
}

const EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function extFromContentType(ct: string): string {
  const ext = EXT_MAP[ct.toLowerCase()];
  if (!ext) throw new Error(`unsupported content-type: ${ct}`);
  return ext;
}
