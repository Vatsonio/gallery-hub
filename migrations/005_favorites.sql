CREATE TABLE favorites (
  share_token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
  photo_id    UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  viewer_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (share_token, photo_id, viewer_id)
);

CREATE INDEX favorites_photo_id_idx ON favorites (photo_id);
