-- Per-admin workspaces.
--
-- Before this migration every admin saw every album: the catalog was a
-- single shared workspace with multiple operators on it. We now scope
-- albums to their creating admin. The owner ('superuser') role keeps
-- global visibility; non-owner admins see only the albums they created.
--
--   - owner_user_id: NOT NULL, FK to admin_users. RESTRICT on delete so
--     an admin can't be dropped while they still hold albums (the owner
--     can reassign or purge them first).
--   - Existing rows: backfilled to the single 'owner' admin since the
--     legacy catalog conceptually belonged to them. New rows MUST be
--     created with an explicit owner.
--
-- Slug uniqueness changes from GLOBAL to per-owner. Two admins can now
-- both have an album slugged `summer-2026` without collision; the slug
-- only has to be unique inside their own namespace. Public share URLs
-- use random tokens so they're not affected; admin URLs are
-- `/admin/albums/{slug}` and resolve relative to the logged-in admin
-- (page route filters by viewer).

ALTER TABLE albums
  ADD COLUMN IF NOT EXISTS owner_user_id UUID
    REFERENCES admin_users(id) ON DELETE RESTRICT;

UPDATE albums
   SET owner_user_id = (SELECT id FROM admin_users WHERE role = 'owner' LIMIT 1)
 WHERE owner_user_id IS NULL;

-- If owner backfill failed (no owner row in admin_users — fresh install
-- with no users), the NOT NULL below will explode; that's intentional.
-- We never want a state where albums exist but nobody owns them.
ALTER TABLE albums
  ALTER COLUMN owner_user_id SET NOT NULL;

-- Drop the global UNIQUE on slug, replace with per-owner UNIQUE.
ALTER TABLE albums DROP CONSTRAINT IF EXISTS albums_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS albums_owner_slug_unique
  ON albums (owner_user_id, slug);

-- Hot path: list this admin's albums, sorted by recency. The
-- (owner_user_id, updated_at DESC) index covers both predicates of
-- `WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`.
CREATE INDEX IF NOT EXISTS albums_owner_updated_idx
  ON albums (owner_user_id, updated_at DESC)
  WHERE deleted_at IS NULL;
