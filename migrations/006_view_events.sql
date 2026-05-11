CREATE TYPE view_event_type AS ENUM (
  'page_view',
  'photo_view',
  'download',
  'favorite_add',
  'favorite_remove'
);

CREATE TABLE view_events (
  id          BIGSERIAL PRIMARY KEY,
  share_token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  viewer_id   TEXT NOT NULL,
  event_type  view_event_type NOT NULL,
  photo_id    UUID REFERENCES photos(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX view_events_share_token_idx ON view_events (share_token, created_at);
