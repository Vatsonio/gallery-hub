-- Per-album watermark toggle. When enabled, the derivative worker stamps
-- the photographer wordmark onto the `web` and `large` WEBP/AVIF variants
-- (originals stay clean for unwatermarked exports). Default OFF — the
-- feature is opt-in per album so existing albums are unaffected.
ALTER TABLE albums
  ADD COLUMN IF NOT EXISTS watermark_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS watermark_text    TEXT;
