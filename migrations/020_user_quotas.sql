-- Per-user upload quotas.
--
-- Each admin (operator who can sign in) gets two optional caps:
--
--   - quota_total_bytes  — total bytes they can upload across all albums.
--   - quota_album_bytes  — bytes they can upload within any single album.
--
-- NULL means "fall back to settings.uploads.default_user_quota_*_gb".
-- The fallback value of 0 in app_settings means "unlimited", so a stack
-- with no settings tweak and no per-user override still works like before.
--
-- Photos gain a created_by_user_id pointer so the presign route can sum
-- only this user's previously-uploaded bytes when enforcing the cap.
-- Existing rows pre-date the column and stay NULL — they're counted
-- against nobody, which matches the "no enforcement for prior data"
-- expectation for the rollout.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS quota_total_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS quota_album_bytes BIGINT;

ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID
    REFERENCES admin_users(id) ON DELETE SET NULL;

-- Partial index — only ever queried with WHERE created_by_user_id IS NOT NULL
-- (the quota sums). Keeps the index small and excludes historic rows that
-- can't contribute to a per-user total.
CREATE INDEX IF NOT EXISTS photos_created_by_user_id_idx
  ON photos (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
