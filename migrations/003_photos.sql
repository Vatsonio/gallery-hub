CREATE TYPE photo_status AS ENUM ('uploading', 'processing', 'ready');

CREATE TABLE photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id    UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  orig_bytes  BIGINT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  taken_at    TIMESTAMPTZ,
  status      photo_status NOT NULL DEFAULT 'uploading',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX photos_album_id_idx ON photos (album_id, sort_order);

ALTER TABLE albums
  ADD CONSTRAINT albums_cover_photo_id_fkey
  FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;
