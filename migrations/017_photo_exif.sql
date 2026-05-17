-- Add a JSONB column to capture richer EXIF metadata at upload time.
-- Existing photos keep NULL — the StatsStrip and Lightbox treat NULL
-- as "EXIF unavailable" rather than backfilling.
--
-- Shape (informational — no constraint):
--   {
--     "camera":   "Sony A7M3",      -- "Make Model" joined by readPhotoExif
--     "lens":     "Sigma 35mm f/1.4",
--     "iso":      200,
--     "aperture": 1.8,              -- f-number
--     "shutter":  "1/200",          -- pre-formatted fraction string
--     "focal_mm": 35,
--     "taken_at": "2026-09-12T14:23:00Z"  -- duplicate of photos.taken_at for query convenience
--   }
--
-- We also index the (album_id, exif->>'camera') path so the album-stats
-- aggregator can compute the top camera without a sequential scan on
-- large libraries.

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS exif JSONB;

CREATE INDEX IF NOT EXISTS photos_album_camera_idx
  ON photos (album_id, (exif->>'camera'))
  WHERE exif IS NOT NULL;
