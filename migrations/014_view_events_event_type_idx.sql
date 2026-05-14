-- /chikaq dashboard aggregators (loadViewsTrend30d, loadTopAlbums30d,
-- loadRecentActivity24h in src/lib/widgetQuery.ts) filter view_events on
-- (event_type = $X AND created_at > now() - $interval) without a share_token
-- predicate. The existing index on (share_token, created_at) is no help, so
-- the planner falls back to a seq scan that degrades past ~1M rows. Adding a
-- dedicated index on (event_type, created_at DESC) gives those queries a
-- fast path while costing little in write throughput.

CREATE INDEX IF NOT EXISTS view_events_event_type_created_at_idx
  ON view_events (event_type, created_at DESC);
