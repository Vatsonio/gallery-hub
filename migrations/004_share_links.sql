CREATE TABLE share_links (
  token          TEXT PRIMARY KEY,
  album_id       UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  password_hash  TEXT,
  expires_at     TIMESTAMPTZ,
  allow_download BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT share_links_token_length_chk CHECK (char_length(token) = 12)
);

CREATE INDEX share_links_album_id_idx ON share_links (album_id);
