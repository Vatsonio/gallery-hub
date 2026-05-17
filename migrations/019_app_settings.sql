-- Key-value settings store for owner-managed system configuration.
-- Keys are stable strings; values are JSONB so different settings can hold
-- different shapes (a bool toggle, a {bytes,enabled} threshold object, a
-- tuple of share-link defaults, etc.) without one migration per option.

CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL
);

COMMENT ON TABLE app_settings IS
  'Owner-managed key/value settings. Reads cached in-process (5min TTL); '
  'writes are infrequent so the cache is invalidated lazily by version.';
