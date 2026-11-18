-- Every score submission attempt (accepted or not), for per-IP rate limiting
-- before the CPU-heavy replay runs. Rows older than an hour are pruned by the Worker.
CREATE TABLE IF NOT EXISTS submit_attempts (
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_ip ON submit_attempts (ip_hash, created_at);
