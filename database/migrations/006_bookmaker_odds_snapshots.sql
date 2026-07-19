CREATE TABLE IF NOT EXISTS bookmaker_odds_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_key VARCHAR(64) NOT NULL UNIQUE,
  publication_date DATE NOT NULL,
  event_id VARCHAR(100) NOT NULL,
  provider VARCHAR(60) NOT NULL,
  bookmaker VARCHAR(100),
  canonical_market VARCHAR(120) NOT NULL,
  original_market TEXT,
  original_choice TEXT,
  line NUMERIC(10, 3),
  decimal_odd NUMERIC(12, 4) NOT NULL,
  captured_at TIMESTAMP NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS bookmaker_odds_event_lookup_idx
  ON bookmaker_odds_snapshots (event_id, canonical_market, captured_at DESC);

CREATE INDEX IF NOT EXISTS bookmaker_odds_provider_lookup_idx
  ON bookmaker_odds_snapshots (provider, bookmaker, captured_at DESC);
