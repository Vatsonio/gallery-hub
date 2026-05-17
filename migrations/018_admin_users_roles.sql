-- Multi-user admin: extend admin_users with role, name, lifecycle columns.
-- Role enum lives at the application layer for migration simplicity; valid
-- values are 'owner' or 'admin'. Exactly one row gets 'owner' — the rest
-- ('admin') are created by the owner through /admin/users.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'
    CHECK (role IN ('owner', 'admin')),
  ADD COLUMN IF NOT EXISTS name TEXT,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- Backfill: the earliest-created admin becomes the owner. If admin_users is
-- empty (fresh install) this is a no-op; the bootstrap script (seed-admin.ts)
-- can create the first owner explicitly.
WITH first_admin AS (
  SELECT id FROM admin_users ORDER BY created_at ASC, id ASC LIMIT 1
)
UPDATE admin_users
   SET role = 'owner'
  FROM first_admin
 WHERE admin_users.id = first_admin.id;

-- Enforce single-owner invariant.
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_one_owner_idx
  ON admin_users ((role = 'owner'))
  WHERE role = 'owner';

-- Common lookup: who's currently disabled? Partial index keeps it small.
CREATE INDEX IF NOT EXISTS admin_users_active_idx
  ON admin_users (created_at)
  WHERE disabled_at IS NULL;
