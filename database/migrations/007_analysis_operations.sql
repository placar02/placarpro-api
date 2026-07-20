CREATE TABLE IF NOT EXISTS analysis_operational_alerts (
  id BIGSERIAL PRIMARY KEY,
  fingerprint VARCHAR(120) UNIQUE NOT NULL,
  severity VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  details JSONB,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS analysis_operational_alerts_status_idx
  ON analysis_operational_alerts (status, severity, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS analysis_weight_recommendations (
  id BIGSERIAL PRIMARY KEY,
  market_family VARCHAR(30) NOT NULL,
  status VARCHAR(30) NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  evidence_multiplier NUMERIC(7, 4),
  rationale TEXT,
  safeguards JSONB,
  generated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (market_family)
);
