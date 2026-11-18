-- Per-IP rate-limit events (ticket issues and score submission attempts, accepted or not).
-- Checked and inserted atomically by the Worker; rows older than an hour are pruned.
CREATE TABLE IF NOT EXISTS rate_events (
  kind       TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events (kind, ip_hash, created_at);
