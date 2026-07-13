CREATE TABLE IF NOT EXISTS daily_analysis_publications (
  id SERIAL PRIMARY KEY,
  analysis_date DATE NOT NULL,
  match_mode VARCHAR(20) NOT NULL DEFAULT 'prelive',
  provider VARCHAR(60) NOT NULL DEFAULT '365scores',
  cache_version VARCHAR(40) NOT NULL DEFAULT 'v1',
  status VARCHAR(20) NOT NULL DEFAULT 'generating',
  payload JSONB,
  error TEXT,
  generation_token VARCHAR(80),
  generated_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (analysis_date, match_mode, provider, cache_version)
);

CREATE INDEX IF NOT EXISTS daily_analysis_publications_lookup_idx
  ON daily_analysis_publications (analysis_date, match_mode, provider, cache_version, status);

CREATE INDEX IF NOT EXISTS daily_analysis_publications_status_idx
  ON daily_analysis_publications (status, updated_at);
