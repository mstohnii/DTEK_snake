-- One row per verified run. run_id comes from the signed ticket, so a ticket can be used once.
CREATE TABLE IF NOT EXISTS scores (
  run_id     TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  score      INTEGER NOT NULL,
  ticks      INTEGER NOT NULL,
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scores_board ON scores (difficulty, score DESC, ticks ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_scores_ip ON scores (ip_hash, created_at);
