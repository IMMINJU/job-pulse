-- Raw layer: 개별 공고 원본 보존
CREATE TABLE IF NOT EXISTS job_postings_raw (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL,
  posted_at     TIMESTAMPTZ,
  title         TEXT NOT NULL,
  company       TEXT,
  location      TEXT,
  remote        BOOLEAN,
  tags          TEXT[],
  segment       TEXT,
  raw_json      JSONB NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS job_postings_raw_source_fetched_idx
  ON job_postings_raw (source, fetched_at);
CREATE INDEX IF NOT EXISTS job_postings_raw_tags_idx
  ON job_postings_raw USING GIN (tags);
CREATE INDEX IF NOT EXISTS job_postings_raw_segment_idx
  ON job_postings_raw (segment);

-- Aggregated layer
CREATE TABLE IF NOT EXISTS job_snapshots (
  date          DATE NOT NULL,
  source        TEXT NOT NULL,
  segment       TEXT NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (date, source, segment)
);

-- Tag tracking
CREATE TABLE IF NOT EXISTS tag_history (
  tag           TEXT PRIMARY KEY,
  first_seen    DATE NOT NULL,
  last_seen     DATE NOT NULL,
  total_count   INTEGER NOT NULL
);

-- Report run history
CREATE TABLE IF NOT EXISTS report_runs (
  id            BIGSERIAL PRIMARY KEY,
  week_start    DATE NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent          BOOLEAN NOT NULL DEFAULT false,
  payload       JSONB NOT NULL,
  insight_cost  NUMERIC(10, 6),
  UNIQUE (week_start)
);
