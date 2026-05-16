-- imgproxy migration: tag the variant-bytes columns as legacy so future
-- readers (and a possible rollback to pre-generated variants) understand
-- they were part of a now-retired pipeline.
--
-- We do NOT drop the columns. Two reasons:
--   1. Rollback safety. If imgproxy gets pulled, the original derivative
--      pipeline can be reinstated and these byte sizes are again valid
--      truth-of-record.
--   2. Historical data. The `download` view_events rows reference these
--      sizes when attributing bytes per export — preserving the numbers
--      keeps /chikaq's analytics readable.
--
-- New columns introduced for the imgproxy era live in 015_photo_updated_at.sql
-- (the URL builder's cache-bust seed). They are NOT covered by this comment
-- block.

COMMENT ON COLUMN photos.thumb_bytes      IS 'LEGACY (pre-imgproxy): byte size of the worker-baked thumb.webp variant. Variants are now resized on-demand by imgproxy; this column is no longer updated.';
COMMENT ON COLUMN photos.web_bytes        IS 'LEGACY (pre-imgproxy): byte size of the worker-baked web.webp variant.';
COMMENT ON COLUMN photos.large_bytes      IS 'LEGACY (pre-imgproxy): byte size of the worker-baked large.webp variant.';
COMMENT ON COLUMN photos.avif_bytes_web   IS 'LEGACY (pre-imgproxy): byte size of the worker-baked web.avif mirror.';
COMMENT ON COLUMN photos.avif_bytes_large IS 'LEGACY (pre-imgproxy): byte size of the worker-baked large.avif mirror.';
