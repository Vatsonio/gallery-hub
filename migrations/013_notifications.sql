-- Telegram-based real-time notifications. Two tables:
--
--  1. notification_log — the durable queue: every dispatchNotification() call
--     writes a row, the pg-boss worker picks it up, hits Telegram, and
--     updates `status`. Duplicate dispatches collapse via the
--     (event_type, dedup_key, chat_id) unique constraint so callers can fire
--     idempotently from the hot path without an extra round-trip.
--
--  2. notification_rules — per-event-type config: enabled toggle, threshold
--     (e.g. "only notify after 3 likes within 1h"), and min_interval_seconds
--     (a per-chat throttle the dispatcher honours alongside the dedup key).
--     Seeded with sensible defaults so a fresh install has rules in place;
--     admin UI lets the photographer tune them later.

CREATE TABLE IF NOT EXISTS notification_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT NOT NULL,
  dedup_key    TEXT NOT NULL,
  payload      JSONB NOT NULL,
  chat_id      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued','sent','failed','skipped')),
  attempts     INT  NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ
);

-- Prevents two dispatchNotification() calls with the same dedup_key from
-- producing two Telegram messages. Callers compute dedup_key from a time
-- bucket (e.g. `${share_token}:${viewer_id}:${hour_bucket}`) so the same
-- key naturally rotates as the bucket advances.
CREATE UNIQUE INDEX IF NOT EXISTS notification_log_dedup_unique
  ON notification_log (event_type, dedup_key, chat_id);

CREATE INDEX IF NOT EXISTS notification_log_status_created
  ON notification_log (status, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_rules (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type           TEXT UNIQUE NOT NULL,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  threshold            JSONB,
  min_interval_seconds INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed defaults. The `threshold` JSON encodes per-rule logic:
--   - favorites_burst:    {min_count: 3, window_seconds: 3600}
--   - suspicious_ip:      {min_tokens: 5, window_seconds: 3600}
-- Other event types use threshold=null (always notify when enabled).
INSERT INTO notification_rules (event_type, enabled, threshold, min_interval_seconds)
VALUES
  ('first_share_view',  TRUE, NULL, 0),
  ('favorites_burst',   TRUE, '{"min_count": 3, "window_seconds": 3600}'::jsonb, 0),
  ('export_started',    TRUE, NULL, 60),
  ('export_completed',  TRUE, NULL, 60),
  ('new_upload',        TRUE, NULL, 0),
  ('suspicious_ip',     TRUE, '{"min_tokens": 5, "window_seconds": 3600}'::jsonb, 600)
ON CONFLICT (event_type) DO NOTHING;
