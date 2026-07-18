CREATE TABLE IF NOT EXISTS analysis_predictions (
  id BIGSERIAL PRIMARY KEY,
  publication_date DATE NOT NULL,
  match_mode VARCHAR(20) NOT NULL DEFAULT 'prelive',
  provider VARCHAR(60) NOT NULL,
  cache_version VARCHAR(40) NOT NULL,
  event_id VARCHAR(100) NOT NULL,
  kickoff_at TIMESTAMP,
  home_team TEXT,
  away_team TEXT,
  tournament_name TEXT,
  market_family VARCHAR(30) NOT NULL,
  market TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  predicted_probability NUMERIC(7, 4) NOT NULL,
  calibrated_probability NUMERIC(7, 4),
  decimal_odds NUMERIC(10, 4),
  fair_implied_probability NUMERIC(7, 4),
  expected_value NUMERIC(10, 4),
  probability_edge NUMERIC(10, 4),
  data_quality NUMERIC(7, 2),
  market_evidence NUMERIC(7, 2),
  championship_tier SMALLINT,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  home_score INTEGER,
  away_score INTEGER,
  settled_at TIMESTAMP,
  closing_odds NUMERIC(10, 4),
  closing_line_value NUMERIC(10, 4),
  payload JSONB,
  published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (publication_date, match_mode, provider, cache_version, event_id, market, recommendation)
);

CREATE INDEX IF NOT EXISTS analysis_predictions_pending_idx
  ON analysis_predictions (status, kickoff_at);

CREATE INDEX IF NOT EXISTS analysis_predictions_calibration_idx
  ON analysis_predictions (market_family, status, published_at);
