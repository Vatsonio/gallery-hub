ALTER TABLE albums ADD COLUMN deleted_at TIMESTAMPTZ;
CREATE INDEX albums_deleted_at_idx ON albums (deleted_at) WHERE deleted_at IS NOT NULL;
