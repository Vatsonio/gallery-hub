-- ThumbHash placeholder — base64-encoded ~20-byte blob the worker computes
-- from a 100x100 downscale of the original. The public gallery decodes it
-- to a PNG data URL server-side so the browser paints a blurry preview
-- instantly while the real WEBP/AVIF arrives.
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS thumbhash TEXT;
