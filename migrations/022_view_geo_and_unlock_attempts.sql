-- Per-view client IP + country, and a password-attempt log, so the
-- /admin/metrics "Top albums" drill-down can show exactly which IPs viewed
-- an album, from where, and whether they entered the album password.
--
-- IP + country are captured at view time (country from Cloudflare's
-- cf-ipcountry header). City/region is resolved on demand from a GeoIP DB
-- at query time (see src/lib/geoip.ts) and is NOT stored. These columns are
-- populated only for views recorded AFTER this migration deploys; historical
-- rows stay NULL.
--
-- NOTE: capturing the real client IP requires TRUST_PROXY_HEADERS=1 (the app
-- is behind Cloudflare Tunnel, which sends cf-connecting-ip / cf-ipcountry).
-- Without it the resolver records the IP as NULL.

ALTER TABLE view_events
  ADD COLUMN IF NOT EXISTS ip      TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT;

CREATE INDEX IF NOT EXISTS view_events_ip_idx
  ON view_events (ip) WHERE ip IS NOT NULL;

-- Password-gate attempts (both success and failure) so the drill-down can
-- distinguish IPs that entered the password from IPs that tried and failed.
CREATE TABLE IF NOT EXISTS share_unlock_attempts (
  id           BIGSERIAL PRIMARY KEY,
  share_token  TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  viewer_id    TEXT,
  ip           TEXT,
  country      TEXT,
  success      BOOLEAN NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS share_unlock_attempts_token_idx
  ON share_unlock_attempts (share_token, created_at);
