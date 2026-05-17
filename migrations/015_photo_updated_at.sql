-- imgproxy migration prep — track the last byte-content mutation on each
-- photo so URLs can cache-bust via ?v=<unix epoch> when an admin edits.
-- Without this the imgproxy CDN cache (1y TTL) would serve stale pixels
-- after rotate/crop/brightness because the s3 key stays the same.
--
-- Strategy: ADD COLUMN with the current row's created_at as a sensible
-- default backfill (so every existing photo gets a stable, non-NULL value
-- before the trigger arms), then NOT NULL with a server-side default of
-- now(). photo-edit / photo create / derivative-worker writes update this
-- column explicitly; updateAlbum-style settings changes do not.
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- Backfill: existing rows take their created_at so the URL builder has a
-- stable seed value; the cache won't churn on first-render after deploy.
UPDATE photos
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE photos
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;
