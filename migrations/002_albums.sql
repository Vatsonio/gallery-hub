CREATE TYPE album_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE albums (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  subtitle       TEXT,
  cover_photo_id UUID,
  status         album_status NOT NULL DEFAULT 'draft',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX albums_status_idx ON albums (status);
