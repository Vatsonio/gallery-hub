-- Per-variant byte sizes captured by the derivative worker. Used to surface
-- accurate "estimated download size" in the export modal and to attribute
-- bytes in view_events `download` rows.
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS thumb_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS web_bytes   BIGINT,
  ADD COLUMN IF NOT EXISTS large_bytes BIGINT;

CREATE INDEX IF NOT EXISTS photos_album_status_idx
  ON photos (album_id, status);
