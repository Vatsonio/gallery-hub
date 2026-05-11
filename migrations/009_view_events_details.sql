-- JSONB blob for event-type-specific metadata. The export route writes
-- `{ scope, variant, bytes }` here so the analytics view can surface
-- per-export sizes without a separate table.
ALTER TABLE view_events ADD COLUMN IF NOT EXISTS details JSONB;
