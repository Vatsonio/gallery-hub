// src/lib/types.ts
export type PhotoStatus = "uploading" | "processing" | "ready";
export type AlbumStatus = "draft" | "published" | "archived";

export interface PresignRequestFile {
  filename: string;
  size: number;
  contentType: string;
}
export interface PresignRequestBody {
  album_id: string;
  files: PresignRequestFile[];
}
export interface PresignResponseItem {
  photo_id: string;
  put_url: string;
  key: string;
}
export interface PresignResponse {
  items: PresignResponseItem[];
}

export interface FinalizePhoto {
  photo_id: string;
  filename: string;
  width: number;
  height: number;
  size: number;
}
export interface FinalizeRequestBody {
  album_id: string;
  photos: FinalizePhoto[];
}
export interface FinalizeResponse {
  inserted: number;
}

export interface PhotoRow {
  id: string;
  album_id: string;
  filename: string;
  width: number;
  height: number;
  orig_bytes: number;
  sort_order: number;
  taken_at: string | null;
  status: PhotoStatus;
  created_at: string;
  /**
   * Last byte-content mutation. Bumped on photo create (worker derivatives
   * pass) and on photo-edit (rotate/crop/brightness). Used as the `version`
   * input to buildImgproxyUrl so the imgproxy cache invalidates without a
   * manual PURGE when an admin edits a photo. See migrations/015.
   */
  updated_at: string;
  /** Base64-encoded ThumbHash placeholder, null until the worker fills it in. */
  thumbhash?: string | null;
  /** Byte size of the AVIF mirror of the web variant; null when absent. */
  avif_bytes_web?: number | null;
  /** Byte size of the AVIF mirror of the large variant; null when absent. */
  avif_bytes_large?: number | null;
  /** JSONB-packed EXIF metadata captured at upload (see PhotoExif). */
  exif?: PhotoExif | null;
}

/**
 * Subset of EXIF metadata persisted onto each photo. Filled by
 * `readPhotoExif` during upload finalize; older photos may have NULL.
 *
 * All fields are nullable individually — a phone-camera JPEG may have
 * camera but no lens, or shutter but no focal length. The lightbox
 * displays only the fields that are present.
 */
export interface PhotoExif {
  camera?: string | null;
  lens?: string | null;
  iso?: number | null;
  /** F-number (e.g. 1.8). */
  aperture?: number | null;
  /** Pre-formatted shutter fraction (e.g. "1/200"). */
  shutter?: string | null;
  /** Focal length in millimetres. */
  focal_mm?: number | null;
  /** ISO timestamp of capture — duplicates photos.taken_at for the lightbox panel. */
  taken_at?: string | null;
}

export interface AlbumRow {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  cover_photo_id: string | null;
  status: AlbumStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** When true, `web` + `large` variants are stamped on derivative generation. */
  watermark_enabled?: boolean;
  /** Wordmark text rendered onto the watermarked variants. Falls back to a default. */
  watermark_text?: string | null;
}

export interface AlbumWithStats extends AlbumRow {
  photo_count: number;
  cover_thumb_url: string | null;
}

export interface GenerateDerivativesJobData {
  album_id: string;
  photo_id: string;
  key: string; // original key
}
