-- AVIF derivative byte sizes for the web/large variants. Thumb stays
-- WEBP-only since AVIF encoding is slow and the WEBP thumb is already
-- ~3KB so the savings don't justify the worker cost.
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS avif_bytes_web   BIGINT,
  ADD COLUMN IF NOT EXISTS avif_bytes_large BIGINT;
