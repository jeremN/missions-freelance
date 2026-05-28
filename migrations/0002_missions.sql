CREATE TABLE IF NOT EXISTS missions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    INTEGER NOT NULL UNIQUE REFERENCES candidates(id),
  source          TEXT NOT NULL,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL,
  is_real_mission INTEGER NOT NULL,
  rate_eur_day    INTEGER,
  duration        TEXT,
  remote          TEXT,
  location        TEXT,
  skills          TEXT,                 -- JSON array
  client_type     TEXT,
  score           INTEGER NOT NULL,
  reason          TEXT,
  raw_response    TEXT,                 -- the LLM tool-call args, for debugging
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  notified        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_missions_score ON missions(score);
CREATE INDEX IF NOT EXISTS idx_missions_notified ON missions(notified, score);
