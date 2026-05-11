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
