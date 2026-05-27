CREATE TABLE IF NOT EXISTS candidates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  posted_at    TEXT,
  fetched_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  tjm          INTEGER,
  lowball      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);

CREATE TABLE IF NOT EXISTS source_state (
  source        TEXT PRIMARY KEY,
  etag          TEXT,
  last_modified TEXT,
  cursor        TEXT,
  last_run_at   TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tick        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT
);
